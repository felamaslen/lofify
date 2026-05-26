/**
 * Manifest-driven MSE playback. The player owns a growing manifest snapshot (init byte range + per-chunk `{ byteStart, byteEnd, endSeconds }`) fed from the `trackManifest` GraphQL subscription. It maps `currentTime` to a chunk via binary search on `endSeconds`, fetches that chunk's byte range from the playback URL, and appends it to a single `SourceBuffer`.
 *
 * Two container-conditional behaviours:
 *   - **Init segment.** fmp4 (opus/flac) ships an init range that must be prepended before any chunk; mp3 has no init, so `manifest.init` is `null`. The player keys "have we appended init?" off that nullability.
 *   - **`timestampOffset`.** fmp4 fragments carry `tfdt` (absolute decode time), so MSE places them at the right absolute time automatically. mp3 frames have no timestamps — each chunk's frames start at PTS 0 — so the player sets `sourceBuffer.timestampOffset = chunk.startSeconds` before each append. Whether per-chunk offsets are needed is determined at construction from the source-buffer content type.
 *
 * Lossless↔lossy switching mid-track is not supported here: the SourceBuffer's codec parameters are locked at `addSourceBuffer(contentType)`. Switching requires tearing the player down and starting again — `player.tsx` does this on quality/format changes.
 *
 * Both `ManifestSnapshot` and `ManifestChunk` are derived from the `TrackManifest` subscription document in `state/player.tsx`, so the player consumes the exact GraphQL response shape without any in-between conversion.
 */

import type { ManifestChunk, ManifestSnapshot } from '../state/player.tsx';

/** Drop chunks whose end is more than this many seconds behind `currentTime`. Bounds SourceBuffer memory. */
const BEHIND_WINDOW = 30;
/** How many chunks ahead of the current one to keep loaded. One = the "play smoothly" minimum. */
const PREFETCH_AHEAD = 1;

export interface Player {
  /** Update the player's view of the manifest. New chunks become eligible for prefetch. */
  setManifest(m: ManifestSnapshot): void;
  /** Seek to `time` and start playback there. Resolves once the chunk containing `time` is appended. */
  seekTo(time: number): Promise<void>;
  dispose(): void;
}

export type CreatePlayerError =
  | { kind: 'mse-unsupported' }
  | { kind: 'codec-unsupported'; contentType: string };

export type CreatePlayerOptions = {
  /** Called when the player can't satisfy the request. Caller surfaces this to the user. */
  onError?: (err: CreatePlayerError) => void;
};

