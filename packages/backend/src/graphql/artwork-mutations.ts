import { eq, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ID } from 'grats';

import { db } from '../db/client.js';
import { albumArt, tracks } from '../db/schema/index.js';
import { readAlbumArtistTag } from '../scanner/parse.js';
import { toTrackArtwork, type TrackArtwork } from './artwork.js';
import { applyOverride } from './track.js';

/** SQL form of `applyOverride`: an empty-string override blanks the field, a null override falls back to the scanned tag. */
function effectiveTag(override: PgColumn, scanned: PgColumn): SQL {
  return sql`case when ${override} is null then ${scanned} when ${override} = '' then null else ${override} end`;
}

/**
 * Request album art for a track's album. Upserts an `AlbumArt` row keyed on the track's effective album artist (falling back to its artist) and album — creating it PENDING, resetting a FAILED row to PENDING for a retry, and leaving an in-progress or succeeded row untouched — then links every track of the album to the row. The artwork worker processes PENDING rows asynchronously; poll `Track.artwork` for the result.
 *
 * Throws when the track does not exist or has no album or artist to search by.
 *
 * @gqlMutationField
 */
export async function artworkDownload(trackId: ID): Promise<TrackArtwork> {
  const trackRows = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  const track = trackRows[0];
  if (!track) throw new Error('Unknown track.');

  const album = applyOverride(track.albumOverride, track.album);
  if (album == null) throw new Error('Track has no album to search art for.');

  // Rows scanned before the albumArtist column existed have it null even when the file carries the tag; re-read it lazily rather than waiting for a forced rescan.
  if (track.albumArtistOverride == null && track.albumArtist == null) {
    const scanned = await readAlbumArtistTag(track.file).catch(() => null);
    if (scanned != null) {
      await db.update(tracks).set({ albumArtist: scanned }).where(eq(tracks.id, trackId));
      track.albumArtist = scanned;
    }
  }

  const albumArtist =
    applyOverride(track.albumArtistOverride, track.albumArtist) ??
    applyOverride(track.artistOverride, track.artist);
  if (albumArtist == null) throw new Error('Track has no artist to search art for.');

  const [row] = await db
    .insert(albumArt)
    .values({ albumArtist, album })
    .onConflictDoUpdate({
      target: [albumArt.albumArtist, albumArt.album],
      set: {
        status: sql`case when ${albumArt.status} = 'FAILED' then 'PENDING' else ${albumArt.status} end`,
        error: sql`case when ${albumArt.status} = 'FAILED' then null else ${albumArt.error} end`,
        updatedAt: sql`case when ${albumArt.status} = 'FAILED' then now() else ${albumArt.updatedAt} end`,
      },
    })
    .returning();
  if (!row) throw new Error('Failed to record the artwork request.');

  // Link every track of the album, not just the one the mutation was called with.
  const effAlbumArtist = effectiveTag(tracks.albumArtistOverride, tracks.albumArtist);
  const effArtist = effectiveTag(tracks.artistOverride, tracks.artist);
  await db
    .update(tracks)
    .set({ albumArtId: row.id })
    .where(
      sql`${effectiveTag(tracks.albumOverride, tracks.album)} = ${album}
        and coalesce(${effAlbumArtist}, ${effArtist}) = ${albumArtist}`,
    );

  return toTrackArtwork(row);
}
