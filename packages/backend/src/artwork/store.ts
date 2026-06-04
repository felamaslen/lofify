import { randomUUID } from 'node:crypto';
import { readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { fileTypeFromBuffer } from 'file-type';

import { db } from '../db/client.js';
import { type AlbumArt, albumArt, type Track as DbTrack, tracks } from '../db/schema/index.js';
import { artworkDir } from '../disk-cache.js';
import { applyOverride } from '../graphql/track.js';
import { readAlbumArtistTag } from '../scanner/parse.js';

/** The effective (album artist, album) pair an `AlbumArt` row is keyed on. */
export type ArtworkKey = { albumArtist: string; album: string };

/** Stored file extensions for manually uploaded images. */
export type UploadExtension = 'jpg' | 'png' | 'webp';

/** Sniffed magic-byte MIME → stored extension. The bytes decide what is stored and served, never the declared type. */
const SNIFFED_EXTENSIONS: Record<string, UploadExtension> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** SQL form of `applyOverride`: an empty-string override blanks the field, a null override falls back to the scanned tag. */
function effectiveTag(override: PgColumn, scanned: PgColumn): SQL {
  return sql`case when ${override} is null then ${scanned} when ${override} = '' then null else ${override} end`;
}

/**
 * The artwork search/storage key for a track: its effective album and album artist (falling back to its artist), with overrides applied. Rows scanned before the `albumArtist` column existed have it null even when the file carries the tag, so it is lazily re-read from disk and persisted rather than waiting for a forced rescan. Throws when the track has no album or no artist.
 */
export async function resolveArtworkKey(track: DbTrack): Promise<ArtworkKey> {
  const album = applyOverride(track.albumOverride, track.album);
  if (album == null) throw new Error('Track has no album to search art for.');

  if (track.albumArtistOverride == null && track.albumArtist == null) {
    const scanned = await readAlbumArtistTag(track.file).catch(() => null);
    if (scanned != null) {
      await db.update(tracks).set({ albumArtist: scanned }).where(eq(tracks.id, track.id));
      track.albumArtist = scanned;
    }
  }

  const albumArtist =
    applyOverride(track.albumArtistOverride, track.albumArtist) ??
    applyOverride(track.artistOverride, track.artist);
  if (albumArtist == null) throw new Error('Track has no artist to search art for.');

  return { albumArtist, album };
}

/** Point every track whose effective tags match `key` at the given `AlbumArt` row — the whole album picks up the art, not just the track that triggered it. */
export async function linkAlbumTracks(albumArtId: string, key: ArtworkKey): Promise<void> {
  const effAlbumArtist = effectiveTag(tracks.albumArtistOverride, tracks.albumArtist);
  const effArtist = effectiveTag(tracks.artistOverride, tracks.artist);
  await db
    .update(tracks)
    .set({ albumArtId })
    .where(
      sql`${effectiveTag(tracks.albumOverride, tracks.album)} = ${key.album}
        and coalesce(${effAlbumArtist}, ${effArtist}) = ${key.albumArtist}`,
    );
}

/**
 * Persist a manually uploaded image as the album's artwork and link the album's tracks to it. The format is sniffed from the magic bytes — anything but jpeg/png/webp throws. Always writes a fresh basename: `/artwork/<file>` URLs are served immutable, so replacing art must change the URL, never the bytes behind it. The replaced file (if any) is removed best-effort once the row points at the new one. The row lands SUCCEEDED directly — there is nothing for the worker to do, and a concurrent in-flight download cannot stomp it because the worker only resolves rows still IN_PROGRESS.
 */
export async function storeUploadedArtwork(track: DbTrack, bytes: Buffer): Promise<AlbumArt> {
  const sniffed = await fileTypeFromBuffer(bytes);
  const extension = sniffed && SNIFFED_EXTENSIONS[sniffed.mime];
  if (!extension) throw new Error('Unsupported image format — use jpeg, png or webp.');

  const key = await resolveArtworkKey(track);
  const file = `${randomUUID()}.${extension}`;
  await writeFile(path.join(artworkDir(), file), bytes);

  const previous = await db
    .select({ file: albumArt.file })
    .from(albumArt)
    .where(and(eq(albumArt.albumArtist, key.albumArtist), eq(albumArt.album, key.album)))
    .limit(1);

  const [row] = await db
    .insert(albumArt)
    .values({ ...key, status: 'SUCCEEDED', file })
    .onConflictDoUpdate({
      target: [albumArt.albumArtist, albumArt.album],
      set: { status: 'SUCCEEDED', file, error: null, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('Failed to store the artwork.');

  await linkAlbumTracks(row.id, key);

  const stale = previous[0]?.file;
  if (stale && stale !== file) {
    await removeImageAndDerivatives(stale);
  }
  return row;
}

/** Remove a stored image and any rendered variants (named `<basename>.<size>.<format>` beside it). Best-effort — an orphaned file is wasted disk, not an error. */
async function removeImageAndDerivatives(basename: string): Promise<void> {
  const entries = await readdir(artworkDir()).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => name === basename || name.startsWith(`${basename}.`))
      .map((name) => unlink(path.join(artworkDir(), name)).catch(() => undefined)),
  );
}
