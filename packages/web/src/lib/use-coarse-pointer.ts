import { useSyncExternalStore } from 'react';

// Touchscreens report `(hover: none)`: there's no hover state, so hover-only UI
// (Radix tooltips) never opens and a tap is needed instead.
const QUERY = '(hover: none)';

// One shared MediaQueryList for the whole app — every hook subscribes to and
// reads from the same instance rather than spinning up a new matcher each call.
const mql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY) : null;

function subscribe(callback: () => void): () => void {
  if (!mql) return () => {};
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

function getSnapshot(): boolean {
  return mql?.matches ?? false;
}

/** True on coarse-pointer / no-hover devices (touchscreens), where hover-triggered UI like tooltips can't open and a tap target is needed instead. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
