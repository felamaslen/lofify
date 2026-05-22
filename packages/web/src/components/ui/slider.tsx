import * as SliderPrimitive from '@radix-ui/react-slider';
import * as React from 'react';

import { cn } from '../../lib/utils.ts';

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  /** Range drawn as a pale wash behind everything else — e.g. "the server has these seconds ready to serve". */
  availableEnd?: number;
  /** Ranges drawn slightly darker on top of `availableEnd` — e.g. "I've downloaded these seconds". Same units as `min`/`max`. */
  bufferedRanges?: ReadonlyArray<{ start: number; end: number }>;
};

export const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
  ({ className, availableEnd, bufferedRanges, min = 0, max = 100, ...props }, ref) => {
    const lo = min as number;
    const hi = max as number;
    const span = hi - lo || 1;
    const pct = (v: number): string => (((v - lo) / span) * 100).toFixed(3);
    return (
      <SliderPrimitive.Root
        ref={ref}
        min={min}
        max={max}
        className={cn('relative flex w-full touch-none select-none items-center', className)}
        {...props}
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
          {availableEnd != null && availableEnd > lo && (
            <div
              className="pointer-events-none absolute h-full bg-primary/15"
              style={{ left: `0%`, width: `${pct(Math.min(availableEnd, hi))}%` }}
            />
          )}
          {bufferedRanges?.map((r, i) => (
            <div
              key={i}
              className="absolute h-full bg-primary/35 cursor-pointer"
              style={{
                left: `${pct(r.start)}%`,
                width: `${(((r.end - r.start) / span) * 100).toFixed(3)}%`,
              }}
            />
          ))}
          <SliderPrimitive.Range className="absolute cursor-pointer h-full bg-primary" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="cursor-pointer block h-4 w-4 rounded-full border border-primary/60 bg-primary shadow-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50" />
      </SliderPrimitive.Root>
    );
  },
);
Slider.displayName = SliderPrimitive.Root.displayName;
