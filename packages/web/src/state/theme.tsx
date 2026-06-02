import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

/** Colour-scheme preference. `system` follows the browser's `prefers-color-scheme`; `light` and `dark` pin a scheme regardless. Persisted in `localStorage`; defaults to `system`. */
export type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'lofify.app.theme';

/** Background colours mirroring `--background` in each scheme, used for the `theme-color` meta tag so the mobile browser chrome matches the page. */
const THEME_COLOUR = { dark: '#0f1115', light: '#ffffff' } as const;

function readStored(): Theme {
  if (typeof window === 'undefined') return 'system';
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveDark(theme: Theme): boolean {
  return theme === 'dark' || (theme === 'system' && prefersDark());
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const dark = resolveDark(theme);
  document.documentElement.classList.toggle('dark', dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? THEME_COLOUR.dark : THEME_COLOUR.light);
}

type ThemeContextValue = {
  theme: Theme;
  setTheme: (value: Theme) => void;
};

const Ctx = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setState] = useState(readStored);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: (next) => {
        if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next);
        setState(next);
      },
    }),
    [theme],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme must be inside <ThemeProvider>');
  return ctx;
}
