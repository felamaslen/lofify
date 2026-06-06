/** Change notifications for the inputs that define the play order: library filter, duplicate visibility, shuffle, repeat. The state modules that own those settings announce here; the player listens and drops mse's prefetched successor so the next resolution sees the new order. Plain pub/sub rather than the player importing setters (or setters importing the player — it already reads their live values, which would be a cycle). */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Register a listener for play-order changes; returns its unsubscribe. */
export function onPlayOrderChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Announce that a play-order input changed. Call from every setter that alters which track follows which. */
export function playOrderChanged(): void {
  for (const listener of listeners) listener();
}
