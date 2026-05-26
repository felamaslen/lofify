/**
 * Manifest-driven MSE playback. The player owns a growing manifest snapshot (init byte range + per-chunk `{ byteStart, byteEnd, endSeconds }`) fed from the `trackManifest` GraphQL subscription, and fetches chunk byte ranges from the playback URL into a single `SourceBuffer`.
 *
 * The buffer is reconciled against one source of truth — `sourceBuffer.buffered` — on every relevant event (timeupdate, seeking, append/remove completion, manifest growth). `reconcile()` is the whole control loop: if the playhead has no data it resets and fetches the chunk under it; otherwise it trims anything outside a window around the playhead and fetches the next unbuffered chunk ahead. Nothing is tracked in a side `loaded` set, so there's no derived state that can drift out of sync with the actual buffer and strand a region as "loaded but absent". Seeking is therefore just `audio.currentTime = time` — the seeking event drives reconciliation.
 *
 * Two container-conditional behaviours:
 *   - **Init segment.** fmp4 (opus/flac) ships an init range that must be appended once to configure the SourceBuffer; mp3 has no init, so `manifest.init` is `null`. (The init survives `remove()`, so it's only appended once even across evictions.)
 *   - **`timestampOffset`.** fmp4 fragments carry `tfdt` (absolute decode time), so MSE places them automatically. mp3 frames have no timestamps — each chunk starts at PTS 0 — so the player sets `sourceBuffer.timestampOffset = chunk.startSeconds` before each append. Decided at construction from the content type.
 *
 * Lossless↔lossy switching mid-track is not supported here: the SourceBuffer's codec parameters are locked at `addSourceBuffer(contentType)`. Switching requires tearing the player down and starting again — `player.tsx` does this on quality/format changes.
 *
 * `ManifestSnapshot` and `ManifestChunk` are derived from the `TrackManifest` subscription document in `state/player.tsx`, so the player consumes the exact GraphQL response shape with no in-between conversion.
 */

import type { ManifestChunk, ManifestSnapshot } from '../state/player.tsx';

/** Trim buffered audio more than this many seconds behind the playhead. */
const BEHIND_WINDOW = 30;
/** Fetch chunks until this many seconds ahead of the playhead are buffered. */
const FETCH_AHEAD = 30;
/** Trim buffered audio more than this many seconds ahead of the playhead. Kept above `FETCH_AHEAD` so a just-fetched edge chunk isn't immediately trimmed (no thrash). */
const KEEP_AHEAD = 45;
/** Tolerance for treating the playhead as "inside" a buffered range (covers sub-frame gaps at fragment boundaries). */
const PLAYHEAD_EPS = 0.1;

type Range = { start: number; end: number };

export interface Player {
  /** Update the player's view of the manifest. Newly-available chunks become eligible for prefetch. */
  setManifest(m: ManifestSnapshot): void;
  /** Seek to `time`. The audio element waits for data and resumes once the chunk under `time` is fetched and appended by the reconcile loop. */
  seekTo(time: number): void;
  dispose(): void;
}

export type CreatePlayerError =
  | { kind: 'mse-unsupported' }
  | { kind: 'codec-unsupported'; contentType: string };

export type CreatePlayerOptions = {
  /** Called when the player can't satisfy the request. Caller surfaces this to the user. */
  onError?: (err: CreatePlayerError) => void;
};

/** First chunk index whose range covers `time`, or -1 if `time` is at/after the last chunk's end. */
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

function coversTime(ranges: readonly Range[], t: number): boolean {
  return ranges.some((r) => r.start - PLAYHEAD_EPS <= t && t < r.end);
}

const EMPTY_MANIFEST: ManifestSnapshot = {
  durationSeconds: 0,
  done: false,
  init: null,
  chunks: [],
};

class MsePlayer implements Player {
  private disposed = false;
  private manifest: ManifestSnapshot = EMPTY_MANIFEST;
  private appendedInit = false;
  /** In-flight range fetches, keyed by chunk index (`-1` = init segment). */
  private pending = new Map<number, AbortController>();
  private appendQueue: Array<{ chunkIndex: number; data: Uint8Array; startSeconds: number }> = [];

