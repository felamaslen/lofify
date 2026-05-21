import { v4 as uuidv4 } from 'uuid';

export type ScanError = {
  file: string;
  message: string;
};

export type ScanState = {
  id: string;
  filesTotal: number;
  scannedTotal: number;
  errorsTotal: number;
  errors: ScanError[];
  completedAt: number | null;
};

const GRACE_MS = 60_000;

const scans = new Map<string, ScanState>();

/** Register a fresh scan and return its mutable in-memory state. */
export function createScan(): ScanState {
  const state: ScanState = {
    id: uuidv4(),
    filesTotal: 0,
    scannedTotal: 0,
    errorsTotal: 0,
    errors: [],
    completedAt: null,
  };
  scans.set(state.id, state);
  return state;
}

/** Look up live scan state by id. Returns undefined once the grace period after completion has elapsed. */
export function getScan(id: string): ScanState | undefined {
  return scans.get(id);
}

/** Append an error to the scan's error list and increment its error counter. No-op if the scan id is unknown. */
export function recordScanError(id: string, file: string, err: unknown): void {
  const state = scans.get(id);
  if (!state) return;
  state.errorsTotal += 1;
  state.errors.push({
    file,
    message: err instanceof Error ? err.message : String(err),
  });
}

/** Mark the scan finished and schedule its eviction from memory after a grace period. */
export function completeScan(id: string): void {
  const state = scans.get(id);
  if (!state) return;
  state.completedAt = Date.now();
  setTimeout(() => {
    scans.delete(id);
  }, GRACE_MS).unref();
}
