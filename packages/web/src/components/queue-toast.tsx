import { ListPlus } from 'lucide-react';
import { useEffect, useState } from 'react';

const AUTO_DISMISS_MS = 2000;

type Toast = { text: string; key: number };

let emit: ((text: string) => void) | null = null;
let nextKey = 0;

/** Show a transient enqueue confirmation. Module-level so non-React callers (the enqueue helper) can announce; a no-op when the outlet isn't mounted. */
export function showQueueToast(text: string): void {
  emit?.(text);
}

/** Top-centred confirmation toast that slides in on each announcement and auto-dismisses. Keyed per announcement so a repeat of the same text re-runs the entry animation. */
export function QueueToast() {
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    emit = (text) => setToast({ text, key: nextKey++ });
    return () => {
      emit = null;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const handle = window.setTimeout(() => setToast(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(handle);
  }, [toast]);

  if (!toast) return null;
  return (
    // Centred by the wrapper's flex rather than a translate on the toast itself: the entry
    // animation owns the transform property for its duration and would override (then snap back
    // to) a static -translate-x-1/2, walking the toast in from off-centre.
    <div className="pointer-events-none fixed inset-x-0 top-14 z-50 flex justify-center">
      <div
        key={toast.key}
        role="status"
        className="flex items-center gap-2 rounded-md border border-border bg-card/90 px-3 py-2 text-sm shadow-lg backdrop-blur animate-in fade-in slide-in-from-top-2 duration-200"
      >
        <ListPlus className="size-4 text-primary" />
        {toast.text}
      </div>
    </div>
  );
}