  constructor(
    private audio: HTMLAudioElement,
    private url: string,
    private mediaSource: MediaSource,
    private sourceBuffer: SourceBuffer,
    private blobUrl: string,
    /** True for mp3: each chunk's frames start at PTS 0, so `timestampOffset` must be set before append. fmp4 (opus/flac) carries tfdt so this stays false. */
    private setTimestampOffsetPerChunk: boolean,
  ) {
    sourceBuffer.addEventListener('updateend', this.onTick);
    audio.addEventListener('timeupdate', this.onTick);
    audio.addEventListener('seeking', this.onTick);
  }

  setManifest(m: ManifestSnapshot): void {
    this.manifest = m;
    this.tick();
  }

  seekTo(time: number): void {
    if (this.disposed) return;
    // Clamp into the encoded region; the seeking event drives reconcile to fetch the target chunk.
    this.audio.currentTime = Math.min(time, this.manifest.durationSeconds || time);
  }

  dispose(): void {
    this.disposed = true;
    for (const ctrl of this.pending.values()) ctrl.abort();
    this.pending.clear();
    this.audio.removeEventListener('timeupdate', this.onTick);
    this.audio.removeEventListener('seeking', this.onTick);
    try {
      this.sourceBuffer.removeEventListener('updateend', this.onTick);
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

  private onTick = (): void => {
    this.tick();
  };

  private tick(): void {
    this.reconcile();
    this.tryEndOfStream();
  }

  private isLive(): boolean {
    return !this.disposed && this.mediaSource.readyState === 'open';
  }

  private bufferedRanges(): Range[] {
    try {
      const b = this.sourceBuffer.buffered;
      const out: Range[] = [];
      for (let i = 0; i < b.length; i++) out.push({ start: b.start(i), end: b.end(i) });
      return out;
    } catch {
      return [];
    }
  }

  /**
   * The single control loop. Issues at most one SourceBuffer operation (append/remove) or one fetch per call; the resulting `updateend`/completion re-invokes it until the buffer matches the desired window.
   */
  private reconcile(): void {
    if (!this.isLive() || this.sourceBuffer.updating) return;
    if (this.appendQueue.length > 0) {
      this.drainAppendQueue();
      return;
    }
    const chunks = this.manifest.chunks;
    if (chunks.length === 0) return;

    // Init segment must be appended before any media fragment.
    if (this.manifest.init && !this.appendedInit) {
      if (!this.pending.has(-1)) void this.fetchInit();
      return;
    }

    const t = this.audio.currentTime;
    const ranges = this.bufferedRanges();

    // 1. Playhead has no data → reset to a clean slate and fetch the chunk under it.
    if (!coversTime(ranges, t)) {
      const idx = findChunkAtTime(chunks, t);
      // The chunk under the playhead is already being fetched or is queued to append. Wait for
      // it to land instead of cancelling and refetching it: cancelAllPending() would abort the
      // very fetch that resolves this, and the next tick would re-issue it — an infinite loop.
      if (idx >= 0 && (this.pending.has(idx) || this.appendQueue.some((q) => q.chunkIndex === idx)))
        return;
      this.cancelAllPending();
      this.appendQueue = [];
      if (ranges.length > 0) {
        this.tryRemove(0, Number.POSITIVE_INFINITY);
        return;
      }
      if (idx >= 0) void this.fetchChunk(idx);
      return;
    }

    // 2. Trim buffered audio outside the keep window (one span per pass).
    const keepStart = t - BEHIND_WINDOW;
    const keepEnd = t + KEEP_AHEAD;
    for (const r of ranges) {
      if (r.end <= keepStart || r.start >= keepEnd) return this.tryRemove(r.start, r.end);
      if (r.start < keepStart) return this.tryRemove(r.start, keepStart);
      if (r.end > keepEnd) return this.tryRemove(keepEnd, r.end);
    }

    // 3. One fetch in flight at a time; drop any pending fetch that's drifted out of the window.
    const fetchEnd = t + FETCH_AHEAD;
    if (this.pending.size > 0) {
      for (const [i, ctrl] of this.pending) {
        if (i < 0) continue;
        if (chunkStartSeconds(chunks, i) >= fetchEnd || chunks[i]!.endSeconds <= t) {
          ctrl.abort();
          this.pending.delete(i);
        }
      }
      return;
    }

    // 4. Fetch the first chunk in [t, t + FETCH_AHEAD] that isn't buffered yet.
    const startIdx = findChunkAtTime(chunks, t);
    if (startIdx < 0) return;
    for (let i = startIdx; i < chunks.length; i++) {
      const cs = chunkStartSeconds(chunks, i);
      if (cs >= fetchEnd) break;
      const ce = chunks[i]!.endSeconds;
      const mid = (Math.max(cs, t) + ce) / 2;
      if (!coversTime(ranges, mid)) {
        void this.fetchChunk(i);
        return;
      }
    }
  }

  private cancelAllPending(): void {
    for (const ctrl of this.pending.values()) ctrl.abort();
    this.pending.clear();
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

  private drainAppendQueue(): void {
    if (!this.isLive() || this.sourceBuffer.updating) return;
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
    try {
      if (next.chunkIndex >= 0 && this.setTimestampOffsetPerChunk) {
        this.sourceBuffer.timestampOffset = next.startSeconds;
      }
      this.sourceBuffer.appendBuffer(next.data.buffer as ArrayBuffer);
      if (next.chunkIndex === -1) this.appendedInit = true;
    } catch (err) {
      if ((err as DOMException).name === 'QuotaExceededError' && this.isLive()) {
        // Re-queue and free space behind the playhead; the next tick retries the append.
        this.appendQueue.unshift(next);
        const cutoff = Math.max(0, this.audio.currentTime - 5);
        const first = this.bufferedRanges()[0];
        if (first && first.start < cutoff) this.tryRemove(first.start, cutoff);
      }
    }
  }

  private tryRemove(start: number, end: number): void {
    if (end <= start) return;
    try {
      this.sourceBuffer.remove(start, end);
    } catch {
      // Invalid state — the next tick retries.
    }
  }

  private tryEndOfStream(): void {
    if (!this.manifest.done || !this.isLive()) return;
    if (this.sourceBuffer.updating || this.appendQueue.length > 0) return;
    // Only end once the final chunk's audio is buffered (i.e. the playhead has reached the tail).
    // Appending after endOfStream re-opens the MediaSource, so a later seek-back still works.
    // Anchor to the last chunk's actual (cumulative) endSeconds, not the estimated
    // `durationSeconds`: they diverge for fmp4, and gating on the estimate can leave endOfStream
    // unreachable — the playhead then reaches the encoded tail, reconcile wipes the buffer as
    // "uncovered" and refetches forever instead of letting `ended` advance to the next track.
    const chunks = this.manifest.chunks;
    const encodedEnd = chunks.length > 0 ? chunks[chunks.length - 1]!.endSeconds : 0;
    if (encodedEnd <= 0) return;
    const ranges = this.bufferedRanges();
    const last = ranges[ranges.length - 1];
    if (!last || last.end < encodedEnd - 0.5) return;
    try {
      this.mediaSource.endOfStream();
    } catch {
      // Already ended or closing.
    }
  }
}

/** Build a SourceBuffer-backed Player for `(url, contentType)`. The caller drives chunks in via `setManifest`. `durationSeconds` is the full track length — set on the MediaSource so seeks aren't clamped to the buffered-so-far range (the buffer is sparse; without an explicit duration MSE infers it from the last buffered end and clamps any seek past it). */
export async function createPlayer(
  audio: HTMLAudioElement,
  url: string,
  contentType: string,
  durationSeconds: number,
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
  if (durationSeconds > 0) {
    try {
      mediaSource.duration = durationSeconds;
    } catch {
      // Browser refused (e.g. mid-update) — non-fatal; tryEndOfStream() still ends the stream once the tail is buffered.
    }
  }
  const sourceBuffer = mediaSource.addSourceBuffer(contentType);
  // mp3 chunks carry no PTS, so we must offset per chunk; fmp4 (opus/flac) carries tfdt so MSE places fragments automatically.
  const setOffsetPerChunk = contentType.startsWith('audio/mpeg');
  return new MsePlayer(audio, url, mediaSource, sourceBuffer, blobUrl, setOffsetPerChunk);
}
