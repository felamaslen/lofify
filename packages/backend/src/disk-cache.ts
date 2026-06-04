import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { env } from './env.js';
import { logger } from './logger.js';

/** Root of the on-disk cache. Holds `transcode/` (playback cache entries) and `artwork/` (downloaded album art). */
export function diskCacheRoot(): string {
  return env.DISK_CACHE_DIR ?? path.join(tmpdir(), 'lofify-cache');
}

/** Directory holding playback-cache entries (`<trackId>-<mtimeMs>/<targetKey>.{bin,idx}`). */
export function transcodeDir(): string {
  return path.join(diskCacheRoot(), 'transcode');
}

/** Directory holding downloaded album-art images (`<albumArtId>.jpg`). */
export function artworkDir(): string {
  return path.join(diskCacheRoot(), 'artwork');
}

/** Directory holding rendered asset variants (`<sha256 of options + source URL>.<ext>`), produced by the `/asset` route. */
export function assetDir(): string {
  return path.join(diskCacheRoot(), 'asset');
}

/**
 * Creates the disk-cache directories and probe-writes the root. Throws when the cache is not writable, so a misconfigured deployment crashes at startup instead of limping along unable to transcode or store artwork.
 */
export async function ensureDiskCacheWritable(): Promise<void> {
  const root = diskCacheRoot();
  await mkdir(transcodeDir(), { recursive: true });
  await mkdir(artworkDir(), { recursive: true });
  await mkdir(assetDir(), { recursive: true });
  // Per-process probe name: parallel processes (e.g. vitest workers) share the root and would race a fixed name.
  const probe = path.join(root, `.write-probe-${process.pid}`);
  await writeFile(probe, '');
  await unlink(probe);
}

const ENTRY_DIR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/;

/**
 * One-time move of legacy playback-cache entries from the cache root into `transcode/`. Earlier releases wrote `<trackId>-<mtimeMs>` entry directories directly under the root; the stored `PlaybackCacheAccess.entryDir` names stay valid because they are directory names, not paths. Idempotent — once moved, nothing at the root matches the entry pattern. Per-entry failures are logged and skipped so startup never blocks on a stray file.
 */
export async function migrateDiskCacheLayout(): Promise<void> {
  const root = diskCacheRoot();
  const names = await readdir(root);
  for (const name of names) {
    if (!ENTRY_DIR_PATTERN.test(name)) continue;
    try {
      await rename(path.join(root, name), path.join(transcodeDir(), name));
    } catch (err) {
      logger.warn(
        `disk cache: failed to move legacy entry ${name} into transcode/: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
