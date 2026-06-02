import { eq } from 'drizzle-orm';
import type { ID, Int } from 'grats';

import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { dedupKeyOf, recomputeDedupGroups } from '../dedup/recompute.js';
import { toGqlTrack, type Track } from './track.js';

/**
 * Override one or more tags on a single track. Each supplied tag is stored as an override that takes precedence over the value read from the file on disk and survives rescans — the scanner never touches it.
 *
 * Omit an argument to leave its current override untouched; pass an explicit `null` to clear the override and fall back to the scanned tag.
 *
 * Throws when no track with the given id exists.
 *
 * @gqlMutationField
 */
export async function trackUpdate(
  id: ID,
  title?: string | null,
  trackNumber?: Int | null,
  discNumber?: Int | null,
  artist?: string | null,
  album?: string | null,
  year?: string | null,
): Promise<Track> {
  const set: Record<string, string | number | null | Date> = {};
  if (title !== undefined) set.titleOverride = title;
  if (trackNumber !== undefined) set.trackNumberOverride = trackNumber;
  if (discNumber !== undefined) set.discNumberOverride = discNumber;
  if (artist !== undefined) set.artistOverride = artist;
  if (album !== undefined) set.albumOverride = album;
  if (year !== undefined) set.yearOverride = year;

  // Only title/artist/album move a track between duplicate groups; recompute the old and new groups when one of those changes.
  const dedupAffecting =
    'titleOverride' in set || 'artistOverride' in set || 'albumOverride' in set;
  const keyCols = {
    title: tracksTable.title,
    titleOverride: tracksTable.titleOverride,
    artist: tracksTable.artist,
    artistOverride: tracksTable.artistOverride,
    album: tracksTable.album,
    albumOverride: tracksTable.albumOverride,
  };
  const before = dedupAffecting
    ? await db.select(keyCols).from(tracksTable).where(eq(tracksTable.id, id)).limit(1)
    : [];

  if (Object.keys(set).length > 0) {
    set.updatedAt = new Date();
    await db.update(tracksTable).set(set).where(eq(tracksTable.id, id));
  }

  if (dedupAffecting) {
    const after = await db.select(keyCols).from(tracksTable).where(eq(tracksTable.id, id)).limit(1);
    if (!after[0]) throw new Error('Unknown track.');
    await recomputeDedupGroups([before[0] ? dedupKeyOf(before[0]) : null, dedupKeyOf(after[0])]);
  }

  const rows = await db.select().from(tracksTable).where(eq(tracksTable.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error('Unknown track.');
  return toGqlTrack(row);
}
