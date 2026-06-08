import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * One file the scanner failed to read, keyed by its absolute path. A row blocks that file from being re-attempted on every future scan until it is retried or dismissed by hand, so a single broken file never wedges the scan. The matching row is cleared the moment the file scans successfully or is deleted.
 */
export const scanErrors = pgTable(
  'ScanErrors',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    /** Absolute path of the file that failed. */
    file: text('file').notNull(),
    /** Short, human-readable category of the failure (e.g. "I/O error", "Could not read audio metadata"), shown to the user when reviewing errors. */
    message: text('message').notNull(),
    /** Full error stack of the most recent attempt, kept for server-side diagnosis. */
    stack: text('stack').notNull(),
    /** When the most recent failed attempt occurred. */
    attemptedAt: timestamp('attemptedAt', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('ScanErrors_file_unq').on(t.file)],
);

export type ScanError = typeof scanErrors.$inferSelect;
export type NewScanError = typeof scanErrors.$inferInsert;
