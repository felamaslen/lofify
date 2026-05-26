import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { spawnFlacBake } from './ffmpeg.js';

function bakeRoot(): string {
  return env.TRANSCODE_BAKE_DIR ?? path.join(tmpdir(), 'lofify-bakes');
}

/** Final on-disk path for the baked flac of a given track. */
export function bakePath(trackId: string): string {
  return path.join(bakeRoot(), `${trackId}.flac`);
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Kick off (or join) a background flac re-encode of `source` for `trackId`.
 *
 * The call resolves when the encode finishes and the DB has been updated; callers that don't care about completion (the common case from the GraphQL resolver) can ignore the returned promise. Dedupe is by `trackId` — repeated calls while a bake is in flight return the same promise. After the encode succeeds we set `Tracks.flacCachePath`, but only if `Tracks.sourceMtime` still matches `sourceMtime` from when the bake started; if the source has been re-scanned in the meantime the result is discarded so we never serve stale audio.
 */
export function enqueueBake(trackId: string, source: string, sourceMtime: Date): Promise<void> {
  const existing = inFlight.get(trackId);
  if (existing) return existing;
  const promise = runBake(trackId, source, sourceMtime).finally(() => {
    inFlight.delete(trackId);
  });
  inFlight.set(trackId, promise);
  return promise;
}

async function runBake(trackId: string, source: string, sourceMtime: Date): Promise<void> {
  const finalPath = bakePath(trackId);
  const tmpPath = `${finalPath}.tmp`;
  try {
    await mkdir(path.dirname(finalPath), { recursive: true });
    const handle = spawnFlacBake(source, tmpPath);
    await handle.done;

    // Re-check the source mtime; if the scanner has picked up a content change
    // since we started, the bake is stale and must be discarded.
    const current = await db
      .select({ sourceMtime: tracks.sourceMtime })
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .limit(1);
    const row = current[0];
    if (!row || row.sourceMtime.getTime() !== sourceMtime.getTime()) {
      await rm(tmpPath, { force: true });
      logger.info('flac bake discarded — source changed during encode', { trackId });
      return;
    }

    await rename(tmpPath, finalPath);
    await db
      .update(tracks)
      .set({ flacCachePath: finalPath, updatedAt: new Date() })
      .where(and(eq(tracks.id, trackId), eq(tracks.sourceMtime, sourceMtime)));
    logger.info('flac bake complete', { trackId, path: finalPath });
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    logger.error('flac bake failed', {
      trackId,
      source,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Return true iff `cachePath` exists on disk; used to defend against rows whose `flacCachePath` points at a manually-deleted file. */
export async function bakeFileExists(cachePath: string): Promise<boolean> {
  try {
    const st = await stat(cachePath);
    return st.isFile();
  } catch {
    return false;
  }
}
