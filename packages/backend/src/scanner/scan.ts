import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { eq, inArray } from 'drizzle-orm';
import fg, { type Entry } from 'fast-glob';

import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import {
  dedupKeyOf,
  deleteTrackAndRecompute,
  lockKeysInTx,
  recomputeKeysInTx,
} from '../dedup/recompute.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { AUDIO_EXTENSIONS } from './audio-extensions.js';
import { clearFileError, erroredFilesIn, recordFileError } from './error-store.js';
import { parseTrack } from './parse.js';
import { AsyncPriorityQueue } from './priority-queue.js';
import {
  completeScan,
  createScan,
  notifyScanUpdate,
  recordScanError,
  type ScanState,
} from './runner.js';

/** Parse `file` and write the result to `Tracks`, replacing the existing row keyed by absolute path. Zero-byte files (placeholders, interrupted copies) are skipped silently rather than treated as parse failures. */
export async function upsertTrack(file: string): Promise<void> {
  if ((await stat(file)).size === 0) {
    logger.warn(`scanner: skipping empty file ${file}`);
    return;
  }
  const parsed = await parseTrack(file);
  const now = new Date();
  const keyCols = {
    title: tracks.title,
    titleOverride: tracks.titleOverride,
    artist: tracks.artist,
    artistOverride: tracks.artistOverride,
    album: tracks.album,
    albumOverride: tracks.albumOverride,
  };
  await db.transaction(async (tx) => {
    const [prior] = await tx.select(keyCols).from(tracks).where(eq(tracks.file, file)).limit(1);
    const oldKey = prior ? dedupKeyOf(prior) : null;
    // The upsert writes only the base tags (parseTrack never sets the *Override
    // columns), so the post-write effective key combines the freshly parsed tags
    // with whatever overrides the row already carries.
    const newKey = dedupKeyOf({
      title: parsed.title ?? null,
      titleOverride: prior?.titleOverride ?? null,
      artist: parsed.artist ?? null,
      artistOverride: prior?.artistOverride ?? null,
      album: parsed.album ?? null,
      albumOverride: prior?.albumOverride ?? null,
    });
    const keys = [oldKey, newKey];
    // Lock the affected groups before writing the row. The insert takes a row
    // lock and the recompute below locks group members; acquiring the advisory
    // lock first makes every worker order advisory-then-row, so two workers
    // upserting different files of the same duplicate group serialise rather
    // than deadlock.
    await lockKeysInTx(tx, keys);
    await tx
      .insert(tracks)
      .values({ ...parsed, scannedAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: tracks.file,
        set: { ...parsed, scannedAt: now, updatedAt: now },
      });
    await recomputeKeysInTx(tx, keys);
  });
}

/** Parse and upsert `file`, maintaining its `ScanErrors` row as a side effect: a clean parse clears any prior error, a failure records (or refreshes) one. The error row is written regardless; the original error is re-thrown so callers can still log and update their own metrics. This is the single funnel for scan workers, the watcher, and manual retries, so the persisted-error invariant holds no matter which triggered the read. */
export async function upsertTrackTracked(file: string): Promise<void> {
  try {
    await upsertTrack(file);
    await clearFileError(file);
  } catch (err) {
    await recordFileError(file, err);
    throw err;
  }
}

/** Remove the `Tracks` row matching the given absolute path, if any, re-rank its former duplicate group, and drop any error row for the file. */
export async function deleteTrackByFile(file: string): Promise<void> {
  await deleteTrackAndRecompute(file);
  await clearFileError(file);
}

const tracer = trace.getTracer('lofify.scanner');

/** Priority for files not yet in the library — parsed first so new music appears quickly. */
const PRIORITY_NEW = 1;
/** Priority for known files whose content changed since the last scan. */
const PRIORITY_CHANGED = 0;

/** Number of discovered files classified per DB lookup. Bounds the `WHERE file IN (...)` size and the producer's working memory rather than preloading the whole library. */
const CLASSIFY_BATCH_SIZE = 100;

