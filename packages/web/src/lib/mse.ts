/**
 * Segmented MSE playback pipeline.
 *
 * A `Player` owns the audio element's source for the lifetime of a single track. For codecs MSE can decode, the server delivers the track as a sequence of equal-duration DASH chunks; the player fetches the chunk containing `currentTime` plus one chunk of look-ahead and appends each to a single `SourceBuffer`. The chunks come from one ffmpeg pass on the server so they're gap-less by construction — no `timestampOffset` arithmetic is needed.
 *
 * For codecs MSE can't decode (FLAC passthrough), `createPlayer` falls back to `audio.src = url` and seeks behave like the browser's default.
 */

/** Drop chunks whose end is more than this many seconds behind `currentTime`. Bounds SourceBuffer memory. */
const BEHIND_WINDOW = 30;
/** How many chunks ahead of the current one to keep loaded. One = the "play smoothly" minimum. */
const PREFETCH_AHEAD = 1;

export interface Player {
  /** Seek to `time` seconds on the track's timeline. The caller is responsible for clamping to the ready region — `setReadyChunks` advertises that bound. */
  seekTo(time: number): Promise<void>;
  /** Update the player's view of how many chunks the server has finished encoding. Used by `seekTo` to refuse seeks past the ready cursor (the server would 504 anyway, but failing fast spares the SourceBuffer churn). */
  setReadyChunks(n: number): void;
  /** Tear down: aborts in-flight fetches, ends the MediaSource, revokes the blob URL. */
  dispose(): void;
}

class DirectPlayer implements Player {
  constructor(private audio: HTMLAudioElement) {}
  async seekTo(time: number): Promise<void> {
    this.audio.currentTime = time;
  }
  setReadyChunks(): void {
    // Passthrough — the file is always available, nothing to track.
  }
  dispose(): void {
    // nothing to clean up — caller owns audio.src
  }
}

class MsePlayer implements Player {
  private disposed = false;
  private loaded = new Set<number>();
  private pending = new Map<number, AbortController>();
  private appendQueue: Array<{ segIndex: number; data: Uint8Array }> = [];
  /** Index of the segment whose `appendBuffer` is currently in flight — used to dispatch a precise `loaded` event when its `updateend` lands, rather than relying on `updateend` (which also fires for removes/multiple unrelated appends). */
  private appendingSegIndex: number | null = null;
  private endedSignalled = false;
  /** True once chunk 0 has been appended at least once — the init segment data (codec params) stays in the SourceBuffer's track config even after the buffered range gets evicted, so subsequent appends remain valid for the rest of this player's lifetime. */
  private initAppended = false;
  /** Set while a seek is awaiting its target chunk to land. `evictBehindWindow` consults this so the freshly-appended chunk for an earlier seek isn't immediately evicted by the still-stale `currentTime`. */
  private pendingSeekSegIndex: number | null = null;
  /** Fires `loaded` events with `detail: segIndex: number` after a chunk's `appendBuffer` completes (its `updateend` fires). `waitForLoaded` listens here so it gets a precise signal per chunk, decoupled from the SourceBuffer's other state transitions. */
  private events = new EventTarget();
  private readyChunks: number;

  constructor(
    private audio: HTMLAudioElement,
    private url: string,
    private mediaSource: MediaSource,
    private sourceBuffer: SourceBuffer,
    private blobUrl: string,
    private segmentCount: number,
    private segmentDuration: number,
    initialReadyChunks: number,
  ) {
    this.readyChunks = initialReadyChunks;
    sourceBuffer.addEventListener('updateend', this.onUpdateEnd);
    audio.addEventListener('timeupdate', this.onTimeUpdate);
    audio.addEventListener('seeking', this.onTimeUpdate);
    // Kick off the initial fetch — without this the player would sit idle until the first `timeupdate`, which never fires because the audio element has nothing to play.
    void this.ensureWindow();
  }

