/**
 * Unified per-entry playback cache. One on-disk directory per `(trackId, sourceMtime)` and one `.bin`/`.idx` pair per `(format, quality)` inside it. Each in-memory entry composes `spawnEncoder` (writes the `.bin`) with `startLiveTail` (writes the `.idx` and broadcasts updates).
 *
 * Lifecycle:
 *   1. `getOrStart(req)` looks up `<entryDir>/<targetKey>.idx`. If present and `done: true`, the entry is reloaded into memory (warm hit, no encode).
 *   2. Otherwise stale partial output is wiped and a fresh encoder + live-tail pair is started.
 *   3. Concurrent callers for the same key share a single pending start.
 *   4. The LRU drops in-memory handles but keeps the on-disk `.bin`/`.idx` so the next access can warm-load. Dropping a handle whose encode is still running kills ffmpeg; that truncated output is reported as `aborted` and is never finalised as `done`, so the next access transparently re-encodes it.
 *
 * Because in-memory eviction leaves files behind, the on-disk footprint is bounded separately by `sweep`: when `maxBytes` is set, completed entries are deleted least-recently-accessed-first. Recency and size live in the `PlaybackCacheAccess` table — `lastAccess` is bumped (throttled) on every `getOrStart`, so a streamed track keeps itself warm, and an entry with no row yet sorts oldest. The sweep picks the oldest evictable entry one row at a time rather than loading the table; an entry is evictable only if it is neither mid-encode nor accessed within the grace window (`sweepGraceSeconds`) — recency, not in-memory LRU membership, is what protects an entry a playback session still depends on after its handle has churned out of the LRU. See `sweep.ts` for the surrounding lifecycle.
 *
 * The factory shape (`createCache`) exists so tests can run against a fresh root without trampling each other's state; the module also exports a `defaultCache` rooted at the disk cache's `transcode/` directory for the production wiring.
 */

import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { and, asc, eq, lt, notInArray, sum } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';

import { DEFAULT_CHUNK_DURATION_SECONDS } from '../config.js';
import { db } from '../db/client.js';
import { playbackCacheAccess } from '../db/schema/index.js';
import { transcodeDir } from '../disk-cache.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { type EncodeTarget, type FfmpegHandle, spawnEncoder, targetKey } from './encoder.js';
import { type IndexFile, type LiveTailHandle, startLiveTail } from './live-tail.js';
import { isPassthrough } from './resolve.js';

const tracer = trace.getTracer('lofify.playback.cache');
import { makeMp3Scanner } from './scan-mp3.js';
import { mp4Scanner } from './scan-mp4.js';
import type { Scanner } from './scan-types.js';
import { webmScanner } from './scan-webm.js';
import { isDiskFullError } from './sweep.js';

export type CacheRequest = {
  trackId: string;
  sourceMtime: Date;
  sourcePath: string;
  /** Abbreviated on-disk codec of the source file, e.g. `'flac'`, `'mp3'`, `'vorbis'`, `'opus'` (i.e. `Track.sourceFormat`). Used to decide whether `-c:a copy` is safe (source codec == target codec). */
  sourceCodec: string;
  target: EncodeTarget;
};

export type CacheEntry = {
  /** Live in-memory snapshot of the entry's `.idx`. Mutates in place as the encoder produces new chunks; consumers should re-read after each `'update'` event. */
  readonly index: IndexFile;
  /** Absolute path to the entry's `.bin`. Route handlers slice byte ranges from this. */
  readonly binPath: string;
  /** Fires `'update'` (IndexFile snapshot) after each idx change, `'error'` (unknown) on encoder failure. */
  readonly emitter: EventEmitter;
  /** Resolves once the index covers at least `endSeconds` of encoded duration, the encoder is done, or the encode has failed (rejects in that case). */
  waitForEncoded(endSeconds: number): Promise<void>;
  /** True iff the encoder ran to completion and the trailing chunk has been flushed. */
  isDone(): boolean;
  /** Returns the ffmpeg failure if the encode errored, else null. */
  error(): Error | null;
};

