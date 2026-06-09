import { Toaster as SonnerToaster } from 'sonner';

import { useTheme } from '../../state/theme.tsx';

/**
 * App-themed [sonner](https://sonner.emilkowal.ski/) toaster: follows the colour-scheme preference and is offset to clear the sticky playback bar. Mounted once near the app root; toasts are fired imperatively via sonner's `toast` API (e.g. `toast.error(...)` from the player).
 */
export function Toaster() {
  const { theme } = useTheme();
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      richColors
      closeButton
      offset={{ bottom: '6rem', right: '1.5rem' }}
      mobileOffset={{ bottom: '6rem', right: '1rem' }}
      toastOptions={{
        // Sonner lays an action inline to the right of the text. Re-lay the toast as a two-column
        // grid — [icon | text] on the first row — so the action drops onto its own row beneath the
        // text (right-aligned) instead of crowding it. Toasts without an action are unaffected.
        classNames: {
          toast: '!grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5',
          content: 'col-start-2 row-start-1',
          actionButton: '!ml-0 col-start-2 justify-self-end',
        },
      }}
    />
  );
}
