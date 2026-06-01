import { and, eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { artistSynonyms as artistSynonymsTable } from '../db/schema/index.js';
import type { Track } from './track.js';
import type { Void } from './types.js';

/**
 * An alternative name for an artist, used to surface that artist in search.
 *
 * @gqlType
 */
export type ArtistSynonym = {
  /** The canonical artist, as it appears on tracks and is passed to `Query.tracks(filterArtistIn:)`. @gqlField */
  artist: string;
  /** The alternative name that matches the artist in search. @gqlField */
  synonym: string;
};

/**
 * Alternative names registered for this track's effective artist, alphabetically. Empty when the track has no artist or none are registered.
 *
 * @gqlField
 */
export async function artistSynonyms(track: Track): Promise<string[]> {
  if (track.artist == null) return [];
  const rows = await db
    .select({ synonym: artistSynonymsTable.synonym })
    .from(artistSynonymsTable)
    .where(eq(artistSynonymsTable.artist, track.artist))
    .orderBy(artistSynonymsTable.synonym);
  return rows.map((r) => r.synonym);
}

async function exists(artist: string, synonym: string): Promise<boolean> {
  const rows = await db
    .select({ synonym: artistSynonymsTable.synonym })
    .from(artistSynonymsTable)
    .where(and(eq(artistSynonymsTable.artist, artist), eq(artistSynonymsTable.synonym, synonym)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Register `synonym` as an alternative name for `artist`. Throws when either is blank or the pair already exists.
 *
 * @gqlMutationField
 */
export async function artistSynonymCreate(artist: string, synonym: string): Promise<ArtistSynonym> {
  const a = artist.trim();
  const s = synonym.trim();
  if (a === '' || s === '') throw new Error('Artist and synonym must be non-empty.');
  if (await exists(a, s)) throw new Error('Synonym already exists for this artist.');
  await db.insert(artistSynonymsTable).values({ artist: a, synonym: s });
  return { artist: a, synonym: s };
}

/**
 * Rename the synonym `synonym` of `artist` to `newSynonym`. Throws when `newSynonym` is blank, the original pair is unknown, or the renamed pair already exists.
 *
 * @gqlMutationField
 */
export async function artistSynonymUpdate(
  artist: string,
  synonym: string,
  newSynonym: string,
): Promise<ArtistSynonym> {
  const a = artist.trim();
  const s = synonym.trim();
  const ns = newSynonym.trim();
  if (ns === '') throw new Error('Synonym must be non-empty.');
  if (!(await exists(a, s))) throw new Error('Unknown synonym.');
  if (ns !== s) {
    if (await exists(a, ns)) throw new Error('Synonym already exists for this artist.');
    await db
      .update(artistSynonymsTable)
      .set({ synonym: ns })
      .where(and(eq(artistSynonymsTable.artist, a), eq(artistSynonymsTable.synonym, s)));
  }
  return { artist: a, synonym: ns };
}

/**
 * Remove the synonym `synonym` from `artist`. No-op when the pair doesn't exist.
 *
 * @gqlMutationField
 */
export async function artistSynonymDelete(artist: string, synonym: string): Promise<Void> {
  await db
    .delete(artistSynonymsTable)
    .where(and(eq(artistSynonymsTable.artist, artist), eq(artistSynonymsTable.synonym, synonym)));
  return {};
}
