/**
 * Segmented MSE playback pipeline.
 *
 * For non-flac streams the server delivers the track as a sequence of equal-duration DASH chunks (fMP4 for opus, raw mp3 frames otherwise); the player fetches the chunk containing `currentTime` plus one chunk of look-ahead and appends each to a single `SourceBuffer`. The chunks come from one ffmpeg pass on the server so they're gap-less by construction — no `timestampOffset` arithmetic is needed.
 *
 * For flac (passthrough) the player skips MSE entirely and uses bare `<audio src=blob>` playback — the spec requires lossless to stay un-touched. We fetch the file as a blob so we can inject the `Accept` header (a bare `audio.src = url` would send the browser default, which the server rejects).
 */

/** Drop chunks whose end is more than this many seconds behind `currentTime`. Bounds SourceBuffer memory. */
const BEHIND_WINDOW = 30;
/** How many chunks ahead of the current one to keep loaded. One = the "play smoothly" minimum. */
const PREFETCH_AHEAD = 1;

export interface Player {
  seekTo(time: number): Promise<void>;
  setReadyChunks(n: number): void;
  dispose(): void;
}

class DirectPlayer implements Player {
  constructor(
    private audio: HTMLAudioElement,
    private blobUrl: string | null,
  ) {}
  async seekTo(time: number): Promise<void> {
    this.audio.currentTime = time;
  }
  setReadyChunks(): void {
    // Passthrough — the file is always available, nothing to track.
  }
  dispose(): void {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
  }
}

class MsePlayer implements Player {
  private disposed = false;
  private loaded = new Set<number>();
  private pending = new Map<number, AbortController>();
  private appendQueue: Array<{ segIndex: number; data: Uint8Array }> = [];
  private appendingSegIndex: number | null = null;
  private endedSignalled = false;
  private initAppended = false;
  private pendingSeekSegIndex: number | null = null;
  private events = new EventTarget();
  private readyChunks: number;

  constructor(
    private audio: HTMLAudioElement,
    private url: string,
    private accept: string,
    private mediaSource: MediaSource,
    private sourceBuffer: SourceBuffer,
    private blobUrl: string,
    private segmentCount: number,
    private segmentDuration: number,
    initialReadyChunks: number,
    /** When true, set `timestampOffset = segIndex * segmentDuration` before each append. Required for raw mp3 chunks (each one starts at PTS 0 thanks to `-reset_timestamps 1` on the muxer); without it, out-of-order appends — i.e. any seek to an unbuffered region — land at the wrong absolute time and seeking silently fails. fMP4/opus DASH segments carry correct absolute PTS, so they stay at offset 0. */
    private appendAtSegmentOffset: boolean,
  ) {
    this.readyChunks = initialReadyChunks;
    sourceBuffer.addEventListener('updateend', this.onUpdateEnd);
    audio.addEventListener('timeupdate', this.onTimeUpdate);
    audio.addEventListener('seeking', this.onTimeUpdate);
    void this.ensureWindow();
  }

