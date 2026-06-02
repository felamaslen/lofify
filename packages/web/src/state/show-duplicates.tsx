import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

/** Whether the library shows every duplicate copy of a recording, or only the canonical (highest-quality) one. Persisted in `localStorage`; defaults to off. */
const STORAGE_KEY = 'lofify.library.show-duplicates';

function readStored(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STORAGE_KEY) === 'true';
}

/** Live read of the setting, for non-React consumers (the player's next/prev resolution) that must honour it without subscribing to the context. Returns the GraphQL `includeDuplicates` value to pass. */
export function showDuplicatesValue(): boolean {
  return readStored();
}

type ShowDuplicatesContextValue = {
  showDuplicates: boolean;
  setShowDuplicates: (value: boolean) => void;
};

const Ctx = createContext<ShowDuplicatesContextValue | null>(null);

export function ShowDuplicatesProvider({ children }: { children: ReactNode }) {
  const [showDuplicates, setState] = useState(readStored);

  const value = useMemo<ShowDuplicatesContextValue>(
    () => ({
      showDuplicates,
      setShowDuplicates: (next) => {
        if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, String(next));
        setState(next);
      },
    }),
    [showDuplicates],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShowDuplicates() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useShowDuplicates must be inside <ShowDuplicatesProvider>');
  return ctx;
}
