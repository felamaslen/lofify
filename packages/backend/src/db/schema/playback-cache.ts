import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Recency and size index for on-disk playback cache entries, used to bound the cache to a soft byte budget by evicting least-recently-accessed entries first.
 *
 * One row per entry directory. The row is authoritative for which entries the sweeper considers — files on disk with no row (orphaned partials from a crashed encode) are left alone. Rows are deleted when the sweeper evicts the entry.
 */
export const playbackCacheAccess = pgTable(
  'PlaybackCacheAccess',
  {
    /** Entry directory name relative to the cache root: `<trackId>-<sourceMtimeMs>`. Holds every per-target `.bin`/`.idx` for that track revision, so eviction is dir-granular. */
    entryDir: text('entryDir').primaryKey(),
    /** Bumped (throttled) on every playback request for the entry. The sweep orders evictions by this, oldest first. */
    lastAccess: timestamp('lastAccess', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Total on-disk size of the entry. Zero until the encode completes and the real size is recorded; the sweep sums this to compare against the budget. */
    sizeBytes: bigint('sizeBytes', { mode: 'number' }).notNull().default(0),
  },
  // The sweep repeatedly picks the oldest entry (`ORDER BY lastAccess LIMIT 1`); this turns each
  // pick into an index seek instead of a full sort.
  (t) => [index('PlaybackCacheAccess_lastAccess_idx').on(t.lastAccess)],
);

export type PlaybackCacheAccess = typeof playbackCacheAccess.$inferSelect;
export type NewPlaybackCacheAccess = typeof playbackCacheAccess.$inferInsert;
