import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { env } from '../env.js';
import { logger } from '../logger.js';
import { spawnFlacBake } from './ffmpeg.js';

function bakeRoot(): string {
  return env.TRANSCODE_BAKE_DIR ?? path.join(tmpdir(), 'lofify-bakes');
}

/**
 * Final on-disk path for the baked flac of a given track at a given source-mtime.
 *
 * The mtime is baked into the filename so the lookup is purely positional: when the source file changes, the new path doesn't exist and we re-bake; the old file becomes an orphan and can be GC'd separately. This also keeps the bake module independent of the DB — the resolver looks up the source mtime from `Tracks` and asks "does this file exist?", nothing more.
 */
export function bakePath(trackId: string, sourceMtime: Date): string {
  return path.join(bakeRoot(), `${trackId}-${sourceMtime.getTime()}.flac`);
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Kick off (or join) a background flac re-encode of `source` for `trackId`.
 *
 * Dedupe is by the `${trackId}-${sourceMtime}` key — repeated calls while a bake is in flight return the same promise. Callers that don't care about completion (the common case from the GraphQL resolver) can ignore the returned promise. The file is written via `tmp` → `rename` so a partial bake never gets observed at the final path; lookup is then a plain `fs.stat`.
 */
export function enqueueBake(trackId: string, source: string, sourceMtime: Date): Promise<void> {
  const finalPath = bakePath(trackId, sourceMtime);
  const existing = inFlight.get(finalPath);
  if (existing) return existing;
  const promise = runBake(source, finalPath).finally(() => {
    inFlight.delete(finalPath);
  });
  inFlight.set(finalPath, promise);
  return promise;
}

async function runBake(source: string, finalPath: string): Promise<void> {
  const tmpPath = `${finalPath}.tmp`;
  try {
    await mkdir(path.dirname(finalPath), { recursive: true });
    const handle = spawnFlacBake(source, tmpPath);
    await handle.done;
    await rename(tmpPath, finalPath);
    logger.info('flac bake complete', { path: finalPath });
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    logger.error('flac bake failed', {
      source,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Return true iff a baked flac for `(trackId, sourceMtime)` exists on disk. */
export async function bakeFileExists(trackId: string, sourceMtime: Date): Promise<boolean> {
  try {
    const st = await stat(bakePath(trackId, sourceMtime));
    return st.isFile();
  } catch {
    return false;
  }
}
