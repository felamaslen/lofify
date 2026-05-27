import { useSyncExternalStore } from 'react';

// 639.98px is what Tailwind compiles `max-sm:` to (640px sm breakpoint minus
// 0.02px, so it never overlaps `min-width: 640px` at fractional pixels). Match
// it so this hook flips at the exact same width as the `max-sm:` CSS classes.
const QUERY = '(max-width: 639.98px)';

// Lazily created once and shared across every consumer — matchMedia returns a
// live object, so there's no reason to mint a new one per subscribe/snapshot.
let mql: MediaQueryList | undefined;
function getMql(): MediaQueryList {
  return (mql ??= window.matchMedia(QUERY));
}

function subscribe(onChange: () => void): () => void {
  const mq = getMql();
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return getMql().matches;
}

/**
 * `true` while the viewport is at or below the Tailwind `sm` breakpoint
 * (640px), kept in sync with `matchMedia`.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
