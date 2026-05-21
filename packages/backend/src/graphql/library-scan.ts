import type { ID, Int } from 'grats';
import { env } from '../env.js';
import { scanLibrary } from '../scanner/scan.js';

/**
 * Snapshot of an ongoing or completed library scan.
 *
 * @gqlType
 */
export type LibraryScan = {
  /** @gqlField */
  id: ID;
  /** Total files discovered on disk for this scan. Null until the file walk has finished — clients should render an indeterminate progress state in that case. @gqlField */
  filesTotal: Int | null;
  /** Files successfully parsed and upserted so far. @gqlField */
  scannedTotal: Int;
  /** Files that failed to parse or upsert. @gqlField */
  errorsTotal: Int;
};

/**
 * Triggers a full scan of the configured library. Returns immediately with `filesTotal: null`; the file walk and parsing run in the background. Observe progress via `Subscription.libraryScan`.
 *
 * @gqlMutationField
 */
export function libraryScan(): LibraryScan {
  const state = scanLibrary(env.LIBRARY_PATH);
  return {
    id: state.id,
    filesTotal: state.filesTotal,
    scannedTotal: state.scannedTotal,
    errorsTotal: state.errorsTotal,
  };
}

