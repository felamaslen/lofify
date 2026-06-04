import { eq, sql } from 'drizzle-orm';
import type { ID } from 'grats';

import { clearManualArtwork, linkAlbumTracks, resolveArtworkKey } from '../artwork/store.js';
import { db } from '../db/client.js';
import { albumArt, tracks } from '../db/schema/index.js';
import { toTrackArtwork, type TrackArtwork } from './artwork.js';

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

  const key = await resolveArtworkKey(track);

  const [row] = await db
    .insert(albumArt)
    .values({ ...key })
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

  await linkAlbumTracks(row.id, key);

  return toTrackArtwork(row);
}

/**
 * Clear a manually uploaded cover from a track's album — the undo for a wrong upload. The image is removed and the album is requeued for an automatic download; poll `Track.artwork` for the result.
 *
 * Throws when the track does not exist, has no artwork, or its artwork was not manually set.
 *
 * @gqlMutationField
 */
export async function artworkClear(trackId: ID): Promise<TrackArtwork> {
  const trackRows = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  const track = trackRows[0];
  if (!track) throw new Error('Unknown track.');
  if (!track.albumArtId) throw new Error('Track has no artwork to clear.');

  return toTrackArtwork(await clearManualArtwork(track.albumArtId));
}
