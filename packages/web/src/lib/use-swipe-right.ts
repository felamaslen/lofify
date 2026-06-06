import { type TouchEvent, useRef } from 'react';

/** Trigger distance, px. Far enough that a sloppy vertical scroll can't fire it. */
const TRIGGER_PX = 56;
/** A gesture is classified once it travels this far; horizontal needs to dominate by 1.5×. */
const DECIDE_PX = 8;
/** Hard cap on the row's translation — the fixed gap that opens on the left for the action icon. */
export const MAX_PULL_PX = 48;

type SwipeState = {
  id: string;
  /** The element the gesture translates: the row's `[data-swipe-content]` child. The outer row keeps its own (virtualiser) transform untouched. */
  content: HTMLElement;
  /** Optional `[data-swipe-icon]` child revealed in the opened gap, faded in with the pull. */
  icon: HTMLElement | null;
  x: number;
  y: number;
  dx: number;
  decided: boolean;
  horizontal: boolean;
};

/** Swipe-right detection for list rows: classifies the gesture as horizontal or a scroll once it has travelled a few pixels, slides the row's `[data-swipe-content]` child along (capped at `MAX_PULL_PX`, so the row never overflows a clipping container), fades in its `[data-swipe-icon]` child in the opened gap, and fires `onSwipe(id)` when released past the trigger distance. Returns a factory of per-row touch handlers; spread them only on touch layouts. */
export function useSwipeRight(onSwipe: (id: string) => void) {
  const state = useRef<SwipeState | null>(null);

  const reset = () => {
    const s = state.current;
    if (!s) return;
    s.content.style.transition = 'transform 150ms ease';
    s.content.style.transform = '';
    if (s.icon) {
      s.icon.style.transition = 'opacity 150ms ease';
      s.icon.style.opacity = '';
    }
    state.current = null;
  };

  return (id: string) => ({
    onTouchStart: (e: TouchEvent<HTMLElement>) => {
      if (e.touches.length !== 1) return;
      const content = e.currentTarget.querySelector<HTMLElement>('[data-swipe-content]');
      if (!content) return;
      const touch = e.touches[0]!;
      state.current = {
        id,
        content,
        icon: e.currentTarget.querySelector<HTMLElement>('[data-swipe-icon]'),
        x: touch.clientX,
        y: touch.clientY,
        dx: 0,
        decided: false,
        horizontal: false,
      };
    },
    onTouchMove: (e: TouchEvent<HTMLElement>) => {
      const s = state.current;
      if (!s || e.touches.length !== 1) return;
      const touch = e.touches[0]!;
      const dx = touch.clientX - s.x;
      const dy = touch.clientY - s.y;
      if (!s.decided) {
        if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
        s.decided = true;
        s.horizontal = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5;
        if (s.horizontal) {
          s.content.style.transition = 'none';
          if (s.icon) s.icon.style.transition = 'none';
        }
      }
      if (!s.horizontal) return;
      s.dx = Math.max(0, dx);
      const pull = Math.min(s.dx, MAX_PULL_PX);
      s.content.style.transform = `translateX(${pull}px)`;
      if (s.icon) s.icon.style.opacity = String(Math.min(1, pull / MAX_PULL_PX));
    },
    onTouchEnd: () => {
      const s = state.current;
      if (!s) return;
      if (s.horizontal && s.dx >= TRIGGER_PX) onSwipe(s.id);
      reset();
    },
    onTouchCancel: reset,
  });
}
