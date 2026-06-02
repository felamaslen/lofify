import type { ID, Int } from 'grats';

import { libraryPaths } from '../env.js';
import { cancelScan, getScan, onScanUpdate } from '../scanner/runner.js';
import { getLatestScan, type ScanState } from '../scanner/runner.js';
import { scanLibrary } from '../scanner/scan.js';
import type { Void } from './types.js';

/**
 * Snapshot of an ongoing or completed library scan.
 *
 * @gqlType
 */
export class LibraryScan {
  constructor(private state: ScanState) {}

  /** @gqlField */
  id(): ID {
    return this.state.id;
  }
  /** Total files discovered on disk for this scan. Null until the file walk has finished — clients should render an indeterminate progress state in that case. @gqlField */
  filesTotal(): Int | null {
    return this.state.filesTotal;
  }
  /** Files successfully parsed and upserted so far. @gqlField */
  scannedTotal(): Int {
    return this.state.scannedTotal;
  }
  /** Files that failed to parse or upsert. @gqlField */
  errorsTotal(): Int {
    return this.state.errorsTotal;
  }
  /** True once the scan has finished (successfully or not). @gqlField */
  isCompleted(): boolean {
    return this.state.completedAt != null;
  }
  /** Human-readable summary of errors encountered, or null when no errors have been recorded. @gqlField */
  errorMessage(): string | null {
    return this.state.errorsTotal > 0
      ? `${this.state.errorsTotal} file${this.state.errorsTotal === 1 ? '' : 's'} failed to scan`
      : null;
  }
}

/**
 * The current library scan, if one is in progress or recently completed within the server's grace window. Null when no scan has run recently.
 *
 * @gqlQueryField
 */
export function libraryScan(): LibraryScan | null {
  const state = getLatestScan();
  return state ? new LibraryScan(state) : null;
}

/**
 * Triggers a full scan of the configured library. Returns immediately with `filesTotal: null`; the file walk and parsing run in the background. Observe progress via `Subscription.libraryScan`.
 *
 * Pass `force: true` to re-parse every file even when its content is unchanged, rather than skipping files whose mtime matches the stored row. Slower, but the way to backfill metadata captured by a newer scanner.
 *
 * @gqlMutationField
 */
export function libraryScanStart(args: { force?: boolean | null }): LibraryScan {
  return new LibraryScan(scanLibrary(libraryPaths, { force: args.force ?? false }));
}

/**
 * Requests cancellation of the named in-progress scan. No-op when the scan is unknown or already completed.
 *
 * @gqlMutationField
 */
export function libraryScanCancel(args: { id: ID }): Void {
  cancelScan(args.id);
  return {};
}

/**
 * Streams snapshots of the named scan every second until it completes. Closes the stream once the scan finishes normally (after yielding a final snapshot with `isCompleted: true`), or yields a single `null` and closes when the scan is cancelled or evicted.
 *
 * @gqlSubscriptionField libraryScan
 */
export async function* libraryScanSubscription(args: {
  id: ID;
}): AsyncIterable<LibraryScan | null> {
  for (;;) {
    const state = getScan(args.id);
    if (!state) {
      yield null;
      return;
    }
    yield new LibraryScan(state);
    if (state.completedAt != null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(finish, 1000);
      const unsubscribe = onScanUpdate(args.id, finish);
    });
  }
}
