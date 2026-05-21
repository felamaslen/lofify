import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
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
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Updated whenever the scanner re-reads this file. */
    scannedAt: timestamp('scannedAt', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    title: text('title'),
    trackNumber: integer('trackNumber'),
    discNumber: integer('discNumber'),
    artist: text('artist'),
    album: text('album'),
    year: text('year'),
    /** Container format of the source file (e.g. flac, ogg, mp3, wma). */
    format: text('format').notNull(),
    codec: text('codec').notNull(),
    /** Null implies VBR. */
    bitRate: integer('bitRate'),
    sampleRate: integer('sampleRate').notNull(),
    isLossless: boolean('isLossless').notNull(),
    /** Absolute path on disk. Natural key for scanner upserts. */
    file: text('file').notNull(),
    sizeBytes: bigint('sizeBytes', { mode: 'number' }).notNull(),
    durationSeconds: integer('durationSeconds').notNull(),
  },
  (t) => [
    index('Tracks_artist_idx').on(t.artist),
    index('Tracks_album_idx').on(t.album),
    uniqueIndex('Tracks_file_unq').on(t.file),
  ],
);

export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
