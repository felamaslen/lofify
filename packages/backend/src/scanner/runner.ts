import { EventEmitter } from 'node:events';

import { v4 as uuidv4 } from 'uuid';

export type ScanError = {
  err: unknown;
  file: string;
  message: string;
};

export type ScanState = {
  id: string;
  /** Null until the file walk has finished; clients should show an indeterminate progress state while null. */
  filesTotal: number | null;
  scannedTotal: number;
  errorsTotal: number;
  errors: ScanError[];
  completedAt: number | null;
};

const GRACE_MS = 60_000;

const scans = new Map<string, ScanState>();
const events = new EventEmitter();

let activeScanId: string | null = null;

/** Register a fresh scan and return its mutable in-memory state. At most one scan may be active at a time; throws a `PRECONDITION_FAILED` GraphQL error when another scan is in progress. */
export function createScan(): ScanState {
  if (activeScanId !== null) {
    throw Object.assign(new Error(`Scan already in progress`), {
      extensions: { code: 'PRECONDITION_FAILED' },
    });
  }
  const state: ScanState = {
    id: uuidv4(),
    filesTotal: null,
    scannedTotal: 0,
    errorsTotal: 0,
    errors: [],
    completedAt: null,
  };
  scans.set(state.id, state);
  activeScanId = state.id;
  return state;
}

/** Look up live scan state by id. Returns undefined once the grace period after completion has elapsed. */
export function getScan(id: string): ScanState | undefined {
  return scans.get(id);
}

/** Return the active scan if one is in progress, otherwise the most recent scan still within its post-completion grace period. Returns undefined when neither exists. */
export function getLatestScan(): ScanState | undefined {
  if (activeScanId !== null) return scans.get(activeScanId) ?? undefined;
  let latest: ScanState | undefined;
  for (const state of scans.values()) {
    if (state.completedAt == null) continue;
    if (!latest || (state.completedAt ?? 0) > (latest.completedAt ?? 0)) {
      latest = state;
    }
  }
  return latest;
}

/** Append an error to the scan's error list and increment its error counter. No-op if the scan id is unknown. */
export function recordScanError(id: string, file: string, err: unknown): void {
  const state = scans.get(id);
  if (!state) return;
  state.errorsTotal += 1;
  state.errors.push({
    err,
    file,
    message: err instanceof Error ? err.message : String(err),
  });
}

/** Mark the scan finished and schedule its eviction from memory after a grace period. */
export function completeScan(id: string): void {
  const state = scans.get(id);
  if (!state) return;
  state.completedAt = Date.now();
  if (activeScanId === id) activeScanId = null;
  notifyScanUpdate(id);
  setTimeout(() => {
    scans.delete(id);
  }, GRACE_MS).unref();
}

/** Notify subscribers that the named scan's state has changed (filesTotal discovered, progress, completion). */
export function notifyScanUpdate(id: string): void {
  events.emit(id);
}

/** Subscribe to update events for a single scan. Returns an unsubscribe function. */
export function onScanUpdate(id: string, listener: () => void): () => void {
  events.on(id, listener);
  return () => events.off(id, listener);
}