  private onUpdateEnd = (): void => {
    // The SourceBuffer can fire updateend after dispose() if the MediaSource was detached mid-append (e.g. user switched tracks). Touching `this.sourceBuffer.buffered` after detachment throws `InvalidStateError: This SourceBuffer has been removed`.
    if (this.disposed) return;
    const justAppended = this.appendingSegIndex;
    this.appendingSegIndex = null;
    if (justAppended != null) {
      this.events.dispatchEvent(new CustomEvent('loaded', { detail: justAppended }));
    }
    this.evictBehindWindow();
    this.drainAppendQueue();
    this.tryEndOfStream();
  };

  setReadyChunks(n: number): void {
    if (n <= this.readyChunks) return;
    this.readyChunks = n;
    void this.ensureWindow();
  }

  async seekTo(time: number): Promise<void> {
    if (this.disposed) return;
    const targetSeg = Math.max(0, Math.floor(time / this.segmentDuration));
    if (this.loaded.has(targetSeg)) {
      this.audio.currentTime = time;
      return;
    }
    // `ensureWindow` derives its prefetch range from `audio.currentTime`, so calling it now (before we've moved the playhead) would only refetch chunks around the OLD position. Cancel anything that isn't the target and dispatch the target fetch directly.
    for (const [seg, ctrl] of this.pending) {
      if (seg !== targetSeg) {
        ctrl.abort();
        this.pending.delete(seg);
      }
    }
    if (!this.pending.has(targetSeg)) {
      void this.fetchSegment(targetSeg);
    }
    // Tell `evictBehindWindow` to retain the seek target — otherwise the eviction triggered by the chunk's own `updateend` (which runs with `currentTime` still at the old, later position) would remove the just-appended chunk before we've moved the playhead onto it.
    this.pendingSeekSegIndex = targetSeg;
    try {
      // Don't move the playhead until the target chunk is actually appended — setting `currentTime` into an unbuffered gap leaves Chrome's audio element stalled in a "waiting" state that doesn't reliably recover when the chunk eventually lands.
      await this.waitForLoaded(targetSeg);
      if (this.disposed) return;
      // Snap to the actual buffered range. ffmpeg's DASH muxer may emit cluster timecodes a few ms off from `N * segmentDuration` (frame quantisation, source-PTS drift), so the requested `time` can land just before the chunk's real start. Without this, the audio element seeks into a sub-ms gap and stalls.
      this.audio.currentTime = time; //  this.snapToBuffered(time);
    } finally {
      this.pendingSeekSegIndex = null;
    }
  }

  private snapToBuffered(time: number): number {
    try {
      const b = this.sourceBuffer.buffered;
      for (let i = 0; i < b.length; i++) {
        const start = b.start(i);
        const end = b.end(i);
        if (time >= start && time < end) return time;
        // Snap FORWARD to the next buffered range only if `time` lands in a tiny gap just before it (sub-frame ffmpeg drift). Never snap backwards — `(0, 5.998]` should NOT pull `5.999` back to `0`, which is what a wider tolerance ends up doing when the seek target is just inside one range and the previous range happens to live within `segmentDuration` of it.
        if (time < start && start - time < 0.1) return start;
      }
    } catch {
      // SourceBuffer detached — fall through to the requested time
    }
    return time;
  }

