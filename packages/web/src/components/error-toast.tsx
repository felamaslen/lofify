import { X } from 'lucide-react';
import { useEffect } from 'react';

import { usePlayer } from '../state/player.tsx';
import { Button } from './ui/button.tsx';

const AUTO_DISMISS_MS = 6000;

export function ErrorToast() {
  const { error, dismissError } = usePlayer();
  useEffect(() => {
    if (!error) return;
    const handle = window.setTimeout(dismissError, AUTO_DISMISS_MS);
    return () => window.clearTimeout(handle);
  }, [error, dismissError]);
  if (!error) return null;
  return (
    <div
      role="alert"
      className="pointer-events-auto fixed bottom-24 right-6 z-50 flex max-w-sm items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground shadow-lg backdrop-blur"
    >
      <span className="flex-1">{error.message}</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={dismissError}
        aria-label="Dismiss"
      >
        <X />
      </Button>
    </div>
  );
}