/** Find the chunk index whose range covers `currentTime`. Returns -1 if `time` is past the last chunk's `endSeconds`. */
function findChunkAtTime(chunks: readonly ManifestChunk[], time: number): number {
  if (chunks.length === 0 || time >= chunks[chunks.length - 1]!.endSeconds) return -1;
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (chunks[mid]!.endSeconds <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function chunkStartSeconds(chunks: readonly ManifestChunk[], i: number): number {
  return i === 0 ? 0 : chunks[i - 1]!.endSeconds;
}

const EMPTY_MANIFEST: ManifestSnapshot = {
  chunkDurationSeconds: 0,
  durationSeconds: 0,
  done: false,
  init: null,
  chunks: [],
};

class MsePlayer implements Player {
  private disposed = false;
  private manifest: ManifestSnapshot = EMPTY_MANIFEST;
  private appendedInit = false;
  /** Chunk indices that have been appended to the SourceBuffer. */
  private loaded = new Set<number>();
  private pending = new Map<number, AbortController>();
  private appendQueue: Array<{ chunkIndex: number; data: Uint8Array; startSeconds: number }> = [];
  private appendingChunkIndex: number | null = null;
  private endedSignalled = false;
  private pendingSeekChunkIndex: number | null = null;
  private events = new EventTarget();

  constructor(
    private audio: HTMLAudioElement,
    private url: string,
    private mediaSource: MediaSource,
    private sourceBuffer: SourceBuffer,
    private blobUrl: string,
    /** True for mp3: each chunk's frames start at PTS 0, so `timestampOffset` must be set before append. Opus/flac in fmp4 carry tfdt so this stays false. */
    private setTimestampOffsetPerChunk: boolean,
  ) {
    sourceBuffer.addEventListener('updateend', this.onUpdateEnd);
    audio.addEventListener('timeupdate', this.onTimeUpdate);
    audio.addEventListener('seeking', this.onTimeUpdate);
  }

  setManifest(m: ManifestSnapshot): void {
    this.manifest = m;
    void this.ensureWindow();
  }

  async seekTo(time: number): Promise<void> {
    if (this.disposed) return;
    const target = findChunkAtTime(this.manifest.chunks, time);
    if (target < 0) {
      // Past the end of what's encoded; clamp to the last known chunk if there is one.
      if (this.manifest.chunks.length === 0) return;
      this.audio.currentTime = Math.min(time, this.manifest.durationSeconds);
      return;
    }
    if (this.loaded.has(target)) {
      this.audio.currentTime = time;
      return;
    }
    for (const [chunkIndex, ctrl] of this.pending) {
      if (chunkIndex !== target) {
        ctrl.abort();
        this.pending.delete(chunkIndex);
      }
    }
    if (!this.pending.has(target)) {
      void this.fetchChunk(target);
    }
    this.pendingSeekChunkIndex = target;
    try {
      await this.waitForLoaded(target);
      if (this.disposed) return;
      this.audio.currentTime = time;
    } finally {
      this.pendingSeekChunkIndex = null;
    }
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
      // SourceBuffer may already be detached from the MediaSource.
    }
    if (this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // Already ended.
      }
    }
    URL.revokeObjectURL(this.blobUrl);
  }

  private onUpdateEnd = (): void => {
    if (this.disposed) return;
    const justAppended = this.appendingChunkIndex;
    this.appendingChunkIndex = null;
    if (justAppended != null) {
      this.events.dispatchEvent(new CustomEvent('loaded', { detail: justAppended }));
    }
    this.evictBehindWindow();
    this.drainAppendQueue();
    this.tryEndOfStream();
  };

  private onTimeUpdate = (): void => {
    void this.ensureWindow();
  };

  private currentChunk(): number {
    const i = findChunkAtTime(this.manifest.chunks, this.audio.currentTime);
    return i < 0 ? Math.max(0, this.manifest.chunks.length - 1) : i;
  }

  private async ensureWindow(): Promise<void> {
    if (this.disposed) return;
    if (this.manifest.chunks.length === 0) return;
    if (this.manifest.init && !this.appendedInit && !this.pending.has(-1)) {
      void this.fetchInit();
    }
    const start = this.currentChunk();
    const end = Math.min(this.manifest.chunks.length - 1, start + PREFETCH_AHEAD);
    for (const [chunkIndex, ctrl] of this.pending) {
      if (chunkIndex >= 0 && (chunkIndex < start || chunkIndex > end)) {
        ctrl.abort();
        this.pending.delete(chunkIndex);
      }
    }
    for (let i = start; i <= end; i++) {
      if (this.loaded.has(i)) continue;
      if (this.pending.has(i)) continue;
      void this.fetchChunk(i);
    }
  }

  private async fetchInit(): Promise<void> {
    const init = this.manifest.init;
    if (!init) return;
    const ctrl = new AbortController();
    this.pending.set(-1, ctrl);
    try {
      const buf = await this.fetchRange(init.byteStart, init.byteEnd, ctrl.signal);
      if (!buf || this.disposed || ctrl.signal.aborted) return;
      this.appendQueue.unshift({ chunkIndex: -1, data: buf, startSeconds: 0 });
      this.drainAppendQueue();
    } finally {
      this.pending.delete(-1);
    }
  }

  private async fetchChunk(chunkIndex: number): Promise<void> {
    const chunk = this.manifest.chunks[chunkIndex];
    if (!chunk) return;
    const ctrl = new AbortController();
    this.pending.set(chunkIndex, ctrl);
    try {
      const buf = await this.fetchRange(chunk.byteStart, chunk.byteEnd, ctrl.signal);
      if (!buf || this.disposed || ctrl.signal.aborted) return;
      this.appendQueue.push({
        chunkIndex,
        data: buf,
        startSeconds: chunkStartSeconds(this.manifest.chunks, chunkIndex),
      });
      this.drainAppendQueue();
    } finally {
      this.pending.delete(chunkIndex);
    }
  }

  private async fetchRange(
    byteStart: number,
    byteEnd: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    try {
      const res = await fetch(this.url, {
        signal,
        headers: { Range: `bytes=${byteStart}-${byteEnd - 1}` },
      });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private isSourceBufferLive(): boolean {
    return !this.disposed && this.mediaSource.readyState === 'open';
  }

  private drainAppendQueue(): void {
    if (!this.isSourceBufferLive() || this.appendingChunkIndex != null) return;
    if (this.sourceBuffer.updating) return;
    if (this.appendQueue.length === 0) return;

    // Init must land before any chunk; once `appendedInit` is true the rest can append in any order.
    let pickIdx = 0;
    if (!this.appendedInit && this.manifest.init) {
      const initPos = this.appendQueue.findIndex((item) => item.chunkIndex === -1);
      if (initPos === -1) return;
      pickIdx = initPos;
    }
    const [next] = this.appendQueue.splice(pickIdx, 1);
    if (!next) return;
    this.appendingChunkIndex = next.chunkIndex;
    try {
      if (next.chunkIndex >= 0 && this.setTimestampOffsetPerChunk) {
        this.sourceBuffer.timestampOffset = next.startSeconds;
      }
      this.sourceBuffer.appendBuffer(next.data.buffer as ArrayBuffer);
      if (next.chunkIndex === -1) {
        this.appendedInit = true;
      } else {
        this.loaded.add(next.chunkIndex);
      }
    } catch (err) {
      this.appendingChunkIndex = null;
      if ((err as DOMException).name === 'QuotaExceededError' && this.isSourceBufferLive()) {
        this.appendQueue.unshift(next);
        const cutoff = Math.max(0, this.audio.currentTime - 5);
        try {
          const b = this.sourceBuffer.buffered;
          if (b.length > 0 && b.start(0) < cutoff) {
            this.sourceBuffer.remove(b.start(0), cutoff);
            this.appendingChunkIndex = next.chunkIndex;
          }
        } catch {
          // Invalid state — let the next updateend retry naturally.
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
    if (this.pendingSeekChunkIndex != null) {
      const seekStart = chunkStartSeconds(this.manifest.chunks, this.pendingSeekChunkIndex);
      cutoff = Math.min(cutoff, seekStart - BEHIND_WINDOW);
    }
    if (b.start(0) >= cutoff) return;
    try {
      this.sourceBuffer.remove(b.start(0), cutoff);
      for (const i of [...this.loaded]) {
        if (this.manifest.chunks[i]!.endSeconds < cutoff) this.loaded.delete(i);
      }
    } catch {
      // Invalid state — skip; next updateend will retry.
    }
  }

  private tryEndOfStream(): void {
    if (this.endedSignalled) return;
    if (!this.manifest.done) return;
    if (this.loaded.size < this.manifest.chunks.length) return;
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
      // Already ended or closing.
    }
  }

  private waitForLoaded(chunkIndex: number): Promise<void> {
    if (this.loaded.has(chunkIndex)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onLoaded = (e: Event): void => {
        if (!(e instanceof CustomEvent) || e.detail !== chunkIndex) return;
        this.events.removeEventListener('loaded', onLoaded);
        resolve();
      };
      this.events.addEventListener('loaded', onLoaded);
    });
  }
}

/** Build a SourceBuffer-backed Player for `(url, contentType)`. The caller drives chunks in via `setManifest`. */
export async function createPlayer(
  audio: HTMLAudioElement,
  url: string,
  contentType: string,
  options: CreatePlayerOptions = {},
): Promise<Player | null> {
  if (typeof MediaSource === 'undefined') {
    options.onError?.({ kind: 'mse-unsupported' });
    return null;
  }
  if (!MediaSource.isTypeSupported(contentType)) {
    options.onError?.({ kind: 'codec-unsupported', contentType });
    return null;
  }

  const mediaSource = new MediaSource();
  const blobUrl = URL.createObjectURL(mediaSource);
  audio.src = blobUrl;
  await new Promise<void>((resolve) => {
    mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
  });
  const sourceBuffer = mediaSource.addSourceBuffer(contentType);
  // mp3 chunks carry no PTS, so we must offset per chunk; fmp4 (opus/flac) carries tfdt so MSE places fragments automatically.
  const setOffsetPerChunk = contentType.startsWith('audio/mpeg');
  return new MsePlayer(audio, url, mediaSource, sourceBuffer, blobUrl, setOffsetPerChunk);
}
