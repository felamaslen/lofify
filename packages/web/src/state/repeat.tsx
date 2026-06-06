import { useState } from 'react';

import { playOrderChanged } from './play-order.ts';

/** Whether playback cycles the whole (possibly shuffled, filtered) order instead of stopping at its end. Persisted in `localStorage`; defaults to off. */
const STORAGE_KEY = 'lofify.player.repeat';

function readStored(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STORAGE_KEY) === 'true';
}

/** Live read of the setting, for non-React consumers (the player's stepping and `ended` handling) that must honour it without subscribing. Returns the GraphQL `repeat` value to pass. */
export function repeatValue(): boolean {
  return readStored();
}

/** The repeat toggle for the playback bar. A plain hook, not a context — the button is the only React consumer (the player reads `repeatValue()` live), so there is no second subscriber to keep in sync. */
export function useRepeat() {
  const [enabled, setEnabled] = useState(readStored);
  return {
    enabled,
    toggle: () => {
      const next = !enabled;
      if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, String(next));
      setEnabled(next);
      playOrderChanged();
    },
  };
}
