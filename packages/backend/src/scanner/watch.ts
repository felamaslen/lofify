import chokidar, { type FSWatcher } from 'chokidar';
import { logger } from '../logger.js';
import { deleteTrackByFile, upsertTrack } from './scan.js';

const AUDIO_EXTENSIONS_RE = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|wma|webm)$/i;

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
    if (!AUDIO_EXTENSIONS_RE.test(file)) return;
    upsertTrack(file).catch((err) => {
      logger.error(
        `scanner watch ${kind} failed for ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  };

  watcher.on('add', (file) => onUpsert(file, 'add'));
  watcher.on('change', (file) => onUpsert(file, 'change'));
  watcher.on('unlink', (file) => {
    if (!AUDIO_EXTENSIONS_RE.test(file)) return;
    deleteTrackByFile(file).catch((err) => {
      logger.error(
        `scanner watch unlink failed for ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });
  watcher.on('error', (err) => {
    logger.error(`scanner watch error: ${err instanceof Error ? err.message : String(err)}`);
  });

  return watcher;
}
