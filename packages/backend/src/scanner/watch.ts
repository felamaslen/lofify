import { type Span,SpanStatusCode, trace } from '@opentelemetry/api';
import chokidar, { type FSWatcher } from 'chokidar';

import { logger } from '../logger.js';
import { AUDIO_EXTENSION_RE } from './audio-extensions.js';
import { deleteTrackByFile, upsertTrack } from './scan.js';

const tracer = trace.getTracer('lofify.scanner');

function recordError(span: Span, err: unknown) {
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

function withSpan(name: string, file: string, work: (span: Span) => Promise<void>): void {
  tracer.startActiveSpan(name, { attributes: { 'scanner.file': file } }, (span) => {
    work(span)
      .catch((err) => {
        recordError(span, err);
        const error = err instanceof Error ? err : undefined;
        logger.error(
          `${name} failed for ${file}: ${err instanceof Error ? err.message : String(err)}`,
          { stack: error?.stack },
        );
      })
      .finally(() => span.end());
  });
}

/** Start a chokidar watcher over `root`. Add/change events upsert the affected track; unlink deletes it. Non-audio files are ignored. Caller must `close()` the returned watcher on shutdown. */
export function watchLibrary(root: string): FSWatcher {
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  const onUpsert = (file: string, kind: 'add' | 'change') => {
    if (!AUDIO_EXTENSION_RE.test(file)) return;
    withSpan(`scanner.watch.${kind}`, file, async () => {
      logger.info('[watch] Upserting file', { file });
      await upsertTrack(file);
    });
  };

  watcher.on('add', (file) => onUpsert(file, 'add'));
  watcher.on('change', (file) => onUpsert(file, 'change'));
  watcher.on('unlink', (file) => {
    if (!AUDIO_EXTENSION_RE.test(file)) return;
    withSpan('scanner.watch.unlink', file, async () => {
      logger.info('[watch] Deleting file', { file });
      await deleteTrackByFile(file);
    });
  });
  watcher.on('error', (err) => {
    tracer.startActiveSpan('scanner.watch.error', (span) => {
      recordError(span, err);
      span.end();
    });
    logger.error(`scanner watch error: ${err instanceof Error ? err.message : String(err)}`, {
      stack: (err as Error).stack,
    });
  });

  return watcher;
}