/** Kick off a full library scan across `roots`. Returns the initial scan state synchronously with `filesTotal: null`. Discovery (fast-glob streaming), classification and parsing/upserts run concurrently in the background. Each discovered file is classified in batches against `Tracks`: brand-new files are queued at high priority, files whose mtime changed at low priority, and unchanged files are skipped entirely. Pass `force` to re-parse every known file regardless of mtime — used to backfill columns added since the rows were last written. `filesTotal` is populated when the walk finishes; subscribers are notified on each milestone. */
export function scanLibrary(roots: string[], opts: { force?: boolean } = {}): ScanState {
  const force = opts.force ?? false;
  const state = createScan();
  const span = tracer.startSpan('scanner.scanLibrary', {
    attributes: { 'scanner.id': state.id, 'scanner.roots': roots.join(',') },
  });

  const queue = new AsyncPriorityQueue<string>();

  const upsertScannedTrack = async (file: string) => {
    if (state.abort.signal.aborted) return;
    try {
      await upsertTrackTracked(file);
      state.scannedTotal += 1;
    } catch (err) {
      logger.error(
        `scanner: failed to upsert ${file}: ${err instanceof Error ? err.message : String(err)}`,
        { stack: (err as Error)?.stack },
      );
      recordScanError(state.id, file, err);
      span.recordException(err as Error);
    }
  };

  /** Classify a batch of discovered entries against the DB in one query, queueing those that need work. Files with a recorded error are skipped until retried by hand, unless `force` is set. Skipped files (unchanged or errored) count towards `scannedTotal` so progress still reaches `filesTotal`. */
  const classifyBatch = async (batch: Entry[]) => {
    if (state.abort.signal.aborted || batch.length === 0) return;
    const paths = batch.map((e) => e.path);
    const rows = await db
      .select({ file: tracks.file, sourceMtime: tracks.sourceMtime })
      .from(tracks)
      .where(inArray(tracks.file, paths));
    const known = new Map(rows.map((r) => [r.file, r.sourceMtime.getTime()]));
    const errored = force ? new Set<string>() : await erroredFilesIn(paths);

    for (const entry of batch) {
      if (errored.has(entry.path)) {
        state.scannedTotal += 1;
        continue;
      }
      const knownMs = known.get(entry.path);
      if (knownMs === undefined) {
        queue.push(entry.path, PRIORITY_NEW);
      } else if (force || Math.floor(entry.stats!.mtimeMs) !== knownMs) {
        queue.push(entry.path, PRIORITY_CHANGED);
      } else {
        state.scannedTotal += 1;
      }
    }
  };

  void (async () => {
    const pattern = `**/*.{${AUDIO_EXTENSIONS.join(',')}}`;
    const streams = roots.map(
      (root) =>
        fg.stream(pattern, {
          cwd: root,
          absolute: true,
          onlyFiles: true,
          caseSensitiveMatch: false,
          suppressErrors: true,
          stats: true,
          objectMode: true,
        }) as Readable,
    );

    const onAbort = () => {
      for (const stream of streams) stream.destroy();
      queue.close();
    };
    if (state.abort.signal.aborted) onAbort();
    else state.abort.signal.addEventListener('abort', onAbort, { once: true });

    const workers = Array.from({ length: env.SCAN_CONCURRENCY }, async () => {
      for (;;) {
        const file = await queue.pop();
        if (file == null) break;
        await upsertScannedTrack(file);
      }
    });

    const produce = async () => {
      let discovered = 0;
      let batch: Entry[] = [];
      for (const stream of streams) {
        for await (const entry of stream as AsyncIterable<Entry>) {
          if (state.abort.signal.aborted) return;
          discovered += 1;
          batch.push(entry);
          if (batch.length >= CLASSIFY_BATCH_SIZE) {
            await classifyBatch(batch);
            batch = [];
          }
        }
      }
      await classifyBatch(batch);
      state.filesTotal = discovered;
      span.setAttribute('scanner.filesTotal', discovered);
      notifyScanUpdate(state.id);
    };

    try {
      await produce();
      queue.close();
      await Promise.all(workers);
      span.setAttribute('scanner.scannedTotal', state.scannedTotal);
      span.setAttribute('scanner.errorsTotal', state.errorsTotal);
    } catch (err) {
      logger.error(
        `scanner: scanLibrary failed for ${roots.join(',')}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      recordScanError(state.id, roots.join(','), err);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      queue.close();
      await Promise.all(workers);
    } finally {
      completeScan(state.id);
      span.end();
    }
  })();

  return state;
}
