import * as SliderPrimitive from '@radix-ui/react-slider';
import * as React from 'react';

import { cn } from '../../lib/utils.ts';

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  /** Ranges drawn slightly darker behind the active range — e.g. "I've downloaded these seconds". Same units as `min`/`max`. */
  bufferedRanges?: ReadonlyArray<{ start: number; end: number }>;
  /** Start of a "pending / not yet available" region drawn as diagonal stripes from this value to `max`. Used to indicate the un-encoded tail of a transcoded track. Same units as `min`/`max`. */
  pendingStart?: number;
};

export const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
  ({ className, bufferedRanges, pendingStart, min = 0, max = 100, ...props }, ref) => {
    const lo = min as number;
    const hi = max as number;
    const span = hi - lo || 1;
    const pct = (v: number): string => (((v - lo) / span) * 100).toFixed(3);
    return (
      <SliderPrimitive.Root
        ref={ref}
        min={min}
        max={max}
        className={cn(
          'group relative flex w-full touch-none select-none items-center max-sm:items-end',
          className,
        )}
        {...props}
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary cursor-pointer max-sm:rounded-none">
          {pendingStart != null && pendingStart < hi && (
            <div
              className="lofify-pending-stripes pointer-events-none absolute h-full cursor-not-allowed"
              style={{
                left: `${pct(Math.max(pendingStart, lo))}%`,
                width: `${(((hi - Math.max(pendingStart, lo)) / span) * 100).toFixed(3)}%`,
                color: 'var(--muted-foreground, currentColor)',
              }}
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
        <SliderPrimitive.Thumb className="block h-3 w-3 cursor-pointer rounded-full bg-white opacity-0 shadow outline-none transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-0 max-sm:h-2.5 max-sm:w-1.5 max-sm:rounded-none max-sm:rounded-t-sm max-sm:opacity-100" />
      </SliderPrimitive.Root>
    );
  },
);
Slider.displayName = SliderPrimitive.Root.displayName;
