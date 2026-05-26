import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { eq, inArray } from 'drizzle-orm';
import fg, { type Entry } from 'fast-glob';

import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { AUDIO_EXTENSIONS } from './audio-extensions.js';
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
  await db
    .insert(tracks)
    .values({ ...parsed, scannedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: tracks.file,
      set: { ...parsed, scannedAt: now, updatedAt: now },
    });
}

/** Remove the `Tracks` row matching the given absolute path, if any. */
export async function deleteTrackByFile(file: string): Promise<void> {
  await db.delete(tracks).where(eq(tracks.file, file));
}

const tracer = trace.getTracer('lofify.scanner');

/** Priority for files not yet in the library — parsed first so new music appears quickly. */
const PRIORITY_NEW = 1;
/** Priority for known files whose content changed since the last scan. */
const PRIORITY_CHANGED = 0;

/** Number of discovered files classified per DB lookup. Bounds the `WHERE file IN (...)` size and the producer's working memory rather than preloading the whole library. */
const CLASSIFY_BATCH_SIZE = 100;

/** Kick off a full library scan across `roots`. Returns the initial scan state synchronously with `filesTotal: null`. Discovery (fast-glob streaming), classification and parsing/upserts run concurrently in the background. Each discovered file is classified in batches against `Tracks`: brand-new files are queued at high priority, files whose mtime changed at low priority, and unchanged files are skipped entirely. `filesTotal` is populated when the walk finishes; subscribers are notified on each milestone. */
export function scanLibrary(roots: string[]): ScanState {
  const state = createScan();
  const span = tracer.startSpan('scanner.scanLibrary', {
    attributes: { 'scanner.id': state.id, 'scanner.roots': roots.join(',') },
  });

  const queue = new AsyncPriorityQueue<string>();

  const upsertScannedTrack = async (file: string) => {
    if (state.abort.signal.aborted) return;
    try {
      await upsertTrack(file);
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

  /** Classify a batch of discovered entries against the DB in one query, queueing those that need work. Unchanged files count towards `scannedTotal` (they are verified, just not re-parsed) so progress still reaches `filesTotal`. */
  const classifyBatch = async (batch: Entry[]) => {
    if (state.abort.signal.aborted || batch.length === 0) return;
    const paths = batch.map((e) => e.path);
    const rows = await db
      .select({ file: tracks.file, sourceMtime: tracks.sourceMtime })
      .from(tracks)
      .where(inArray(tracks.file, paths));
    const known = new Map(rows.map((r) => [r.file, r.sourceMtime.getTime()]));

    for (const entry of batch) {
      const knownMs = known.get(entry.path);
      if (knownMs === undefined) {
        queue.push(entry.path, PRIORITY_NEW);
      } else if (Math.floor(entry.stats!.mtimeMs) !== knownMs) {
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
