import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResultOf } from 'gql.tada';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { subscribe } from '../lib/sse-client.ts';
import { Button } from './ui/button.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const LibraryScanQuery = graphql(`
  query LibraryScanCurrent {
    libraryScan {
      id
      filesTotal
      scannedTotal
      errorsTotal
      isCompleted
      errorMessage
    }
  }
`);

const StartLibraryScanMutation = graphql(`
  mutation StartLibraryScan {
    libraryScanStart {
      id
      filesTotal
      scannedTotal
      errorsTotal
      isCompleted
      errorMessage
    }
  }
`);

const LibraryScanSubscription = graphql(`
  subscription LibraryScan($id: ID!) {
    libraryScan(id: $id) {
      id
      filesTotal
      scannedTotal
      errorsTotal
      isCompleted
      errorMessage
    }
  }
`);

type Snapshot = ResultOf<typeof LibraryScanSubscription>['libraryScan'];

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
  const [scan, setScan] = useState<Snapshot | null>(null);
  const timer = useRef(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const animatedPhase = useRef(phase);
  const phaseEnteredAt = useRef(0);
  const setScanAndDesiredPhase = useCallback(
    (data: ResultOf<typeof LibraryScanQuery>['libraryScan']) => {
      const desiredPhase: Phase = data?.isCompleted
        ? 'completed'
        : data?.filesTotal == null
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
    },
    [],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  const attachSubscription = useCallback(
    (id: string) => {
      unsubRef.current?.();
      unsubRef.current = subscribe(
        LibraryScanSubscription,
        { id },
        {
          next: (data) => setScanAndDesiredPhase(data.libraryScan),
          error: () => {
            unsubRef.current = null;
          },
          complete: () => {
            unsubRef.current = null;
            void queryClient.invalidateQueries({ queryKey: ['tracks'] });
          },
        },
      );
    },
    [queryClient],
  );
  useQuery({
    queryKey: ['libraryScan', 'current'],
    queryFn: async ({ signal }) => {
      const res = await gqlRequest(LibraryScanQuery, {}, signal);
      const current = res.libraryScan;
      if (current) {
        setScanAndDesiredPhase(current);
        if (!current.isCompleted && !unsubRef.current) {
          attachSubscription(current.id);
        }
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

  const start = useCallback(async () => {
    if (unsubRef.current || phase === 'indeterminate' || phase === 'determinate') return;
    try {
      const res = await gqlRequest(StartLibraryScanMutation, {});
      const initial = res.libraryScanStart;
      setScan(initial);
      attachSubscription(initial.id);
    } catch (err) {
      console.error('library scan failed to start', err);
    }
  }, [attachSubscription, phase]);

  const showProgress = phase === 'indeterminate' || phase === 'determinate';
  const percent = scan ? percentOf(scan) : null;
  const fillPercent = phase === 'indeterminate' ? 60 : (percent ?? 0);
  const disabled = showProgress;
  const showWarning = scan != null && scan.errorsTotal > 0;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex items-center gap-2">
        {showWarning && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="img"
                aria-label="scan errors"
                className="inline-flex h-5 w-5 items-center justify-center text-yellow-500"
              >
                <AlertTriangle className="h-5 w-5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{scan?.errorMessage ?? 'Scan errors'}</TooltipContent>
          </Tooltip>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={start}
          disabled={disabled}
          className="relative isolate overflow-hidden min-w-[180px]"
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
      </div>
    </TooltipProvider>
  );
}
