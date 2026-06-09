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
    />
  );
}
