/**
 * Disk-bounded LRU sweep for the playback cache. The in-memory cache (see `cache.ts`) is already an LRU over live handles; this bounds the *on-disk* footprint, which otherwise grows without limit because evicting an in-memory handle deliberately leaves the `.bin`/`.idx` behind for a future warm load.
 *
 * The recency and size of every tracked entry live in Postgres (`PlaybackCacheAccess`), so the sweep is a query, not a disk scan: `cache.ts` repeatedly picks the oldest non-protected entry (`ORDER BY lastAccess LIMIT 1`) and deletes its dir until total usage drops under budget. Files on disk with no row (orphaned partials from a crash) are ignored — `startFresh` wipes those on the next encode. This module owns only the schedule and the disk-full predicate.
 *
 * `startCacheSweepSchedule` runs `Cache.sweep` periodically; the cache also sweeps after each transcode and, as a backstop, when a write hits ENOSPC.
 */

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Cron } from 'croner';

import { env } from '../env.js';
import { logger } from '../logger.js';
import type { Cache } from './cache.js';

const tracer = trace.getTracer('lofify.playback.sweep');

/** Returns true for errors that mean the disk is full, across both fs writes (errno `ENOSPC`) and ffmpeg failures (tagged by `spawnEncoder`). */
export function isDiskFullError(err: unknown): boolean {
  return err != null && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOSPC';
}

/** Schedule a recurring cache sweep according to `DISK_CACHE_SWEEP_CRON`. Returns a stop function (no-op when sweeping is disabled or the expression is empty/invalid). Concurrent ticks are skipped. */
export function startCacheSweepSchedule(cache: Cache): () => void {
  if (env.DISK_CACHE_MAX_BYTES == null) return () => {};
  const expression = env.DISK_CACHE_SWEEP_CRON.trim();
  if (!expression) return () => {};

  let job: Cron;
  try {
    job = new Cron(expression, { protect: true }, () => {
      tracer.startActiveSpan('playback.cache.scheduledSweep', (span) => {
        cache
          .sweep()
          .then(({ freedBytes, evicted }) => {
            if (evicted.length > 0) {
              logger.info(
                `playback cache: swept ${evicted.length} entries, freed ${freedBytes} bytes`,
              );
            }
          })
          .catch((err: unknown) => {
            logger.error(
              `playback cache: scheduled sweep failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
          })
          .finally(() => span.end());
      });
    });
  } catch (err) {
    logger.error(
      `playback cache: invalid DISK_CACHE_SWEEP_CRON expression ${JSON.stringify(
        expression,
      )}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return () => {};
  }

  logger.info(`playback cache: scheduled sweep with cron "${expression}"`);
  return () => job.stop();
}
