import { SpanStatusCode, trace } from '@opentelemetry/api';
import { eq } from 'drizzle-orm';
import fg from 'fast-glob';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { parseTrack } from './parse.js';
import {
  completeScan,
  createScan,
  recordScanError,
  type ScanState,
} from './runner.js';

const AUDIO_EXTENSIONS = [
  'mp3',
  'flac',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'aac',
  'wav',
  'wma',
  'webm',
];

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

/** Kick off a full library scan rooted at `root`. Returns the initial scan state synchronously; the walk and upserts run in the background and mutate the returned state in place. */
export function scanLibrary(root: string): ScanState {
  const state = createScan();

  void tracer.startActiveSpan(
    'scanner.scanLibrary',
    { attributes: { 'scanner.id': state.id, 'scanner.root': root } },
    async (span) => {
      try {
        const pattern = `**/*.{${AUDIO_EXTENSIONS.join(',')}}`;
        const files = (await fg(pattern, {
          cwd: root,
          absolute: true,
          onlyFiles: true,
          caseSensitiveMatch: false,
          suppressErrors: true,
        })) as string[];
        state.filesTotal = files.length;
        span.setAttribute('scanner.filesTotal', state.filesTotal);

        for (const file of files) {
          try {
            await upsertTrack(file);
            state.scannedTotal += 1;
          } catch (err) {
            recordScanError(state.id, file, err);
            span.recordException(err as Error);
          }
        }

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
    },
  );

  return state;
}

