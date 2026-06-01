import { index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

/**
 * Maps alternative names to a canonical artist so search can surface an artist by an alias, romanisation, or common misspelling.
 *
 * One row per (artist, synonym) pair, both forming the primary key. `artist` is the canonical name as it appears as the effective artist on `Tracks` (and the value fed to `Query.tracks(filterArtistIn:)`); `synonym` is the alternative that should also match in search.
 */
export const artistSynonyms = pgTable(
  'ArtistSynonyms',
  {
    /** Canonical artist name, matching the effective artist on `Tracks`. */
    artist: text('artist').notNull(),
    /** Alternative name that should surface `artist` in search. Never fed to `filterArtistIn`. */
    synonym: text('synonym').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artist, t.synonym] }),
    index('ArtistSynonyms_synonym_idx').on(t.synonym),
  ],
);

export type ArtistSynonym = typeof artistSynonyms.$inferSelect;
export type NewArtistSynonym = typeof artistSynonyms.$inferInsert;
