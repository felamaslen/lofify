import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { gqlRequest } from '../lib/gql-request.ts';
import {
  LibraryScanSubscription,
  StartLibraryScanMutation,
} from '../lib/queries.ts';
import { subscribe } from '../lib/sse-client.ts';
import type { ResultOf } from '../lib/gql.ts';

type Snapshot = ResultOf<typeof LibraryScanSubscription>['libraryScan'];

export function RescanButton() {
  const queryClient = useQueryClient();
  const [scan, setScan] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      unsubRef.current?.();
      unsubRef.current = null;
    },
    [],
  );

  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await gqlRequest(StartLibraryScanMutation, {});
      const initial = res.libraryScan;
      setScan(initial);
      unsubRef.current?.();
      unsubRef.current = subscribe(
        LibraryScanSubscription,
        { id: initial.id },
        {
          next: (data) => setScan(data.libraryScan),
          error: () => {
            setBusy(false);
            unsubRef.current = null;
          },
          complete: () => {
            setBusy(false);
            unsubRef.current = null;
            void queryClient.invalidateQueries({ queryKey: ['tracks'] });
          },
        },
      );
    } catch (err) {
      console.error('library scan failed to start', err);
      setBusy(false);
    }
  }, [busy, queryClient]);

  const percent =
    scan && scan.filesTotal && scan.filesTotal > 0
      ? Math.min(100, Math.round((scan.scannedTotal / scan.filesTotal) * 100))
      : null;
  const indeterminate = busy && percent === null;

  return (
    <div className="rescan">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="rescan-button"
      >
        {busy ? 'Scanning…' : 'Rescan library'}
      </button>
      {scan && (
        <div
          className={`rescan-progress${indeterminate ? ' is-indeterminate' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent != null ? { 'aria-valuenow': percent } : {})}
        >
          <div
            className="rescan-progress-fill"
            style={percent != null ? { width: `${percent}%` } : undefined}
          />
          <span className="rescan-progress-label">
            {scan.scannedTotal}
            {scan.filesTotal != null ? ` / ${scan.filesTotal}` : ''}
            {scan.errorsTotal > 0 ? ` (${scan.errorsTotal} errors)` : ''}
          </span>
        </div>
      )}
    </div>
  );
}
