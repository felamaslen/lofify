import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { useCoarsePointer } from '../../lib/use-coarse-pointer.ts';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.tsx';

type Side = ComponentPropsWithoutRef<typeof TooltipContent>['side'];

/** A short informational bubble anchored to `children`. On pointer devices it's a hover tooltip; on touchscreens (where hover never fires) it becomes a tap-to-open popover, styled to match. The child is the trigger and must accept a ref (use `asChild`-friendly elements). */
export function Hint({
  content,
  side = 'top',
  children,
}: {
  content: ReactNode;
  side?: Side;
  children: ReactNode;
}) {
  const coarse = useCoarsePointer();

  if (coarse) {
    return (
      <Popover>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent
          side={side}
          className="w-auto max-w-[min(18rem,calc(100vw-1rem))] border-0 px-3 py-1.5 text-xs"
        >
          {content}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
