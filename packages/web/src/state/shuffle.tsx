import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

/** Whether playback traverses the library in a seeded-random order instead of the library sort. The toggle persists in `localStorage`; the order itself (seed + the track it starts from) lives in the URL, so a refresh resumes the exact same sequence. */
const STORAGE_KEY = 'lofify.player.shuffle';
const SEED_PARAM = 'shuffle-seed';
const FROM_PARAM = 'shuffle-from';

function readEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STORAGE_KEY) === 'true';
}

/** Mirror the shuffle order into the URL (`replaceState`, merging the params the player and filter own). Null values clear their param. */
function writeShuffleToUrl(seed: string | null, from: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (seed) url.searchParams.set(SEED_PARAM, seed);
  else url.searchParams.delete(SEED_PARAM);
  if (from) url.searchParams.set(FROM_PARAM, from);
  else url.searchParams.delete(FROM_PARAM);
  window.history.replaceState(window.history.state, '', url);
}

/** The active shuffle order as `Query.tracks` variables, read live for non-React consumers (the player's next/prev resolution). Nulls when shuffle is off. When shuffle is on but the URL carries no seed (a clean URL), a fresh seed is written back, preserving the invariant enabled ⇒ seed. */
export function shuffleVars(): {
  shuffleSeed: string | null;
  shuffleInitialTrackId: string | null;
} {
  if (!readEnabled()) return { shuffleSeed: null, shuffleInitialTrackId: null };
  const params = new URLSearchParams(window.location.search);
  let seed = params.get(SEED_PARAM);
  const from = params.get(FROM_PARAM);
  if (!seed) {
    seed = crypto.randomUUID();
    writeShuffleToUrl(seed, from);
  }
  return { shuffleSeed: seed, shuffleInitialTrackId: from };
}

/** Re-anchor the shuffled order at `trackId` with a fresh seed — call on every user-initiated play. Keeping the old seed would restart the same permutation from the top and replay the just-played sequence verbatim, so a manual selection starts a new one. No-op when shuffle is off, so callers needn't check. */
export function reanchorShuffle(trackId: string): void {
  if (!readEnabled()) return;
  writeShuffleToUrl(crypto.randomUUID(), trackId);
}

type ShuffleContextValue = {
  enabled: boolean;
  /** Toggle shuffle. Turning it on anchors a fresh order at the playing track (pass `null` when nothing is playing — the first manual play anchors instead); turning it off clears the order from the URL. */
  toggle: (currentTrackId: string | null) => void;
};

const Ctx = createContext<ShuffleContextValue | null>(null);

export function ShuffleProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(readEnabled);

  const value = useMemo<ShuffleContextValue>(
    () => ({
      enabled,
      toggle: (currentTrackId) => {
        const next = !enabled;
        if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, String(next));
        if (next) writeShuffleToUrl(crypto.randomUUID(), currentTrackId);
        else writeShuffleToUrl(null, null);
        setEnabled(next);
      },
    }),
    [enabled],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShuffle() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useShuffle must be inside <ShuffleProvider>');
  return ctx;
}
