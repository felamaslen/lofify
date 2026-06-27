import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tracks } from './tracks.js';

/**
 * One playback-analytics sample emitted by the web player while a track plays. A sample is sent when a play begins (with `playTimeSeconds` 0), once per accrued interval of actual playback, and a final partial sample when the play pauses, ends, or is switched away from.
 *
 * Summing `playTimeSeconds` for a track gives its true total listen time; counting the zero-time start samples gives how many times it was played.
 */
export const trackAnalytics = pgTable(
  'TrackAnalytics',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    /** The track this sample is about. */
    trackId: uuid('trackId')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    /** IP of the listening client, taken from `X-Forwarded-For` (the server trusts the proxy). */
    clientIp: text('clientIp').notNull(),
    /** Seconds of actual playback since this client's previous sample for the same play; 0 for the sample sent at play start. */
    playTimeSeconds: integer('playTimeSeconds').notNull(),
    /** Playback mode the listener had selected when the sample was taken: `SMART`, `ORIGINAL` or `ADAPTIVE`. */
    requestedMode: text('requestedMode').notNull(),
    /** MIME type of the bytes actually delivered to the player, which carries the output codec (e.g. `audio/webm; codecs="opus"`). */
    outputCodec: text('outputCodec').notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('TrackAnalytics_trackId_idx').on(t.trackId)],
);

export type TrackAnalytics = typeof trackAnalytics.$inferSelect;
export type NewTrackAnalytics = typeof trackAnalytics.$inferInsert;
