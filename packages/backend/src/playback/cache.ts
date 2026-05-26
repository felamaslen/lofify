/**
 * Unified per-entry playback cache. One on-disk directory per `(trackId, sourceMtime)` and one `.bin`/`.idx` pair per `(format, quality)` inside it. Each in-memory entry composes `spawnEncoder` (writes the `.bin`) with `startLiveTail` (writes the `.idx` and broadcasts updates).
 *
 * Lifecycle:
 *   1. `getOrStart(req)` looks up `<entryDir>/<targetKey>.idx`. If present and `done: true`, the entry is reloaded into memory (warm hit, no encode).
 *   2. Otherwise stale partial output is wiped and a fresh encoder + live-tail pair is started.
 *   3. Concurrent callers for the same key share a single pending start.
 *   4. The LRU drops in-memory handles but keeps the on-disk `.bin`/`.idx` so the next access can warm-load.
 *
 * The factory shape (`createCache`) exists so tests can run against a fresh root without trampling each other's state; the module also exports a `defaultCache` configured from `env.PLAYBACK_CACHE_DIR` for the production wiring.
 */

import { EventEmitter } from 'node:events';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { LRUCache } from 'lru-cache';

import { DEFAULT_CHUNK_DURATION_SECONDS } from '../config.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { type EncodeTarget, type FfmpegHandle, spawnEncoder, targetKey } from './encoder.js';
import { type IndexFile, type LiveTailHandle, startLiveTail } from './live-tail.js';

const tracer = trace.getTracer('lofify.playback.cache');
import { makeMp3Scanner } from './scan-mp3.js';
import { makeMp4Scanner } from './scan-mp4.js';
import type { Scanner } from './scan-types.js';

export type CacheRequest = {
  trackId: string;
  sourceMtime: Date;
  sourcePath: string;
  /** Lower-cased on-disk codec of the source file, e.g. `'flac'`, `'mp3'`. Used to decide whether `-c:a copy` is safe (source codec == target codec). */
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
};

export type Cache = {
  getOrStart(req: CacheRequest): Promise<CacheEntry>;
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
      return makeMp4Scanner(chunkDurationSeconds);
    case 'mp3':
      return makeMp3Scanner(chunkDurationSeconds);
  }
}

function isPassthrough(req: CacheRequest): boolean {
  return req.sourceCodec.toLowerCase() === req.target.format.codec;
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
      ffmpeg: { done: Promise.resolve(), kill: () => undefined },
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
      passthrough: isPassthrough(req),
    });
    const liveTail = startLiveTail({
      scanner: scannerFor(req.target, chunkDurationSeconds),
      binPath,
      idxPath,
      chunkDurationSeconds,
    });
    const internal: InternalEntry = { binPath, idxPath, liveTail, ffmpeg, error: null };

    ffmpeg.done.then(
      () => {
        liveTail.finalise().catch((err: unknown) => {
          logger.error('live-tail finalise failed', {
            key: entryKey(req),
            err: err instanceof Error ? err.message : String(err),
          });
        });
      },
      (err: Error) => {
        internal.error = err;
        liveTail.emitter.emit('error', err);
        void liveTail.stop();
        logger.error('encoder failed', { key: entryKey(req), err: err.message });
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

  return {
    getOrStart,
    reset(): void {
      lru.clear();
      inFlightStart.clear();
    },
  };
}

/** Production singleton wired from env. Tests should build their own via `createCache`. */
export const defaultCache: Cache = createCache({
  cacheRoot: env.PLAYBACK_CACHE_DIR ?? path.join(tmpdir(), 'lofify-cache'),
});
