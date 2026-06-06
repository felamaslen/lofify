/** The id of the server-held play queue this device works with. Only the id lives here (localStorage, so a refresh keeps the queue) — the queue's contents stay on the server and are read through `Query.playbackQueue`. */
const STORAGE_KEY = 'lofify.player.queue-id';

/** Live read of the stored queue id, or null when this device hasn't created one. Passed as the `id` to `Query.playbackQueue` and the queue mutations. */
export function queueIdValue(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

/** Persist the queue id carried by a mutation response. Mutations materialise the queue lazily, so every response's id is stored — it only ever changes when the first append of a session creates a fresh queue. */
export function rememberQueueId(id: string | null): void {
  if (typeof window === 'undefined' || id == null) return;
  window.localStorage.setItem(STORAGE_KEY, id);
}
