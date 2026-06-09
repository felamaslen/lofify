import { type PointerEvent, useMemo, useRef } from 'react';

import { cn } from '../lib/utils.ts';

/** Fixed A–Z index. `#` collects everything non-alphabetic (digits, symbols, non-Latin, untagged), matching the backend bucketing. */
const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

export type Bucket = { label: string; offset: number };

/**
 * Vertical A–Z scrubber pinned to the right edge. Highlights the bucket the list is currently scrolled to and, on tap or drag (mouse or touch), jumps to the track index where a letter's bucket begins. Letters with no tracks are dimmed and snap to the next populated bucket.
 */
export function LetterScrubber({
  buckets,
  activeLabel,
  top,
  onJump,
}: {
  buckets: Bucket[];
  activeLabel: string | null;
  /** Distance from the viewport top to start the strip, so it clears the sticky header(s). */
  top: number;
  onJump: (offset: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const byLabel = useMemo(() => new Map(buckets.map((b) => [b.label, b.offset])), [buckets]);

  const jumpToLabel = (label: string) => {
    const exact = byLabel.get(label);
    if (exact != null) {
      onJump(exact);
      return;
    }
    // No tracks under this letter — snap to the next populated bucket, or the last one.
    const idx = LETTERS.indexOf(label);
    const next = buckets.find((b) => LETTERS.indexOf(b.label) >= idx) ?? buckets.at(-1);
    if (next) onJump(next.offset);
  };

  const labelAt = (clientY: number): string | null => {
    const el = ref.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const fraction = (clientY - rect.top) / rect.height;
    const i = Math.min(LETTERS.length - 1, Math.max(0, Math.floor(fraction * LETTERS.length)));
    return LETTERS[i] ?? null;
  };

  const handle = (e: PointerEvent) => {
    const label = labelAt(e.clientY);
    if (label) jumpToLabel(label);
  };

  return (
    <div
      ref={ref}
      aria-hidden
      style={{ top }}
      className="fixed bottom-28 right-3 z-20 flex w-6 touch-none select-none flex-col items-center justify-between py-1 mix-blend-difference"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        handle(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 0) handle(e);
      }}
    >
      {LETTERS.map((label) => (
        <span
          key={label}
          className={cn(
            'text-[9px] leading-none tabular-nums transition-colors',
            byLabel.has(label) ? 'cursor-pointer text-white/80' : 'text-white/30',
            activeLabel === label && 'font-bold text-white',
          )}
        >
          {label}
        </span>
      ))}
    </div>
  );
}
