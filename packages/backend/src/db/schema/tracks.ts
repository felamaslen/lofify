import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const tracks = pgTable(
  'Tracks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Updated whenever the scanner re-reads this file. */
    scannedAt: timestamp('scannedAt', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    title: text('title'),
    trackNumber: integer('trackNumber'),
    discNumber: integer('discNumber'),
    artist: text('artist'),
    album: text('album'),
    year: text('year'),
    /** User-supplied title that takes precedence over the scanned `title`. Preserved across rescans; null means fall back to the scanned tag, an empty string blanks the field. */
    titleOverride: text('titleOverride'),
    /** User-supplied track number that takes precedence over the scanned `trackNumber`. Preserved across rescans; null means fall back to the scanned tag. */
    trackNumberOverride: integer('trackNumberOverride'),
    /** User-supplied disc number that takes precedence over the scanned `discNumber`. Preserved across rescans; null means fall back to the scanned tag. */
    discNumberOverride: integer('discNumberOverride'),
    /** User-supplied artist that takes precedence over the scanned `artist`. Preserved across rescans; null means fall back to the scanned tag, an empty string blanks the field. */
    artistOverride: text('artistOverride'),
    /** User-supplied album that takes precedence over the scanned `album`. Preserved across rescans; null means fall back to the scanned tag, an empty string blanks the field. */
    albumOverride: text('albumOverride'),
    /** User-supplied year that takes precedence over the scanned `year`. Preserved across rescans; null means fall back to the scanned tag, an empty string blanks the field. */
    yearOverride: text('yearOverride'),
    /** Container format of the source file (e.g. flac, ogg, mp3, wma). */
    format: text('format').notNull(),
    codec: text('codec').notNull(),
    /** Codec quality option reported by the decoder, e.g. AAC `LC`/`HE-AAC` or MP3 `CBR`/`VBR`. Null when the decoder reports none. */
    codecProfile: text('codecProfile'),
    /** Null implies VBR. */
    bitRate: integer('bitRate'),
    sampleRate: integer('sampleRate').notNull(),
    /** Bits per sample of the source. Null for lossy codecs and any source whose decoder reports no fixed bit depth. */
    bitDepth: integer('bitDepth'),
    /** Channel count of the source (e.g. 2 for stereo). Null when the decoder reports none. */
    channels: integer('channels'),
    isLossless: boolean('isLossless').notNull(),
    /** Absolute path on disk. Natural key for scanner upserts. */
    file: text('file').notNull(),
    sizeBytes: bigint('sizeBytes', { mode: 'number' }).notNull(),
    durationSeconds: integer('durationSeconds').notNull(),
    /** mtime of the source file when last scanned. Used to detect out-of-band content changes and to invalidate derived state (e.g. cached transcodes). */
    sourceMtime: timestamp('sourceMtime', { withTimezone: true, mode: 'date' }).notNull(),
    /** Canonical (highest-quality) track of this row's duplicate group — the copy surfaced when duplicates are hidden. Every member of a group carries it, the canonical row pointing at itself. Null when this row has no duplicate. */
    trackIdDeduplicated: uuid('trackIdDeduplicated').references((): AnyPgColumn => tracks.id),
    /** Rank of this row within its duplicate group, 0 being the canonical/best source. Null exactly when `trackIdDeduplicated` is null (the row has no duplicate). */
    priority: smallint('priority'),
  },
  (t) => [
    index('Tracks_artist_idx').on(t.artist),
    index('Tracks_album_idx').on(t.album),
    uniqueIndex('Tracks_file_unq').on(t.file),
    uniqueIndex('Tracks_dedup_priority_unq').on(t.trackIdDeduplicated, t.priority),
    check(
      'Tracks_dedup_pairing_ck',
      sql`(${t.trackIdDeduplicated} is null) = (${t.priority} is null)`,
    ),
  ],
);

export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
