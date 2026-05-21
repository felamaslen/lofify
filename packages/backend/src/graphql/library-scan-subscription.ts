import type { ID } from 'grats';
import { getScan, onScanUpdate } from '../scanner/runner.js';
import { LibraryScan } from './library-scan.js';

/**
 * Streams snapshots of the named scan every second until it completes. Yields no further events and closes the stream once the scan finishes or is evicted.
 *
 * @gqlSubscriptionField
 */
export async function* libraryScan(args: {
  id: ID;
}): AsyncIterable<LibraryScan> {
  for (;;) {
    const state = getScan(args.id);
    if (!state) return;
    yield {
      id: state.id,
      filesTotal: state.filesTotal,
      scannedTotal: state.scannedTotal,
      errorsTotal: state.errorsTotal,
    };
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
