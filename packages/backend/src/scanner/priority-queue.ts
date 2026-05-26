/**
 * Async priority queue that bridges a streaming producer with a pool of async workers.
 *
 * Items are pushed with a numeric priority; higher priorities are popped first, and items of equal priority keep FIFO order. `pop()` blocks while the queue is empty but still open, so workers wait for the producer rather than busy looping; once `close()` is called and the queue drains, `pop()` returns `null` so every worker can exit.
 */
export class AsyncPriorityQueue<T> {
  private readonly buckets = new Map<number, T[]>();
  private readonly waiters: ((value: T | null) => void)[] = [];
  private closed = false;

  /** Enqueue `item` at the given priority (higher is served first). */
  push(item: T, priority: number): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    const bucket = this.buckets.get(priority);
    if (bucket) bucket.push(item);
    else this.buckets.set(priority, [item]);
  }

  /** Pop the highest-priority item, waiting if the queue is empty and open. Resolves to `null` once the queue is closed and drained. */
  pop(): Promise<T | null> {
    let bestPriority: number | undefined;
    for (const priority of this.buckets.keys()) {
      if (bestPriority === undefined || priority > bestPriority) bestPriority = priority;
    }
    if (bestPriority !== undefined) {
      const bucket = this.buckets.get(bestPriority)!;
      const item = bucket.shift()!;
      if (bucket.length === 0) this.buckets.delete(bestPriority);
      return Promise.resolve(item);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Signal that no more items will be pushed, waking any blocked `pop()` calls. */
  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!(null);
    }
  }
}
