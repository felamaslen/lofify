import { SpanStatusCode, trace } from '@opentelemetry/api';
import { eq } from 'drizzle-orm';
import fg from 'fast-glob';
import { Writable } from 'node:stream';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { AUDIO_EXTENSIONS } from './audio-extensions.js';
import { parseTrack } from './parse.js';
import {
  completeScan,
  createScan,
  notifyScanUpdate,
  recordScanError,
  type ScanState,
} from './runner.js';

/** Parse `file` and write the result to `Tracks`, replacing the existing row keyed by absolute path. */
export async function upsertTrack(file: string): Promise<void> {
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

/** Build an object-mode Writable that runs `task` over each chunk with at most `concurrency` in-flight calls. Backpressure: `_write`'s callback is held until a slot is free, so the upstream stream pauses naturally. */
function createUpsertSink(task: (file: string) => Promise<void>, concurrency: number): Writable {
  let inFlight = 0;
  let waiting: (() => void) | null = null;

  const release = () => {
    inFlight -= 1;
    const w = waiting;
    waiting = null;
    w?.();
  };

  return new Writable({
    objectMode: true,
    highWaterMark: concurrency,
    write(chunk: string | Buffer, _enc, cb) {
      const file = typeof chunk === 'string' ? chunk : chunk.toString();
      inFlight += 1;
      void task(file).finally(release);
      if (inFlight < concurrency) {
        cb();
      } else {
        waiting = cb;
      }
    },
    final(cb) {
      if (inFlight === 0) return cb();
      const check = () => {
        if (inFlight === 0) cb();
        else setTimeout(check, 10).unref();
      };
      check();
    },
  });
}

/** Kick off a full library scan rooted at `root`. Returns the initial scan state synchronously with `filesTotal: null`. Discovery (fast-glob streaming) and parsing/upserts run concurrently in the background: each file is upserted as soon as the walker yields it, `filesTotal` is populated when the walker finishes, and subscribers are notified on each milestone. */
export function scanLibrary(root: string): ScanState {
  const state = createScan();
  const span = tracer.startSpan('scanner.scanLibrary', {
    attributes: { 'scanner.id': state.id, 'scanner.root': root },
  });

  const upsertScannedTrack = async (file: string) => {
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

  void (async () => {
    const pattern = `**/*.{${AUDIO_EXTENSIONS.join(',')}}`;
    const discovery = fg.stream(pattern, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      caseSensitiveMatch: false,
      suppressErrors: true,
    });

    const sink = createUpsertSink(upsertScannedTrack, env.SCAN_CONCURRENCY);

    let discovered = 0;
    discovery.on('data', () => {
      discovered += 1;
    });

    try {
      await new Promise<void>((resolve, reject) => {
        discovery.once('end', () => {
          state.filesTotal = discovered;
          span.setAttribute('scanner.filesTotal', discovered);
          notifyScanUpdate(state.id);
        });
        discovery.once('error', reject);
        sink.once('finish', () => resolve());
        sink.once('error', reject);
        discovery.pipe(sink);
      });
      span.setAttribute('scanner.scannedTotal', state.scannedTotal);
      span.setAttribute('scanner.errorsTotal', state.errorsTotal);
    } catch (err) {
      logger.error(
        `scanner: scanLibrary failed for ${root}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      recordScanError(state.id, root, err);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      completeScan(state.id);
      span.end();
    }
  })();

  return state;
}