  private waitForLoaded(segIndex: number): Promise<void> {
    if (this.loaded.has(segIndex)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onLoaded = (e: Event): void => {
        if (!(e instanceof CustomEvent) || e.detail !== segIndex) return;
        this.events.removeEventListener('loaded', onLoaded);
        resolve();
      };
      this.events.addEventListener('loaded', onLoaded);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const ctrl of this.pending.values()) ctrl.abort();
    this.pending.clear();
    this.audio.removeEventListener('timeupdate', this.onTimeUpdate);
    this.audio.removeEventListener('seeking', this.onTimeUpdate);
    try {
      this.sourceBuffer.removeEventListener('updateend', this.onUpdateEnd);
    } catch {
      // SourceBuffer may already be detached from the MediaSource
    }
    if (this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // already ended
      }
    }
    URL.revokeObjectURL(this.blobUrl);
  }

  private onTimeUpdate = (): void => {
    void this.ensureWindow();
  };

  private currentSeg(): number {
    return Math.max(0, Math.floor(this.audio.currentTime / this.segmentDuration));
  }

  private async ensureWindow(): Promise<void> {
    if (this.disposed) return;
    const start = this.currentSeg();
    const end = Math.min(this.segmentCount - 1, this.readyChunks - 1, start + PREFETCH_AHEAD);
    // Cancel fetches outside the window — they're for chunks we no longer need imminently (e.g. after a seek).
    for (const [seg, ctrl] of this.pending) {
      if (seg < start || seg > end) {
        ctrl.abort();
        this.pending.delete(seg);
      }
    }
    for (let seg = start; seg <= end; seg++) {
      if (this.loaded.has(seg)) continue;
      if (this.pending.has(seg)) continue;
      void this.fetchSegment(seg);
    }
  }

  private async fetchSegment(segIndex: number): Promise<void> {
    const ctrl = new AbortController();
    this.pending.set(segIndex, ctrl);
    try {
      const res = await fetch(`${this.url}/${segIndex}`, { signal: ctrl.signal });
      if (!res.ok) return;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (this.disposed || ctrl.signal.aborted) {
        return;
      }
      this.enqueueSegment(segIndex, buf);
    } catch {
      // network error or aborted — driver loop will retry on next tick
    } finally {
      this.pending.delete(segIndex);
    }
  }

  private enqueueSegment(segIndex: number, data: Uint8Array): void {
    if (this.loaded.has(segIndex)) return;
    this.appendQueue.push({ segIndex, data });
    this.drainAppendQueue();
  }

  /** True iff it's safe to read SourceBuffer properties — the MediaSource may have closed (e.g. detached from the audio element on track switch) at any point after construction, after which every access on the SourceBuffer throws `InvalidStateError: This SourceBuffer has been removed`. */
  private isSourceBufferLive(): boolean {
    return !this.disposed && this.mediaSource.readyState === 'open';
  }

  private drainAppendQueue(): void {
    if (!this.isSourceBufferLive() || this.appendingSegIndex != null) return;
    if (this.sourceBuffer.updating) return;
    if (this.appendQueue.length === 0) return;

    // Chunk 0 carries the init segment (`init.webm` is spliced in front of it server-side); the SourceBuffer needs that init data before any other media chunk can be appended. While we're waiting for chunk 0 to arrive for the first time, hold higher-indexed chunks in the queue — once it's appended, `initAppended` stays true forever and the rest can append in any order, even after the buffered region for chunk 0 is later evicted.
    let pickIdx = 0;
    if (!this.initAppended) {
      const zero = this.appendQueue.findIndex((item) => item.segIndex === 0);
      if (zero === -1) return;
      pickIdx = zero;
    }
    const [next] = this.appendQueue.splice(pickIdx, 1);
    if (!next) return;
    this.appendingSegIndex = next.segIndex;
    try {
      this.sourceBuffer.appendBuffer(next.data.buffer as ArrayBuffer);
      this.loaded.add(next.segIndex);
      if (next.segIndex === 0) this.initAppended = true;
    } catch (err) {
      this.appendingSegIndex = null;
      if ((err as DOMException).name === 'QuotaExceededError' && this.isSourceBufferLive()) {
        this.appendQueue.unshift(next);
        const cutoff = Math.max(0, this.audio.currentTime - 5);
        try {
          const b = this.sourceBuffer.buffered;
          if (b.length > 0 && b.start(0) < cutoff) {
            this.sourceBuffer.remove(b.start(0), cutoff);
            this.appendingSegIndex = next.segIndex; // remove()'s updateend re-runs drain
          }
        } catch {
          // invalid state — let the next updateend retry naturally
        }
      }
    }
  }

  private evictBehindWindow(): void {
    if (!this.isSourceBufferLive() || this.sourceBuffer.updating) return;
    let b: TimeRanges;
    try {
      b = this.sourceBuffer.buffered;
    } catch {
      return;
    }
    if (b.length === 0) return;
    // Cutoff is the earliest timestamp we're willing to retain. Normally that's `currentTime - 30s`, but if a seek is pending towards an earlier chunk, we have to keep that chunk too — otherwise we'd evict the very data the seek just fetched, before the audio element's playhead has had a chance to move there.
    let cutoff = this.audio.currentTime - BEHIND_WINDOW;
    if (this.pendingSeekSegIndex != null) {
      cutoff = Math.min(cutoff, this.pendingSeekSegIndex * this.segmentDuration - BEHIND_WINDOW);
    }
    if (b.start(0) >= cutoff) return;
    try {
      this.sourceBuffer.remove(b.start(0), cutoff);
      const firstKept = Math.floor(cutoff / this.segmentDuration);
      for (const seg of [...this.loaded]) {
        if (seg < firstKept) this.loaded.delete(seg);
      }
    } catch {
      // invalid state — skip; next updateend will retry
    }
  }

  private tryEndOfStream(): void {
    if (this.endedSignalled) return;
    if (this.loaded.size < this.segmentCount) return;
    if (this.appendQueue.length > 0) return;
    if (!this.isSourceBufferLive()) return;
    try {
      if (this.sourceBuffer.updating) return;
    } catch {
      return;
    }
    this.endedSignalled = true;
    try {
      this.mediaSource.endOfStream();
    } catch {
      // already ended or closing
    }
  }
}