export type CacheOpts = {
  /** Root directory under which entry sub-dirs are created. */
  cacheRoot: string;
  /** Nominal chunk duration. Passed to both the encoder (`-frag_duration` for fmp4) and the scanner factory. */
  chunkDurationSeconds?: number;
  /** Max in-memory entries before LRU eviction. */
  lruMax?: number;
  /** TTL for in-memory entries since last access. */
  lruTtlSeconds?: number;
  /** Soft byte budget for the on-disk cache. When set, `sweep` evicts completed entries least-recently-accessed-first once usage exceeds it. Unset leaves the cache unbounded (sweeping is a no-op). */
  maxBytes?: number;
  /** Grace window (seconds) during which a recently-accessed entry is never evicted, even over budget. Defaults to 300. Must exceed the 60s access-write throttle. */
  sweepGraceSeconds?: number;
};

export type Cache = {
  getOrStart(req: CacheRequest): Promise<CacheEntry>;
  /** Evict completed on-disk entries least-recently-accessed-first until usage falls below the budget (no-op when `maxBytes` is unset). `targetBytes` overrides the default stop point (`maxBytes`) — emergency sweeps pass a lower value for headroom. */
  sweep(targetBytes?: number): Promise<{ freedBytes: number; evicted: string[] }>;
  /** Discard every cached target for `trackId`: drop the in-memory handles (the LRU's dispose kills any in-progress encode and stops its live-tail), remove the on-disk entry dirs across all source-mtime generations, and delete their access rows — so the next `getOrStart` re-encodes from source. For recovering from a bad encode whose bytes are cached but unplayable. Best-effort: a per-dir filesystem or DB failure is logged, not thrown. Idempotent. */
  invalidateTrack(trackId: string): Promise<void>;
  /** Drop all in-memory handles. On-disk cache files are left intact. Intended for tests; production callers should not need this. */
  reset(): void;
};

type InternalEntry = {
  binPath: string;
  idxPath: string;
  liveTail: LiveTailHandle;
  ffmpeg: FfmpegHandle;
  /** Captured ffmpeg failure, if any. */
  error: Error | null;
};

function scannerFor(target: EncodeTarget, chunkDurationSeconds: number): Scanner {
  switch (target.format.container) {
    case 'mp4':
      // fmp4 reads its own per-fragment timing from tfdt, so it needs no nominal hint.
      return mp4Scanner;
    case 'webm':
      // WebM clusters carry their own absolute Timecode, like fmp4 fragments.
      return webmScanner;
    case 'mp3':
      return makeMp3Scanner(chunkDurationSeconds);
  }
}

function entryDir(root: string, trackId: string, sourceMtime: Date): string {
  return path.join(root, `${trackId}-${sourceMtime.getTime()}`);
}

function entryKey(req: CacheRequest): string {
  return `${req.trackId}-${req.sourceMtime.getTime()}/${targetKey(req.target)}`;
}

