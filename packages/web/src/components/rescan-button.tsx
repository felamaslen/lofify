import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readFragment, type ResultOf } from 'gql.tada';
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { subscribe } from '../lib/sse-client.ts';
import { ScanErrorsDialog } from './scan-errors-dialog.tsx';
import { Button } from './ui/button.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const LibraryScanErrorCountDocument = graphql(`
  query LibraryScanErrorCount {
    libraryScanErrors(first: 0) {
      totalCount
    }
  }
`);

const LibraryScanProgressDocument = graphql(`
  fragment LibraryScanProgress on LibraryScan {
    id
    filesTotal
    scannedTotal
    errorsTotal
    isCompleted
  }
`);

const LibraryScanCurrentDocument = graphql(
  `
    query LibraryScanCurrent {
      libraryScan {
        ...LibraryScanProgress
      }
    }
  `,
  [LibraryScanProgressDocument],
);

const CancelLibraryScanDocument = graphql(`
  mutation CancelLibraryScan($id: ID!) {
    libraryScanCancel(id: $id) {
      _
    }
  }
`);

const StartLibraryScanDocument = graphql(
  `
    mutation StartLibraryScan($force: Boolean) {
      libraryScanStart(force: $force) {
        ...LibraryScanProgress
      }
    }
  `,
  [LibraryScanProgressDocument],
);

const LibraryScanDocument = graphql(
  `
    subscription LibraryScan($id: ID!) {
      libraryScan(id: $id) {
        ...LibraryScanProgress
      }
    }
  `,
  [LibraryScanProgressDocument],
);

type Snapshot = ResultOf<typeof LibraryScanProgressDocument>;

type Phase = 'idle' | 'indeterminate' | 'determinate' | 'completed';

const phases = [
  { phase: 'idle', minHoldTimeMs: 0 },
  { phase: 'indeterminate', minHoldTimeMs: 1000 },
  { phase: 'determinate', minHoldTimeMs: 2000 },
  { phase: 'completed', minHoldTimeMs: 0 },
] satisfies {
  phase: Phase;
  minHoldTimeMs: number;
}[];

function percentOf(scan: Snapshot): number | null {
  if (scan.filesTotal == null) return null;
  const denom = scan.filesTotal - scan.errorsTotal;
  if (denom <= 0) return scan.isCompleted ? 100 : 0;
  return Math.min(100, Math.round((scan.scannedTotal / denom) * 100));
}

export function RescanButton() {
  const queryClient = useQueryClient();
  const [errorsOpen, setErrorsOpen] = useState(false);
  const errorCountQuery = useQuery({
    queryKey: ['libraryScanErrors', 'count'],
    queryFn: ({ signal }) => gqlRequest(LibraryScanErrorCountDocument, {}, signal),
  });
  const errorCount = errorCountQuery.data?.libraryScanErrors?.totalCount ?? 0;
  const [scan, setScan] = useState<Snapshot | null>(null);
  const [force, setForce] = useState(false);
  const timer = useRef(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const animatedPhase = useRef(phase);
  const phaseEnteredAt = useRef(0);
  const setScanAndDesiredPhase = useCallback((data: Snapshot | null) => {
    const desiredPhase: Phase = data?.isCompleted
      ? 'completed'
      : data?.filesTotal === null
        ? 'indeterminate'
        : data
          ? 'determinate'
          : 'idle';
    const animateToNextPhase = () => {
      const phaseDefIndex = phases.findIndex((p) => p.phase === animatedPhase.current);
      const desiredPhaseDefIndex = phases.findIndex((p) => p.phase === desiredPhase);
      const minHoldTimeMs = phases[phaseDefIndex]?.minHoldTimeMs;
      const nextPhase = phases[phaseDefIndex + 1]?.phase;
      if (minHoldTimeMs && nextPhase && phaseDefIndex < desiredPhaseDefIndex) {
        const delay = Math.max(0, minHoldTimeMs - (Date.now() - phaseEnteredAt.current));
        timer.current = setTimeout(() => {
          phaseEnteredAt.current = Date.now();
          setPhase(nextPhase);
          animatedPhase.current = nextPhase;
          if (nextPhase !== desiredPhase) animateToNextPhase();
        }, delay);
      } else {
        clearTimeout(timer.current);
        phaseEnteredAt.current = Date.now();
        setPhase(desiredPhase);
        animatedPhase.current = desiredPhase;
      }
    };
    setScan(data);
    animateToNextPhase();
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const attachSubscription = useCallback(
    (id: string) => {
      unsubRef.current?.();
      unsubRef.current = subscribe(
        LibraryScanDocument,
        { id },
        {
          next: (data) =>
            setScanAndDesiredPhase(
              data.libraryScan ? readFragment(LibraryScanProgressDocument, data.libraryScan) : null,
            ),
          error: () => {
            unsubRef.current = null;
          },
          complete: () => {
            unsubRef.current = null;
            // A finished scan can change any track data anywhere; invalidate everything
            // (the previous ['tracks'] key matched no query at all, so the list never refreshed).
            void queryClient.invalidateQueries();
          },
        },
      );
    },
    [queryClient],
  );
  useQuery({
    queryKey: ['libraryScan', 'current'],
    queryFn: async ({ signal }) => {
      const res = await gqlRequest(LibraryScanCurrentDocument, {}, signal);
      const current = readFragment(LibraryScanProgressDocument, res.libraryScan);
      setScanAndDesiredPhase(current ?? null);
      if (current && !current.isCompleted && !unsubRef.current) {
        attachSubscription(current.id);
      }
      return current ?? null;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const unsubRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      unsubRef.current?.();
      unsubRef.current = null;
      clearTimeout(timer.current);
    },
    [],
  );

  const cancel = useCallback(async () => {
    if (!scan || scan.isCompleted) return;
    try {
      await gqlRequest(CancelLibraryScanDocument, { id: scan.id });
    } catch (err) {
      console.error('library scan failed to cancel', err);
    }
  }, [scan]);

  const start = useCallback(
    async (force: boolean) => {
      if (unsubRef.current || phase === 'indeterminate' || phase === 'determinate') return;
      try {
        const res = await gqlRequest(StartLibraryScanDocument, { force });
        const initial = readFragment(LibraryScanProgressDocument, res.libraryScanStart);
        setScan(initial);
        attachSubscription(initial.id);
      } catch (err) {
        console.error('library scan failed to start', err);
      }
    },
    [attachSubscription, phase],
  );

  const showProgress = phase === 'indeterminate' || phase === 'determinate';
  const percent = scan ? percentOf(scan) : null;
  const fillPercent = phase === 'indeterminate' ? 60 : (percent ?? 0);
  const disabled = showProgress;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {errorCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setErrorsOpen(true)}
                  className="text-amber-600 dark:text-amber-500"
                >
                  <AlertTriangle />
                  {errorCount}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Review {errorCount} scan error{errorCount === 1 ? '' : 's'}
              </TooltipContent>
            </Tooltip>
          )}
          <div className="group relative">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => start(force)}
              disabled={disabled}
              className="relative isolate overflow-hidden min-w-[180px] w-full"
            >
              {showProgress &&
                (phase === 'indeterminate' ? (
                  <span
                    aria-hidden
                    className="absolute inset-0 -z-10 animate-progress-stripe"
                    style={{
                      backgroundImage:
                        'repeating-linear-gradient(45deg, hsl(var(--primary) / 0.3) 0 8px, hsl(var(--primary) / 0.1) 8px 16px)',
                      backgroundSize: '24px 24px',
                    }}
                  />
                ) : (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 -z-10 bg-primary/25 transition-[width]"
                    style={{ width: `${fillPercent}%` }}
                  />
                ))}
              {showProgress ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              <span className="relative">
                {phase === 'determinate' && scan && scan.filesTotal != null
                  ? `Scanning ${scan.scannedTotal} / ${scan.filesTotal}`
                  : phase === 'indeterminate'
                    ? 'Scanning…'
                    : 'Rescan library'}
              </span>
            </Button>
            {showProgress && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={cancel}
                    aria-label="Cancel scan"
                    className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded-sm text-foreground/70 hover:text-foreground hover:bg-foreground/10 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
                  >
                    <X />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Cancel scan</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={force}
            disabled={disabled}
            onChange={(e) => setForce(e.target.checked)}
            className="h-3.5 w-3.5 accent-primary disabled:opacity-50"
          />
          Re-read every file (slower) — backfills newly captured details
        </label>
      </div>
      <ScanErrorsDialog open={errorsOpen} onOpenChange={setErrorsOpen} />
    </TooltipProvider>
  );
}
