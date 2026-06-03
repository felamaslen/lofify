import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pgCustomSQL } from 'drizzle-pgkit-migrator';

/**
 * One album-art download, shared by every track of the album. Created PENDING by `Mutation.artworkDownload`; the artwork worker claims PENDING rows, fetches a cover and resolves them to SUCCEEDED or FAILED. Tracks point at their row via `Tracks.albumArtId`, so the link survives later tag edits.
 */
export const albumArt = pgTable(
  'AlbumArt',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Album artist the cover search runs against, snapshotted from the requesting track's effective tags. */
    albumArtist: text('albumArtist').notNull(),
    /** Album title the cover search runs against, snapshotted from the requesting track's effective tags. */
    album: text('album').notNull(),
    /** Basename of the downloaded image inside the artwork directory (`<id>.jpg`). Null until the download succeeds. */
    file: text('file'),
    status: text('status').notNull().default('PENDING'),
    /** Human-readable failure detail. Null unless the status is FAILED. */
    error: text('error'),
  },
  (t) => [
    uniqueIndex('AlbumArt_albumArtist_album_unq').on(t.albumArtist, t.album),
    check(
      'AlbumArt_status_ck',
      sql`${t.status} in ('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED')`,
    ),
  ],
);

/** Wakes the artwork worker the moment a row needs processing; the worker also poll-sweeps, so a missed notification only delays a download. */
export const albumArtPendingNotify = pgCustomSQL(
  sql`
    CREATE FUNCTION notify_album_art_pending() RETURNS trigger AS $fn$
    BEGIN
      PERFORM pg_notify('album_art_pending', NEW.id::text);
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    CREATE TRIGGER "AlbumArt_pending_notify"
    AFTER INSERT OR UPDATE OF "status" ON "public"."AlbumArt"
    FOR EACH ROW WHEN (NEW."status" = 'PENDING')
    EXECUTE FUNCTION notify_album_art_pending();
  `,
  { priority: 1 },
);

export type AlbumArt = typeof albumArt.$inferSelect;
export type NewAlbumArt = typeof albumArt.$inferInsert;