export function createCache(opts: CacheOpts): Cache {
  const cacheRoot = opts.cacheRoot;
  const chunkDurationSeconds = opts.chunkDurationSeconds ?? DEFAULT_CHUNK_DURATION_SECONDS;
  const lruMax = opts.lruMax ?? 64;
  const lruTtl = (opts.lruTtlSeconds ?? 3600) * 1000;

  const maxBytes = opts.maxBytes;

  const lru = new LRUCache<string, InternalEntry>({
    max: lruMax,
    ttl: lruTtl,
    updateAgeOnGet: true,
    dispose: (entry) => {
      entry.ffmpeg.kill();
      void entry.liveTail.stop();
    },
  });

  const inFlightStart = new Map<string, Promise<InternalEntry>>();
  // Keys whose encoder is still running. `inFlightStart` only covers the brief start (it clears once
  // the handle exists, long before the encode finishes) and the LRU handle can churn out mid-encode,
  // so this is what guarantees an in-progress encode's dir is never swept.
  const encodingKeys = new Set<string>();

  // Recency/size of each on-disk entry live in Postgres (`PlaybackCacheAccess`); `sweep` reads that
  // table to decide evictions. Access bumps fire on every request, so we throttle the per-entry
  // `lastAccess` write to avoid an UPDATE per range request on a hot track.
  const lastWrittenAt = new Map<string, number>();
  const ACCESS_WRITE_THROTTLE_MS = 60_000;
  // After an emergency sweep, leave 10% headroom so a single freed slot isn't instantly refilled.
  const EMERGENCY_TARGET_FRACTION = 0.9;
  // Never evict an entry accessed within this window. A playback session is many independent range
  // requests against the on-disk `.bin`, and the entry's in-memory handle (and thus `protectedDirs`
  // protection) churns out of the small LRU long before the session ends — so recency, not LRU
  // membership, is what keeps a still-streaming entry from being deleted out from under the client.
  // Must exceed ACCESS_WRITE_THROTTLE_MS so a recently-served entry can't look stale.
  const SWEEP_GRACE_MS = (opts.sweepGraceSeconds ?? 300) * 1000;

  function dirOf(key: string): string {
    return key.slice(0, key.lastIndexOf('/'));
  }

  /** Upsert the access row for an entry dir. `sizeBytes` is written only when supplied (a plain access bump must not zero a recorded size). Failures are logged, never thrown — recency tracking must not break playback. */
  async function upsertAccess(dirName: string, sizeBytes?: number): Promise<void> {
    const lastAccess = new Date();
    try {
      await db
        .insert(playbackCacheAccess)
        .values({ entryDir: dirName, lastAccess, sizeBytes: sizeBytes ?? 0 })
        .onConflictDoUpdate({
          target: playbackCacheAccess.entryDir,
          set: { lastAccess, ...(sizeBytes !== undefined ? { sizeBytes } : {}) },
        });
    } catch (err) {
      logger.warn(
        `playback cache: failed to record access for ${dirName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Record an access against an entry's dir. The first touch for a dir always writes (creating the row immediately); subsequent touches are throttled. */
  function bumpAccess(key: string): void {
    if (maxBytes == null) return;
    const dir = dirOf(key);
    const now = Date.now();
    if (now - (lastWrittenAt.get(dir) ?? 0) < ACCESS_WRITE_THROTTLE_MS) return;
    lastWrittenAt.set(dir, now);
    void upsertAccess(dir);
  }

  /** Persist the completed entry's on-disk size so the sweep can weigh it against the budget. */
  async function recordEntrySize(dirName: string): Promise<void> {
    if (maxBytes == null) return;
    const full = path.join(cacheRoot, dirName);
    let bytes = 0;
    try {
      for (const name of await readdir(full)) {
        try {
          bytes += (await stat(path.join(full, name))).size;
        } catch {
          // File vanished between readdir and stat; skip it.
        }
      }
    } catch {
      // Dir gone (evicted already); nothing to record.
      return;
    }
    lastWrittenAt.set(dirName, Date.now());
    await upsertAccess(dirName, bytes);
  }

  /** Reclaim a failed encode's partial output. The chunks flushed before the failure are never servable or resumable, and would otherwise stay unaccounted (the size row never moves off its initial 0), so the byte budget couldn't see or reclaim them. Removes this target's files, leaving any sibling targets in the dir; if the dir is left empty, drops the dir and its access row, otherwise re-sums so the recorded size no longer counts the removed partial. */
  async function cleanupFailedTarget(
    dirName: string,
    binPath: string,
    idxPath: string,
  ): Promise<void> {
    await rm(binPath, { force: true }).catch(() => undefined);
    await rm(idxPath, { force: true }).catch(() => undefined);
    if (maxBytes == null) return;
    let remaining: string[];
    try {
      remaining = await readdir(path.join(cacheRoot, dirName));
    } catch {
      remaining = [];
    }
    if (remaining.length > 0) {
      await recordEntrySize(dirName);
      return;
    }
    await rm(path.join(cacheRoot, dirName), { recursive: true, force: true }).catch(
      () => undefined,
    );
    lastWrittenAt.delete(dirName);
    try {
      await db.delete(playbackCacheAccess).where(eq(playbackCacheAccess.entryDir, dirName));
    } catch (err) {
      logger.warn(
        `playback cache: failed to drop access row for ${dirName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  function protectedDirs(): Set<string> {
    const dirs = new Set<string>();
    for (const key of lru.keys()) dirs.add(dirOf(key));
    for (const key of inFlightStart.keys()) dirs.add(dirOf(key));
    for (const key of encodingKeys) dirs.add(dirOf(key));
    return dirs;
  }

  async function totalCachedBytes(): Promise<number> {
    const [row] = await db
      .select({ total: sum(playbackCacheAccess.sizeBytes) })
      .from(playbackCacheAccess);
    return Number(row?.total ?? 0);
  }

  // Post-transcode, cron, and ENOSPC can all trigger a sweep at once; serialise them so concurrent
  // runs don't each read the total and over-evict.
  let sweepChain: Promise<unknown> = Promise.resolve();
  function sweep(targetBytes?: number): Promise<{ freedBytes: number; evicted: string[] }> {
    const run = sweepChain.then(() => runSweep(targetBytes));
    sweepChain = run.catch(() => undefined);
    return run;
  }

  async function runSweep(
    targetBytes?: number,
  ): Promise<{ freedBytes: number; evicted: string[] }> {
    if (maxBytes == null) return { freedBytes: 0, evicted: [] };
    const target = targetBytes ?? maxBytes;

    let total = await totalCachedBytes();
    if (total <= maxBytes) return { freedBytes: 0, evicted: [] };

    // Evict the oldest evictable entry one at a time until under target. Recency and size live in
    // Postgres, so we never load the whole table: each step is an indexed `ORDER BY lastAccess
    // LIMIT 1` pick. An entry is evictable only if it is not currently in memory/mid-encode AND has
    // been idle past the grace window — the latter is what protects a streaming entry whose handle
    // has churned out of the LRU. `total` is decremented locally to avoid re-summing each iteration.
    const cutoff = new Date(Date.now() - SWEEP_GRACE_MS);
    const evicted: string[] = [];
    let freedBytes = 0;
    while (total > target) {
      const protectedArr = [...protectedDirs()];
      const [oldest] = await db
        .select({
          entryDir: playbackCacheAccess.entryDir,
          sizeBytes: playbackCacheAccess.sizeBytes,
        })
        .from(playbackCacheAccess)
        .where(
          and(
            lt(playbackCacheAccess.lastAccess, cutoff),
            protectedArr.length > 0
              ? notInArray(playbackCacheAccess.entryDir, protectedArr)
              : undefined,
          ),
        )
        .orderBy(asc(playbackCacheAccess.lastAccess))
        .limit(1);
      if (!oldest) break; // nothing evictable: all remaining are protected or within the grace window
      try {
        await rm(path.join(cacheRoot, oldest.entryDir), { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `playback cache: failed to evict ${oldest.entryDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await db.delete(playbackCacheAccess).where(eq(playbackCacheAccess.entryDir, oldest.entryDir));
      lastWrittenAt.delete(oldest.entryDir);
      total -= oldest.sizeBytes;
      freedBytes += oldest.sizeBytes;
      evicted.push(oldest.entryDir);
    }
    return { freedBytes, evicted };
  }

  function emergencySweep(): void {
    if (maxBytes == null) return;
    sweep(Math.floor(maxBytes * EMERGENCY_TARGET_FRACTION)).catch((err: unknown) => {
      logger.error(
        `playback cache: emergency sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  async function loadWarm(binPath: string, idxPath: string): Promise<InternalEntry | null> {
    let idx: IndexFile;
    try {
      const raw = await readFile(idxPath, 'utf8');
      idx = JSON.parse(raw) as IndexFile;
    } catch {
      return null;
    }
    if (!idx.done) return null;
    try {
      await stat(binPath);
    } catch {
      return null;
    }
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    const synthLiveTail: LiveTailHandle = {
      get index() {
        return idx;
      },
      emitter,
      stop: () => Promise.resolve(),
      finalise: () => Promise.resolve(),
    };
    return {
      binPath,
      idxPath,
      liveTail: synthLiveTail,
      ffmpeg: { done: Promise.resolve(), aborted: false, kill: () => undefined },
      error: null,
    };
  }

  async function startFresh(req: CacheRequest): Promise<InternalEntry> {
    const dir = entryDir(cacheRoot, req.trackId, req.sourceMtime);
    await mkdir(dir, { recursive: true });
    const tk = targetKey(req.target);
    const binPath = path.join(dir, `${tk}.bin`);
    const idxPath = path.join(dir, `${tk}.idx`);
    // Wipe any stale partial output from a crashed previous run.
    await rm(binPath, { force: true });
    await rm(idxPath, { force: true });

    const ffmpeg = spawnEncoder({
      source: req.sourcePath,
      target: req.target,
      outPath: binPath,
      chunkDurationSeconds,
      passthrough: isPassthrough(req.target, req.sourceCodec),
    });
    const liveTail = startLiveTail({
      scanner: scannerFor(req.target, chunkDurationSeconds),
      binPath,
      idxPath,
      chunkDurationSeconds,
    });
    const internal: InternalEntry = { binPath, idxPath, liveTail, ffmpeg, error: null };
    const key = entryKey(req);
    encodingKeys.add(key);

    // A full disk can surface either as an ffmpeg failure or as a live-tail index-write failure.
    // Either way, free space so the next request has room — the current request still fails. This
    // backstop should almost never fire when a sensible budget is configured.
    liveTail.emitter.on('error', (err: unknown) => {
      if (isDiskFullError(err)) emergencySweep();
    });

    ffmpeg.done.then(
      () => {
        encodingKeys.delete(key);
        if (ffmpeg.aborted) {
          // The in-memory LRU evicted and killed this encode mid-flight (kill() resolves `done`).
          // The output is truncated, so it must NOT be finalised as `done: true` — leaving the `.idx`
          // un-finalised means a later request re-encodes (loadWarm rejects done:false) and the next
          // startFresh wipes the partial. Surface an abort so any current waiter retries rather than
          // hanging. We deliberately don't delete files or the LRU slot here: a re-encode may already
          // have raced in on the same key, and clobbering its output/handle would be worse.
          const abortErr = new Error('encode aborted: entry evicted from cache mid-encode');
          internal.error = abortErr;
          liveTail.emitter.emit('error', abortErr);
          return;
        }
        liveTail
          .finalise()
          .then(async () => {
            // Record the finished entry's size, then keep the cache under budget.
            await recordEntrySize(path.basename(dir));
            await sweep();
          })
          .catch((err: unknown) => {
            logger.error('live-tail finalise failed', {
              key: entryKey(req),
              err: err instanceof Error ? err.message : String(err),
            });
          });
      },
      (err: Error) => {
        encodingKeys.delete(key);
        internal.error = err;
        liveTail.emitter.emit('error', err);
        logger.error('encoder failed', { key: entryKey(req), err: err.message });
        void (async () => {
          await liveTail.stop();
          await cleanupFailedTarget(path.basename(dir), binPath, idxPath);
          if (isDiskFullError(err) && maxBytes != null) {
            // ENOSPC is transient once the sweep frees space: drop the cached failure so the next
            // request retries a fresh encode rather than replaying this error until the LRU TTL.
            // Other failures stay cached so a genuinely broken source isn't re-spawned per request.
            lru.delete(entryKey(req));
            emergencySweep();
          }
        })();
      },
    );

    return internal;
  }

  function wrap(internal: InternalEntry): CacheEntry {
    return {
      get index() {
        return internal.liveTail.index;
      },
      binPath: internal.binPath,
      emitter: internal.liveTail.emitter,
      waitForEncoded(endSeconds: number): Promise<void> {
        if (internal.error) return Promise.reject(internal.error);
        const idx = internal.liveTail.index;
        if (idx.durationSeconds >= endSeconds || idx.done) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const cleanup = (): void => {
            internal.liveTail.emitter.off('update', onUpdate);
            internal.liveTail.emitter.off('error', onError);
          };
          const onUpdate = (snap: IndexFile): void => {
            if (snap.durationSeconds >= endSeconds || snap.done) {
              cleanup();
              resolve();
            }
          };
          const onError = (err: unknown): void => {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          };
          internal.liveTail.emitter.on('update', onUpdate);
          internal.liveTail.emitter.on('error', onError);
        });
      },
      isDone(): boolean {
        return internal.liveTail.index.done;
      },
      error(): Error | null {
        return internal.error;
      },
    };
  }

  async function getOrStart(req: CacheRequest): Promise<CacheEntry> {
    return tracer.startActiveSpan(
      'playback.cache.getOrStart',
      {
        attributes: {
          'playback.track.id': req.trackId,
          'playback.target.container': req.target.format.container,
          'playback.target.codec': req.target.format.codec,
          'playback.target.quality': req.target.quality,
        },
      },
      async (span): Promise<CacheEntry> => {
        try {
          const key = entryKey(req);
          bumpAccess(key);
          const cached = lru.get(key);
          if (cached) {
            span.setAttribute('playback.cache.outcome', 'hit-inmem');
            return wrap(cached);
          }
          const pending = inFlightStart.get(key);
          if (pending) {
            span.setAttribute('playback.cache.outcome', 'hit-inflight');
            return wrap(await pending);
          }

          const start = (async () => {
            const dir = entryDir(cacheRoot, req.trackId, req.sourceMtime);
            const tk = targetKey(req.target);
            const binPath = path.join(dir, `${tk}.bin`);
            const idxPath = path.join(dir, `${tk}.idx`);
            const warm = await loadWarm(binPath, idxPath);
            if (warm) {
              span.setAttribute('playback.cache.outcome', 'hit-warm');
              lru.set(key, warm);
              return warm;
            }
            span.setAttribute('playback.cache.outcome', 'miss');
            const fresh = await startFresh(req);
            lru.set(key, fresh);
            return fresh;
          })().finally(() => inFlightStart.delete(key));

          inFlightStart.set(key, start);
          return wrap(await start);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async function invalidateTrack(trackId: string): Promise<void> {
    const prefix = `${trackId}-`;
    // Drop the in-memory handles first: the LRU's dispose kills ffmpeg and stops the live-tail, so a
    // still-encoding target isn't writing its files while we remove them below.
    for (const key of [...lru.keys()]) {
      if (key.startsWith(prefix)) lru.delete(key);
    }
    let names: string[];
    try {
      names = await readdir(cacheRoot);
    } catch {
      return;
    }
    for (const name of names) {
      // Entry dirs are `<trackId>-<sourceMtimeMs>` — match every generation of this track without
      // catching a different track that merely shares an id prefix (the suffix must be all digits).
      if (!name.startsWith(prefix) || !/^\d+$/.test(name.slice(prefix.length))) continue;
      try {
        await rm(path.join(cacheRoot, name), { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `playback cache: failed to invalidate ${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      lastWrittenAt.delete(name);
      try {
        await db.delete(playbackCacheAccess).where(eq(playbackCacheAccess.entryDir, name));
      } catch (err) {
        logger.warn(
          `playback cache: failed to drop access row for ${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  return {
    getOrStart,
    sweep,
    invalidateTrack,
    reset(): void {
      lru.clear();
      inFlightStart.clear();
    },
  };
}

/** Production singleton wired from env. Tests should build their own via `createCache`. */
export const defaultCache: Cache = createCache({
  cacheRoot: transcodeDir(),
  ...(env.DISK_CACHE_MAX_BYTES !== undefined ? { maxBytes: env.DISK_CACHE_MAX_BYTES } : {}),
  sweepGraceSeconds: env.DISK_CACHE_SWEEP_GRACE_SECONDS,
});