  private onUpdateEnd = (): void => {
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
    for (const [seg, ctrl] of this.pending) {
      if (seg !== targetSeg) {
        ctrl.abort();
        this.pending.delete(seg);
      }
    }
    if (!this.pending.has(targetSeg)) {
      void this.fetchSegment(targetSeg);
    }
    this.pendingSeekSegIndex = targetSeg;
    try {
      await this.waitForLoaded(targetSeg);
      if (this.disposed) return;
      this.audio.currentTime = time;
    } finally {
      this.pendingSeekSegIndex = null;
    }
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
      const res = await fetch(`${this.url}/${segIndex}`, {
        signal: ctrl.signal,
        headers: { Accept: this.accept },
      });
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

  private isSourceBufferLive(): boolean {
    return !this.disposed && this.mediaSource.readyState === 'open';
  }

  private drainAppendQueue(): void {
    if (!this.isSourceBufferLive() || this.appendingSegIndex != null) return;
    if (this.sourceBuffer.updating) return;
    if (this.appendQueue.length === 0) return;

    // Chunk 0 carries the init segment (server-spliced for fMP4; mp3 needs none); higher-indexed chunks have to wait until the init has landed for fMP4. Once `initAppended` is true the remaining chunks can append in any order.
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
      if (this.appendAtSegmentOffset) {
        this.sourceBuffer.timestampOffset = next.segIndex * this.segmentDuration;
      }
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
            this.appendingSegIndex = next.segIndex;
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

type ProbeChunked = {
  mode: 'chunked';
  contentType: string;
  segmentCount: number;
  segmentDuration: number;
  durationSeconds: number;
  readyChunks: number;
};
type ProbeDirect = { mode: 'direct'; contentType: string };

async function probe(url: string, accept: string): Promise<ProbeChunked | ProbeDirect | null> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'HEAD', headers: { Accept: accept } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') ?? '';
  const segs = Number(res.headers.get('x-lofify-segments') ?? 0);
  if (segs > 0) {
    return {
      mode: 'chunked',
      contentType,
      segmentCount: segs,
      segmentDuration: Number(res.headers.get('x-lofify-segment-duration') ?? 6),
      durationSeconds: Number(res.headers.get('x-lofify-duration') ?? 0),
      readyChunks: Number(res.headers.get('x-lofify-ready-chunks') ?? 0),
    };
  }
  return { mode: 'direct', contentType };
}

export type CreatePlayerError =
  | { kind: 'mse-unsupported'; contentType: string }
  | { kind: 'probe-failed' }
  | { kind: 'direct-fetch-failed' };

/** Resolved delivery format, as inferred from the probe's `Content-Type`. Anything we don't recognise falls back to `null` so the UI just hides the badge. */
export type ActualFormat = 'flac' | 'opus' | 'mp3' | null;

function actualFormatFromContentType(contentType: string): ActualFormat {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('audio/flac') || ct.startsWith('audio/x-flac')) return 'flac';
  if (ct.startsWith('audio/mp4')) return 'opus';
  if (ct.startsWith('audio/mpeg')) return 'mp3';
  return null;
}

export type CreatePlayerOptions = {
  /** Called when the player can't satisfy the request. The caller is expected to surface this to the user (e.g. a toast). */
  onError?: (err: CreatePlayerError) => void;
};

export type CreatePlayerResult = { player: Player; actualFormat: ActualFormat };

export async function createPlayer(
  audio: HTMLAudioElement,
  url: string,
  accept: string,
  options: CreatePlayerOptions = {},
): Promise<CreatePlayerResult | null> {
  const meta = await probe(url, accept);
  if (!meta) {
    options.onError?.({ kind: 'probe-failed' });
    return null;
  }

  if (meta.mode === 'direct') {
    // Direct mode = flac passthrough. Fetch as a blob so we can inject the Accept header (a plain `audio.src = url` would send the browser default, which the server rejects).
    let blobUrl: string | null = null;
    try {
      const res = await fetch(url, { headers: { Accept: accept } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      blobUrl = URL.createObjectURL(blob);
      audio.src = blobUrl;
    } catch {
      options.onError?.({ kind: 'direct-fetch-failed' });
      return null;
    }
    return {
      player: new DirectPlayer(audio, blobUrl),
      actualFormat: actualFormatFromContentType(meta.contentType),
    };
  }

  // Chunked mode — required to use MSE.
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(meta.contentType)) {
    options.onError?.({ kind: 'mse-unsupported', contentType: meta.contentType });
    return null;
  }

  const mediaSource = new MediaSource();
  const blobUrl = URL.createObjectURL(mediaSource);
  audio.src = blobUrl;
  await new Promise<void>((resolve) => {
    mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
  });
  if (meta.durationSeconds > 0) {
    try {
      mediaSource.duration = meta.durationSeconds;
    } catch {
      // browser refused — fine, tryEndOfStream() will fire endOfStream() when all chunks are loaded.
    }
  }
  const sourceBuffer = mediaSource.addSourceBuffer(meta.contentType);

  return {
    player: new MsePlayer(
      audio,
      url,
      accept,
      mediaSource,
      sourceBuffer,
      blobUrl,
      meta.segmentCount,
      meta.segmentDuration,
      meta.readyChunks,
      meta.contentType.startsWith('audio/mpeg'),
    ),
    actualFormat: actualFormatFromContentType(meta.contentType),
  };
}
