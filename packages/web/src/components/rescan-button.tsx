import { useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ResultOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import {
  LibraryScanSubscription,
  StartLibraryScanMutation,
} from '../lib/queries.ts';
import { subscribe } from '../lib/sse-client.ts';
import { Button } from './ui/button.tsx';
import { Progress } from './ui/progress.tsx';

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
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={start}
        disabled={busy}
      >
        {busy ? (
          <Loader2 className="animate-spin" />
        ) : (
          <RefreshCw />
        )}
        {busy ? 'Scanning…' : 'Rescan library'}
      </Button>
      {scan && (
        <div className="flex w-[220px] flex-col gap-1">
          <Progress
            value={percent ?? 0}
            {...(indeterminate ? { indeterminate: true } : {})}
          />
          <span className="text-center text-xs tabular-nums text-muted-foreground">
            {scan.scannedTotal}
            {scan.filesTotal != null ? ` / ${scan.filesTotal}` : ''}
            {scan.errorsTotal > 0 ? ` (${scan.errorsTotal} errors)` : ''}
          </span>
        </div>
      )}
    </div>
  );
}
