import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

/** Whether the main view shows the audio visualiser in place of the track list. Ephemeral (not persisted): a transient view mode, not a saved preference. Only ever set on desktop — the toggle is hidden on touch devices because the visualiser's Web Audio tap would risk silencing locked-screen playback. */
type VisualiserContextValue = {
  active: boolean;
  setActive: (value: boolean) => void;
  toggle: () => void;
};

const Ctx = createContext<VisualiserContextValue | null>(null);

export function VisualiserProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);

  const value = useMemo<VisualiserContextValue>(
    () => ({ active, setActive, toggle: () => setActive((v) => !v) }),
    [active],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVisualiser() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useVisualiser must be inside <VisualiserProvider>');
  return ctx;
}