type ProbeSegmented = {
  mode: 'segmented';
  contentType: string;
  segmentCount: number;
  segmentDuration: number;
  durationSeconds: number;
  readyChunks: number;
};
type ProbeDirect = { mode: 'direct' };

async function probe(url: string): Promise<ProbeSegmented | ProbeDirect | null> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'HEAD' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const segs = Number(res.headers.get('x-lofify-segments') ?? 0);
  if (segs > 0) {
    return {
      mode: 'segmented',
      contentType: res.headers.get('content-type') ?? '',
      segmentCount: segs,
      segmentDuration: Number(res.headers.get('x-lofify-segment-duration') ?? 6),
      durationSeconds: Number(res.headers.get('x-lofify-duration') ?? 0),
      readyChunks: Number(res.headers.get('x-lofify-ready-chunks') ?? 0),
    };
  }
  return { mode: 'direct' };
}

export async function createPlayer(audio: HTMLAudioElement, url: string): Promise<Player> {
  const meta = await probe(url);

  if (!meta || meta.mode === 'direct') {
    audio.src = url;
    return new DirectPlayer(audio);
  }

  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(meta.contentType)) {
    audio.src = url;
    return new DirectPlayer(audio);
  }

  const mediaSource = new MediaSource();
  const blobUrl = URL.createObjectURL(mediaSource);
  audio.src = blobUrl;
  await new Promise<void>((resolve) => {
    mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
  });
  // Without this, the audio element infers `duration` from the SourceBuffer's `buffered.end`, so after appending the first 6-second chunk the element thinks the track is 6 seconds long and fires `ended`.
  if (meta.durationSeconds > 0) {
    try {
      mediaSource.duration = meta.durationSeconds;
    } catch {
      // browser refused — fine, tryEndOfStream() will fire endOfStream() when all chunks are loaded.
    }
  }
  const sourceBuffer = mediaSource.addSourceBuffer(meta.contentType);

  return new MsePlayer(
    audio,
    url,
    mediaSource,
    sourceBuffer,
    blobUrl,
    meta.segmentCount,
    meta.segmentDuration,
    meta.readyChunks,
  );
}
