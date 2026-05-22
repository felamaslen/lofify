import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Cron } from 'croner';

import { env } from '../env.js';
import { logger } from '../logger.js';
import { scanLibrary } from './scan.js';

const tracer = trace.getTracer('lofify.scanner');

/** Schedule a recurring full library scan according to `SCAN_CRON`. Returns a stop function (no-op when the schedule is empty or invalid). Concurrent ticks are skipped — if a previous scan is still in progress, `scanLibrary` throws and we just log it. */
export function startScanSchedule(): () => void {
  const expression = env.SCAN_CRON.trim();
  if (!expression) return () => {};

  let job: Cron;
  try {
    job = new Cron(expression, { protect: true }, () => {
      tracer.startActiveSpan(
        'scanner.scheduledScan',
        {
          attributes: {
            'scanner.cron': expression,
            'scanner.root': env.LIBRARY_PATH,
          },
        },
        (span) => {
          try {
            const state = scanLibrary(env.LIBRARY_PATH);
            span.setAttribute('scanner.id', state.id);
          } catch (err) {
            logger.warn(
              `scanner: scheduled scan skipped: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
          } finally {
            span.end();
          }
        },
      );
    });
  } catch (err) {
    logger.error(
      `scanner: invalid SCAN_CRON expression ${JSON.stringify(expression)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return () => {};
  }

  logger.info(`scanner: scheduled library scan with cron "${expression}"`);
  return () => job.stop();
}
