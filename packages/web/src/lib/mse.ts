/**
 * Manifest-driven MSE playback for a single audio element. The player owns one `MediaSource` with one `SourceBuffer`, plus two slots — `current` (the track playing now) and `next` (its successor, fetched ahead so its bytes splice onto the buffer for gapless playback). Bytes for the two slots are concatenated end-to-end into the same buffer; the audio element transitions across the boundary without stalling — and without depending on the `ended` event that a backgrounded PWA dispatches slowly.
 *
 * Cross-codec transitions work via `SourceBuffer.changeType(contentType)`: when a track's bytes need to be parsed with a different codec config than the buffer is currently set up for, the player calls `changeType` first, then re-appends the track's cached init segment, then the media. (Browsers typically cap audio at one SourceBuffer per MediaSource, so multi-buffer wasn't workable.)
 *
 * Each `TrackEntry` carries a `durationOffset`: where its t=0 lives in concatenated-stream time. `current` always sits at offset 0 or wherever the playhead has advanced to within its encoded range; `next.durationOffset` resolves to `current`'s nominal end once `current`'s manifest reports `done`. Until then `next` is enqueued but its bytes aren't appended.
 *
 * The buffer is reconciled against one source of truth — `sourceBuffer.buffered` — on every relevant event (timeupdate, seeking, append/remove completion, manifest growth). `reconcile()` walks `current` then `next` inside the keep/fetch window. Nothing is tracked in a side `loaded` set, so there's no derived state that can drift out of sync with the actual buffer.
 *
 * Two container-conditional behaviours, applied per track:
 *   - **Init segment.** fmp4 (opus/flac) ships an init range that must be appended to configure the SourceBuffer's parser for that track's stream; mp3 has no init. Appending an init segment re-initialises parsing inside the same SourceBuffer. When the buffer's parser is configured for a different track (or codec) than the next media item, the target track's cached init bytes are re-appended first.
 *   - **`timestampOffset`.** mp3 frames have no timestamps — each chunk starts at PTS 0 — so the player sets `sourceBuffer.timestampOffset = trackOffset + chunkStartSeconds` before each append. fmp4 fragments carry `tfdt` (absolute decode time) starting at 0 per track, so the player sets `timestampOffset = trackOffset` once per track and MSE places the rest. Whether per-chunk or per-track is decided from the parser's current contentType.
 *
 * Preload of the successor is mse-driven: the caller passes a `trackNext` thunk to `init`, and mse invokes it when the playhead is within `NEXT_TRACK_PRELOAD_SECONDS` of `current`'s end. If it returns `null` (end of library) or a codec the browser can't decode at all, `MediaSource.endOfStream()` fires after `current`'s tail and the caller's `ended` handler can step.
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
/** How often, at most, to fire an in-flight `onTransfer` report during a chunk fetch. */
const PROGRESS_INTERVAL_MS = 250;
/** Hold the first in-flight `onTransfer` report until this much body has streamed, so TCP slow-start doesn't inflate the sample the caller sees. */
const TRANSFER_MIN_MS = 500;
/** When the current track has at most this many seconds left to play, mse invokes `trackNext` to resolve and start fetching the successor. Must comfortably exceed worst-case manifest first-emission latency plus first-chunk fetch; otherwise the playhead hits the encoded tail before the successor has any buffered audio. */
const NEXT_TRACK_PRELOAD_SECONDS = 20;
/** How long `audio.currentTime` must remain unchanged (while not paused or seeking) before we treat playback as stalled at the boundary and bridge into the next track. Comfortably longer than the coarsest expected `currentTime` update interval (Firefox's privacy-resistance rounding tops out around 1s) so normal playback through a position never looks stalled. */
const BOUNDARY_STALL_MS = 1500;
/** Wall-clock interval for the watchdog `tick` driven by `setInterval`. Audio-element events (`timeupdate`, `updateend`) stop firing during a stall, so the stall detector wouldn't otherwise get a chance to run. Short enough that the bridge fires within ~2× `BOUNDARY_STALL_MS` of the true stall start. */
const WATCHDOG_TICK_MS = 500;

/** Half-open seconds interval `[start, end)`. Mirrors the shape of `TimeRanges` entries that `SourceBuffer.buffered` reports, so a buffered region round-trips through the public accessors without conversion. */
export type Range = { start: number; end: number };

/** A track the caller wants the player to play. */
export type QueuedTrack = {
  /** Opaque identifier. The player itself never inspects it. */
  id: string;
  /** Origin URL the player issues `Range` requests against to fetch chunk and init bytes for this track. */
  url: string;
  /** Mime type of `url`'s bytes. Determines whether the player can splice this track onto the existing buffer or has to be rebuilt for the new codec. */
  contentType: string;
  /** Quality tier `url` serves (the `X-Quality` value the server stamps onto responses). Passed through to `subscribeManifest`. */
  quality: string;
  /** Nominal length from the track's metadata. Used as the duration estimate for `MediaSource.duration` and the preload-window lookahead — the authoritative end is `chunks[last].endSeconds` once the manifest reports `done`. */
  totalSeconds: number;
  /** Open a manifest stream for this track at `quality` and deliver cumulative snapshots via `onEmit`. mse calls this when the track joins a slot, and re-invokes it after a live tier change on `current`. The returned function is mse's only way to close the subscription. */
  subscribeManifest: (quality: string, onEmit: (m: ManifestSnapshot) => void) => () => void;
};

const bitsPerSecond = (bytes: number, ms: number): number => (bytes * 8000) / ms;

/** Construction-time hooks; all optional. */
export type CreatePlayerOptions = {
  /** Called with the `X-Quality` of the bytes under the playhead whenever it changes. Trails the requested tier mid-swap until the old-quality buffer drains. `null` before any chunk under the playhead has been fetched. */
  onQuality?: (quality: string | null) => void;
  /** Called with the body-transfer rate (bits per second, TTFB excluded) during chunk fetches. Fires periodically mid-flight (`chunkFinished = false`) so the ABR controller can react to a collapsing link before the buffer drains, and once on completion (`chunkFinished = true`) with the final rate so the controller has a confident sample for upscale decisions. */
  onTransfer?: (bitsPerSecond: number, chunkFinished: boolean) => void;
  /** Called when the playhead crosses into a different track (or on first load). Track-local position and buffered ranges are available via the public accessors; concatenated-stream coordinates aren't exposed. */
  onTrackChange?: (trackId: string) => void;
  /** Called whenever the current track's manifest emits — i.e. whenever `currentTrackReadySeconds()` / `currentTrackEncodedEnd()` may have advanced. Manifest growth doesn't ride on any audio-element event, so the caller can't otherwise know when to re-poll the buffer indicator UI. */
  onReadyChange?: () => void;
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

function concatChunks(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const EMPTY_MANIFEST: ManifestSnapshot = {
  durationSeconds: 0,
  done: false,
  init: null,
  chunks: [],
};

type TrackEntry = {
  id: string;
  url: string;
  /** Mime of this track's bytes — routes appends to the matching SourceBuffer in `MsePlayer.buffers`. */
  contentType: string;
  quality: string;
  totalSeconds: number;
  manifest: ManifestSnapshot;
  appendedInit: boolean;
  /** Concatenated-stream start. `null` until `current`'s manifest is `done` (only meaningful for `next`). `current` is always 0. */
  durationOffset: number | null;
  /** Cached init bytes. Re-appended when the parser was configured for a different track. */
  initBytes: Uint8Array | null;
  /** The caller's factory, retained so a live tier change can re-invoke it. */
  subscribeManifest: QueuedTrack['subscribeManifest'];
  /** Teardown for the open subscription, or `null` between transitions. */
  unsubManifest: (() => void) | null;
};

/** Last finalised end (concatenated) of `entry`'s encoded region, or `null` if not yet known. Returning `durationOffset` when no chunks have arrived would mis-represent the track as zero-length and clamp seeks to 0. */
function trackEncodedEnd(entry: TrackEntry): number | null {
  if (entry.durationOffset === null) return null;
  const chunks = entry.manifest.chunks;
  if (chunks.length === 0) return null;
  return entry.durationOffset + chunks[chunks.length - 1]!.endSeconds;
}

type PendingKey = string;
type AppendItem = {
  trackId: string;
  /** `-1` = init for that track; otherwise the chunk index in its manifest. */
  chunkIndex: number;
  data: Uint8Array;
  /** Absolute concatenated start (for media segments); init items carry the track's `durationOffset` here. */
  absStartSeconds: number;
};

function pendingKey(trackId: string, chunkIndex: number): PendingKey {
  return `${trackId}:${chunkIndex}`;
}

/** Snapshot of one `SourceBuffer`'s buffered ranges, with the noisy `TimeRanges`/detached-buffer cases swallowed to `[]`. */
function bufferedRanges(sb: SourceBuffer): Range[] {
  try {
    const b = sb.buffered;
    const out: Range[] = [];
    for (let i = 0; i < b.length; i++) out.push({ start: b.start(i), end: b.end(i) });
    return out;
  } catch {
    return [];
  }
}

function parsePendingKey(key: PendingKey): { trackId: string; chunkIndex: number } | null {
  const sep = key.lastIndexOf(':');
  if (sep < 0) return null;
  const trackId = key.slice(0, sep);
  const chunkIndex = Number(key.slice(sep + 1));
  if (!Number.isFinite(chunkIndex)) return null;
  return { trackId, chunkIndex };
}

/**
 * Owns the single `<audio>` element's media pipeline: one `MediaSource`, one `SourceBuffer`, and two slots (`current`, `next`) whose bytes it stitches end-to-end for gapless playback. Its job is **byte-level orchestration** — fetching range-encoded chunks, appending them in the right order with the right `timestampOffset`, re-appending an entry's cached init when the parser is configured for a different track (or codec — see `changeType`), reconciling against `sourceBuffer.buffered`, and invoking the caller's `trackNext` thunk when the preload window opens.
 *
 * It does **not** know about GraphQL, React, library order, or the user's tier/preference settings. The caller hands each track a `subscribeManifest` factory and (at `init`) a `trackNext` thunk; mse drives both lifecycles. All "play this track at this position" requests go through `MsePlayer.init`, which decides internally between a live tier switch (same id) and a wipe-and-replace (different id). A different codec is handled by `SourceBuffer.changeType` in the same buffer; no rebuild.
 */
export class MsePlayer {
  /**
   * Single entry point for the caller. Decision matrix:
   *
   * 1. No existing instance → build a fresh `MediaSource` and install `track`. Throws if the browser can't decode `track.contentType` (or supports no MSE at all).
   * 2. Same id *and* same `contentType` as `existing.current` → live tier switch (bitrate change within one codec): drop in-flight fetches and queued appends for the track, point at the new url/quality, re-open its manifest subscription, clear the `next` slot (its url was at the old tier). No seek; the existing buffer keeps playing while reconcile's upgrade loop re-fetches it at the new tier.
   * 3. Anything else (different id, or same id but different codec) → wipe-and-replace: cancel pending, clear the append queue, remove buffered audio, close subscriptions, install new `current`, seek to `startAt`. Codec swaps need the wipe — stale-codec bytes in the buffer can't be decoded under the new parser config, and overlapping new-codec appends would race with old-codec audio that's still playing out.
   *
   * `trackNext` is stored and invoked by mse when the current track approaches its end. The caller refreshes it on every `init` call so it can capture the latest tier/preference state.
   *
   * Throws `Error` (with a UI-ready message) when the browser can't satisfy the request.
   */
  static async init(
    /**
     * Existing `MsePlayer` instance. Will modify this instance and return it if possible and not already disposed. Set to `null` if not yet initialised.
     */
    existing: MsePlayer | null,
    audio: HTMLAudioElement,
    track: QueuedTrack,
    startAt: number,
    trackNext: () => Promise<QueuedTrack | null>,
    options: CreatePlayerOptions = {},
  ): Promise<MsePlayer> {
    if (existing && !existing.disposed) {
      existing.trackNext = trackNext;
      if (existing.current?.id === track.id && existing.current.contentType === track.contentType) {
        existing.liveSwap(track);
      } else {
        existing.replaceCurrent(track, startAt);
      }
      return existing;
    }
    if (typeof MediaSource === 'undefined') {
      throw new Error(
        'This browser does not support Media Source Extensions; playback is unavailable.',
      );
    }
    if (!MediaSource.isTypeSupported(track.contentType)) {
      throw new Error(`This browser cannot decode ${track.contentType}. Pick a different format.`);
    }
    const mediaSource = new MediaSource();
    const blobUrl = URL.createObjectURL(mediaSource);
    audio.src = blobUrl;
    await new Promise<void>((resolve) => {
      mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
    });
    const sourceBuffer = mediaSource.addSourceBuffer(track.contentType);
    const player = new MsePlayer(
      audio,
      mediaSource,
      sourceBuffer,
      blobUrl,
      track.contentType,
      trackNext,
      options,
    );
    player.installCurrent(track);
    player.audio.currentTime = startAt;
    return player;
  }

  private disposed = false;
  /** The track playing now. */
  private current: TrackEntry | null = null;
  /** The successor, resolved via `trackNext`. Becomes `current` when the playhead crosses its `durationOffset`. */
  private next: TrackEntry | null = null;
  /** Last id passed to `onTrackChange`, so we only fire on actual changes. */
  private currentTrackId: string | null = null;
  /** Whether `trackNext` has been invoked for the current `current`. Resets on boundary cross and on `init` reseating `current`. */
  private nextRequested = false;
  /** Whether the upcoming end of `current` should fire `MediaSource.endOfStream()`. Set when `trackNext` returns `null` (end of library) or a codec-mismatch successor (mse can't splice; caller's `ended` handler reloads). */
  private nextEnded = false;
  /** Stall-detection state: the last `audio.currentTime` we observed and the wall-clock timestamp we observed it at. If `currentTime` doesn't advance across a real interval of wall-clock time while playback is meant to be live, audio is stalled — used by `updateCurrentTrack` to bridge a track boundary the playhead can't reach via the normal `>= next.durationOffset` route (codec padding, encoder overhead, etc.). Reset on every change of `currentTime` and whenever audio is paused or mid-seek. */
  private observedPlayhead = -1;
  private observedPlayheadAt = 0;
  /** `setInterval` handle for the watchdog tick, or `null` when paused. Started/stopped via the audio element's `play`/`pause` events so a backgrounded paused player isn't burning a timer. */
  private watchdog: ReturnType<typeof setInterval> | null = null;

  /** In-flight range fetches, keyed by `pendingKey(trackId, chunkIndex)` (`-1` = init). */
  private pending = new Map<PendingKey, AbortController>();
  private appendQueue: AppendItem[] = [];
  /** Last chunk fetched to cover an uncovered playhead. Snap-to-buffered guard against fmp4 decode-time drift causing a refetch loop. */
  private lastUncoveredFetch: PendingKey | null = null;
  /** `X-Quality` of fetched bytes, keyed by rounded concatenated start. */
  private qualityByStart = new Map<number, string>();
  private reportedQuality: string | null = null;
  /** Tier we want the forward buffer at. Set by the live-switch branch of `init`; drives the buffered-ahead re-fetch loop. */
  private desiredQuality: { trackId: string; quality: string } | null = null;
  /** Rounded concatenated starts already re-fetched for `desiredQuality`. One attempt per chunk per switch. */
  private upgradedStarts = new Set<number>();
  /** Highest value pushed to `MediaSource.duration`. Extend-only; the setter rejects shrinks below the buffered tail. */
  private mediaSourceDurationCap = 0;
  /** Track whose init most recently configured the parser. A media append for any other track must re-append that track's init first. Cleared whenever `changeType` resets the parser. */
  private lastInitAppendedFor: string | null = null;
  /** Mime the SourceBuffer's parser is currently configured for. Updated on `changeType`. */
  private parserContentType: string;
  /** True when the parser's contentType uses per-chunk timestampOffsets (mp3). False for fmp4 (tfdt-bearing). Re-derived after `changeType`. */
  private setTimestampOffsetPerChunk: boolean;

  private constructor(
    private audio: HTMLAudioElement,
    private mediaSource: MediaSource,
    private sourceBuffer: SourceBuffer,
    private blobUrl: string,
    /** Mime the SourceBuffer was originally constructed for. The parser's current contentType may differ (via `changeType`); see `parserContentType`. */
    initialContentType: string,
    /** Resolver for the next track. Re-invoked after every boundary cross. Replaced on every `init` call. */
    private trackNext: () => Promise<QueuedTrack | null>,
    private options: CreatePlayerOptions,
  ) {
    this.parserContentType = initialContentType;
    this.setTimestampOffsetPerChunk = initialContentType.startsWith('audio/mpeg');
    sourceBuffer.addEventListener('updateend', this.onTick);
    audio.addEventListener('timeupdate', this.onTick);
    audio.addEventListener('seeking', this.onTick);
    // Wall-clock watchdog. Audio events stop firing during a stall (no `timeupdate` if
    // `currentTime` isn't advancing, no `updateend` if nothing is appending), so the stall
    // detector in `updateCurrentTrack` wouldn't otherwise get a chance to run. Only ticks while
    // audio is actually playing — when paused there's no playback to detect a stall against.
    audio.addEventListener('play', this.startWatchdog);
    audio.addEventListener('pause', this.stopWatchdog);
    audio.addEventListener('ended', this.stopWatchdog);
    if (!audio.paused) this.startWatchdog();
  }

  private startWatchdog = (): void => {
    if (this.watchdog !== null || this.disposed) return;
    this.watchdog = setInterval(this.onTick, WATCHDOG_TICK_MS);
  };

  private stopWatchdog = (): void => {
    if (this.watchdog === null) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
  };

  /** Track-local position of the playhead within the currently-playing track (seconds from its t=0). 0 when nothing is loaded. */
  currentPosition(): number {
    if (!this.current || this.current.durationOffset === null) return 0;
    return Math.max(0, this.audio.currentTime - this.current.durationOffset);
  }

  /** Buffered ranges intersected with the current track and translated into its local timeline (seconds from t=0, clipped to its length). Empty when nothing is loaded. */
  currentBuffered(): Range[] {
    const entry = this.current;
    if (!entry || entry.durationOffset === null) return [];
    const offset = entry.durationOffset;
    const tail = trackEncodedEnd(entry) ?? offset + entry.totalSeconds;
    const upper = tail - offset;
    const out: Range[] = [];
    for (const r of this.bufferedRanges()) {
      const start = Math.max(0, r.start - offset);
      const end = Math.min(upper, r.end - offset);
      if (end > start) out.push({ start, end });
    }
    return out;
  }

  /** Seconds of the current track the server has finished encoding so far, in track-local time. Equals `currentTrackEncodedEnd()` once the manifest reports `done`. 0 when nothing is loaded. */
  currentTrackReadySeconds(): number {
    const entry = this.current;
    if (!entry) return 0;
    const chunks = entry.manifest.chunks;
    if (entry.manifest.done && chunks.length > 0) return chunks[chunks.length - 1]!.endSeconds;
    return entry.manifest.durationSeconds;
  }

  /** Final encoded length of the current track in track-local seconds, or `null` if its manifest hasn't reported `done`. */
  currentTrackEncodedEnd(): number | null {
    const entry = this.current;
    if (!entry || !entry.manifest.done) return null;
    const chunks = entry.manifest.chunks;
    return chunks.length > 0 ? chunks[chunks.length - 1]!.endSeconds : null;
  }

  /** Seek to `time` *within* the track identified by `trackId`. Clamps to the track's nominal `totalSeconds` (not its currently-encoded length) so a seek into an un-encoded region just stalls waiting for the chunk to arrive, rather than landing past the `next.durationOffset` boundary and being misinterpreted as a track change. */
  seekTo(trackId: string, time: number): void {
    if (this.disposed) return;
    const entry = this.entryById(trackId);
    if (!entry || entry.durationOffset === null) return;
    const clamped = Math.max(0, Math.min(time, entry.totalSeconds));
    this.audio.currentTime = entry.durationOffset + clamped;
  }

  /** Tear the player down: abort in-flight fetches, close every manifest subscription, detach audio-element + SourceBuffer listeners, and revoke the blob URL. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.current) this.unsubscribeEntry(this.current);
    if (this.next) this.unsubscribeEntry(this.next);
    this.qualityByStart.clear();
    this.upgradedStarts.clear();
    this.cancelAllPending();
    this.stopWatchdog();
    this.audio.removeEventListener('timeupdate', this.onTick);
    this.audio.removeEventListener('seeking', this.onTick);
    this.audio.removeEventListener('play', this.startWatchdog);
    this.audio.removeEventListener('pause', this.stopWatchdog);
    this.audio.removeEventListener('ended', this.stopWatchdog);
    try {
      this.sourceBuffer.removeEventListener('updateend', this.onTick);
    } catch {
      // SourceBuffer may already be detached from the MediaSource.
    }
    // We deliberately don't call `endOfStream()` here. The MediaSource detaches when the audio
    // element is thrown away or its src is reassigned; calling endOfStream first clamps duration
    // to the buffered tail and can race the detach into a spurious `ended` event.
    URL.revokeObjectURL(this.blobUrl);
  }

  /** Seat `track` as the current slot (offset 0), clear `next`, subscribe its manifest, and fire `onTrackChange`. */
  private installCurrent(track: QueuedTrack): void {
    const entry = this.makeEntry(track, 0);
    this.current = entry;
    this.next = null;
    this.nextRequested = false;
    this.nextEnded = false;
    this.subscribeEntry(entry);
    this.extendMediaSourceDuration();
    this.setCurrentTrack(entry.id);
    this.tick();
  }

  /** Wipe-and-reload path of `init`: different id (any codec). Cancels pending, clears the append queue, removes buffered audio, installs the new current, and seeks. The next `drainAppendQueue` call will `changeType` if the new track's codec differs from what the parser is set up for. */
  private replaceCurrent(track: QueuedTrack, startAt: number): void {
    this.cancelAllPending();
    this.appendQueue = [];
    if (this.current) this.unsubscribeEntry(this.current);
    if (this.next) this.unsubscribeEntry(this.next);
    this.qualityByStart.clear();
    this.upgradedStarts.clear();
    this.desiredQuality = null;
    this.reportedQuality = null;
    this.lastUncoveredFetch = null;
    this.mediaSourceDurationCap = 0;
    this.lastInitAppendedFor = null;
    const ranges = this.bufferedRanges();
    if (ranges.length > 0) this.tryRemove(0, Number.POSITIVE_INFINITY);
    this.installCurrent(track);
    this.audio.currentTime = startAt;
  }

  /** Live-tier branch of `init`: same id (same codec — bitrate switches keep the codec). Repoints `current` at the new URL/quality/manifest source without seeking; the existing buffer plays out while reconcile's upgrade loop re-fetches chunks at the new tier. Drops `next` (its URL was at the old tier). */
  private liveSwap(track: QueuedTrack): void {
    const entry = this.current!;
    this.cancelPendingForTrack(entry.id);
    this.appendQueue = this.appendQueue.filter((it) => it.trackId !== entry.id);
    entry.url = track.url;
    entry.quality = track.quality;
    entry.manifest = EMPTY_MANIFEST;
    entry.subscribeManifest = track.subscribeManifest;
    this.lastUncoveredFetch = null;
    this.desiredQuality = { trackId: entry.id, quality: track.quality };
    this.upgradedStarts.clear();
    this.subscribeEntry(entry);
    if (this.next) {
      this.unsubscribeEntry(this.next);
      this.next = null;
    }
    this.nextRequested = false;
    this.nextEnded = false;
    this.tick();
  }

  private makeEntry(track: QueuedTrack, durationOffset: number | null): TrackEntry {
    return {
      id: track.id,
      url: track.url,
      contentType: track.contentType,
      quality: track.quality,
      totalSeconds: track.totalSeconds,
      manifest: EMPTY_MANIFEST,
      appendedInit: false,
      durationOffset,
      initBytes: null,
      subscribeManifest: track.subscribeManifest,
      unsubManifest: null,
    };
  }

  private entryById(trackId: string): TrackEntry | null {
    if (this.current?.id === trackId) return this.current;
    if (this.next?.id === trackId) return this.next;
    return null;
  }

  private liveEntries(): TrackEntry[] {
    const out: TrackEntry[] = [];
    if (this.current) out.push(this.current);
    if (this.next) out.push(this.next);
    return out;
  }

  /** Find the live entry whose [offset, upper) contains `t`. Entries whose offset isn't yet resolved are skipped — playback can't reach them. */
  private trackAtTime(t: number): TrackEntry | null {
    for (const e of this.liveEntries()) {
      if (e.durationOffset === null) continue;
      const upper = trackEncodedEnd(e) ?? e.durationOffset + e.totalSeconds;
      if (e.durationOffset - PLAYHEAD_EPS <= t && t < upper) return e;
    }
    return null;
  }

  private subscribeEntry(entry: TrackEntry): void {
    this.unsubscribeEntry(entry);
    const id = entry.id;
    entry.unsubManifest = entry.subscribeManifest(entry.quality, (m) => {
      this.applyManifest(id, m);
    });
  }

  private unsubscribeEntry(entry: TrackEntry): void {
    entry.unsubManifest?.();
    entry.unsubManifest = null;
  }

  private setCurrentTrack(trackId: string): void {
    if (this.currentTrackId === trackId) return;
    this.currentTrackId = trackId;
    this.options.onTrackChange?.(trackId);
  }

  /** Called by each entry's `subscribeManifest` on every emission. Records the snapshot, fires `onReadyChange` if the current track grew, and (when `current` first reaches `done`) resolves `next`'s offset so its chunks become fetchable. */
  private applyManifest(trackId: string, m: ManifestSnapshot): void {
    const entry = this.entryById(trackId);
    if (!entry) return;
    const wasDone = entry.manifest.done;
    entry.manifest = m;
    if (m.done && !wasDone) this.resolveNextOffset();
    this.extendMediaSourceDuration();
    if (entry === this.current) this.options.onReadyChange?.();
    this.tick();
  }

  /** When `current` finishes encoding and `next` exists without an offset, anchor `next` to `current`'s nominal end (`durationOffset + totalSeconds`). We trust `totalSeconds` rather than `chunks[last].endSeconds` so the boundary lines up with what the UI calls the end of the current track — anchoring to the actual encoded tail would let a slider drag into the last second of a track (still "current" from the UI's view) land past `next.durationOffset` and fire `onTrackChange` prematurely. Any drift between the backend's encoded length and `totalSeconds` is a server-side bug. */
  private resolveNextOffset(): void {
    if (!this.next || this.next.durationOffset !== null) return;
    if (!this.current || this.current.durationOffset === null) return;
    if (!this.current.manifest.done) return;
    this.next.durationOffset = this.current.durationOffset + this.current.totalSeconds;
  }

  /** Push `MediaSource.duration` up to cover the live slots' full nominal span. We deliberately use `totalSeconds` rather than `trackEncodedEnd`: the encoded tail is partial while a track is still encoding, and clamping `duration` to it would let the audio element treat a mid-track seek into the un-encoded region as "past the end", fire `ended`, and trigger a track-skip. Extend-only — assigning below the buffered tail throws. */
  private extendMediaSourceDuration(): void {
    let total = 0;
    for (const e of this.liveEntries()) {
      if (e.durationOffset !== null) {
        total = Math.max(total, e.durationOffset + e.totalSeconds);
      } else {
        total += e.totalSeconds;
      }
    }
    if (total <= this.mediaSourceDurationCap) return;
    if (this.mediaSource.readyState !== 'open' || this.sourceBuffer.updating) return;
    // Only stamp the cap once the setter actually accepts the value. Updating the cap before the
    // set lets a no-op call (e.g. during `replaceCurrent`'s pending `tryRemove`) lock us out of
    // ever extending duration — every subsequent call sees `total <= cap` and short-circuits,
    // leaving `mediaSource.duration` stuck at whatever appendBuffer's auto-extension reaches.
    try {
      this.mediaSource.duration = total;
      this.mediaSourceDurationCap = total;
    } catch {
      // Browser refused (e.g. mid-update) — non-fatal; a later tick retries.
    }
  }

  private onTick = (): void => {
    this.tick();
  };

  /** The orchestration loop, fired by `updateend`/`timeupdate`/`seeking` and by internal state transitions. Runs reconcile, advances slots on a boundary cross, kicks off the preload thunk, ends the stream when due, and reports quality changes. */
  private tick(): void {
    this.trackPlayheadStability();
    this.reconcile();
    // Retry on every tick — the initial call from `installCurrent` (or a manifest emission) can
    // bail when `sourceBuffer.updating` is true, and `updateend` then re-enters `tick` here with
    // updating false so the duration setter finally takes.
    this.extendMediaSourceDuration();
    this.updateCurrentTrack();
    this.maybeInvokeTrackNext();
    this.tryEndOfStream();
    this.reportQuality();
  }

  /** Track when `audio.currentTime` last changed. The wall-clock-vs-playhead delta lets `updateCurrentTrack` distinguish "audio stalled" from "audio playing through this position". Reset on pause/seek so those states never look like a stall. */
  private trackPlayheadStability(): void {
    const t = this.audio.currentTime;
    if (this.audio.paused || this.audio.seeking || t !== this.observedPlayhead) {
      this.observedPlayhead = t;
      this.observedPlayheadAt = performance.now();
    }
  }

  /** Detect the playhead crossing into `next`. Shift slots, fire `onTrackChange`, reset preload flags. Bridges the gap that opens when `current`'s actual playable end falls short of `next.durationOffset` (codec padding, encoder overhead, frame-boundary rounding) when `audio.currentTime` is *both* stuck for `BOUNDARY_STALL_MS` of wall-clock time *and* close enough to `current`'s encoded end that there's no more content for it to play. The encoded-end check is essential: without it, a mid-track buffering stall (slow network, chunk fetch lagging) would look the same as an end-of-track stall and skip the rest of the song. */
  private updateCurrentTrack(): void {
    if (!this.next || this.next.durationOffset === null) return;
    const boundary = this.next.durationOffset;
    let cross = this.audio.currentTime >= boundary;
    if (
      !cross &&
      this.current?.manifest.done &&
      !this.audio.paused &&
      !this.audio.seeking &&
      this.audio.currentTime < boundary &&
      performance.now() - this.observedPlayheadAt > BOUNDARY_STALL_MS
    ) {
      const tail = trackEncodedEnd(this.current);
      // Only bridge when there's effectively no current-track content left to play. The 2s window
      // covers browser-rounded `currentTime` (Firefox privacy rounding tops out around 1s) without
      // false-positiving a mid-track buffering stall — at 120/200 the gap is 80s, well outside.
      if (tail !== null && tail - this.audio.currentTime < 2) {
        this.audio.currentTime = boundary;
        cross = true;
      }
    }
    if (!cross) return;
    if (this.current) this.unsubscribeEntry(this.current);
    this.current = this.next;
    this.next = null;
    this.nextRequested = false;
    this.nextEnded = false;
    this.setCurrentTrack(this.current.id);
  }

  /** Kick off `trackNext()` when the playhead is within the preload window and we don't already have a successor lined up. */
  private maybeInvokeTrackNext(): void {
    if (this.disposed || this.nextRequested || this.nextEnded) return;
    if (!this.current || this.next) return;
    if (this.current.durationOffset === null) return;
    const tail =
      trackEncodedEnd(this.current) ?? this.current.durationOffset + this.current.totalSeconds;
    if (tail - this.audio.currentTime > NEXT_TRACK_PRELOAD_SECONDS) return;
    this.nextRequested = true;
    void this.invokeTrackNext();
  }

  /** Await the caller's `trackNext` thunk and react: `null` → end the stream after `current`; codec mismatch → same (caller's `ended` handler reloads); match → build entry, seat as `next`, resolve its offset if `current` is done, subscribe its manifest. */
  private async invokeTrackNext(): Promise<void> {
    let result: QueuedTrack | null = null;
    try {
      result = await this.trackNext();
    } catch {
      // Treat a thrown thunk the same as `null` — the audio plays out and `ended` lets the caller
      // recover (e.g. retry on the next manual action).
    }
    if (this.disposed) return;
    if (!result) {
      this.nextEnded = true;
      this.tick();
      return;
    }
    if (!MediaSource.isTypeSupported(result.contentType)) {
      // Browser can't decode the successor's codec at all. Let `current` play out; `MediaSource
      // .endOfStream()` fires on its tail and the caller's `ended` → `step('next')` chain may
      // surface the unsupported-codec error to the user via the standard load path.
      this.nextEnded = true;
      this.tick();
      return;
    }
    const entry = this.makeEntry(result, null);
    this.next = entry;
    this.resolveNextOffset();
    this.subscribeEntry(entry);
    this.extendMediaSourceDuration();
    this.tick();
  }

  private isLive(): boolean {
    // 'ended' is still operable: remove() is allowed and appendBuffer() re-opens the source. Only a detached ('closed') source is dead. Gating on 'open' alone strands a seek-back after tryEndOfStream() ends the source.
    return !this.disposed && this.mediaSource.readyState !== 'closed';
  }

  private bufferedRanges(): Range[] {
    return bufferedRanges(this.sourceBuffer);
  }

  /** Report the quality of the chunk under the playhead when it changes. Keeps the last value while the playhead sits over a not-yet-fetched region, rather than flickering to `null`. */
  private reportQuality(): void {
    const entry = this.trackAtTime(this.audio.currentTime);
    if (!entry || entry.durationOffset === null) return;
    const localT = this.audio.currentTime - entry.durationOffset;
    const chunkIdx = findChunkAtTime(entry.manifest.chunks, localT);
    if (chunkIdx < 0) return;
    const concatStart = entry.durationOffset + chunkStartSeconds(entry.manifest.chunks, chunkIdx);
    const q = this.qualityByStart.get(Math.round(concatStart));
    if (q && q !== this.reportedQuality) {
      this.reportedQuality = q;
      this.options.onQuality?.(q);
    }
  }

  /** The single control loop. Issues at most one SourceBuffer operation (append/remove) or one fetch per call; the resulting `updateend`/completion re-invokes it until the buffer matches the desired window across `current` + `next`. */
  private reconcile(): void {
    if (!this.isLive() || this.sourceBuffer.updating) return;
    if (this.appendQueue.length > 0) {
      this.drainAppendQueue();
      return;
    }
    if (!this.current) return;

    const t = this.audio.currentTime;
    const ranges = this.bufferedRanges();

    // 1. Playhead has no data → fetch the chunk under it (or wait if no track contains `t`).
    if (!coversTime(ranges, t)) {
      const entry = this.trackAtTime(t);
      if (!entry) return;
      if (entry.durationOffset === null) return;

      if (entry.manifest.init && !entry.appendedInit) {
        const key = pendingKey(entry.id, -1);
        if (!this.pending.has(key)) void this.fetchInit(entry);
        return;
      }

      const localT = t - entry.durationOffset;
      const chunks = entry.manifest.chunks;
      const chunkIdx = findChunkAtTime(chunks, localT);
      const key = chunkIdx >= 0 ? pendingKey(entry.id, chunkIdx) : null;
      if (
        key &&
        (this.pending.has(key) ||
          this.appendQueue.some((q) => q.trackId === entry.id && q.chunkIndex === chunkIdx))
      ) {
        return;
      }
      if (key && key === this.lastUncoveredFetch && ranges.length > 0) {
        const target = ranges.find((r) => r.end > t) ?? ranges[0]!;
        this.audio.currentTime = target.start;
        return;
      }
      // Wipe. Parser config survives `remove()`, so `appendedInit` and `lastInitAppendedFor`
      // stay intact (a `changeType` is the only thing that resets the parser).
      this.cancelAllPending();
      this.appendQueue = [];
      if (ranges.length > 0) {
        this.tryRemove(0, Number.POSITIVE_INFINITY);
        return;
      }
      if (chunkIdx >= 0 && key) {
        this.lastUncoveredFetch = key;
        void this.fetchChunk(entry, chunkIdx);
      }
      return;
    }

    this.lastUncoveredFetch = null;

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
      for (const [key, ctrl] of this.pending) {
        const parsed = parsePendingKey(key);
        if (!parsed || parsed.chunkIndex < 0) continue;
        const entry = this.entryById(parsed.trackId);
        if (!entry || entry.durationOffset === null) continue;
        const chunk = entry.manifest.chunks[parsed.chunkIndex];
        if (!chunk) continue;
        const absStart =
          entry.durationOffset + chunkStartSeconds(entry.manifest.chunks, parsed.chunkIndex);
        const absEnd = entry.durationOffset + chunk.endSeconds;
        if (absStart >= fetchEnd || absEnd <= t) {
          ctrl.abort();
          this.pending.delete(key);
        }
      }
      return;
    }

    // 4. Walk current → next within [t, fetchEnd), fetching the first unbuffered chunk we find.
    const live = this.liveEntries();
    const startEntry = this.trackAtTime(t);
    const startIdx = startEntry ? live.indexOf(startEntry) : -1;
    if (startIdx < 0) return;
    for (let i = startIdx; i < live.length; i++) {
      const entry = live[i]!;
      if (entry.durationOffset === null) break;
      if (entry.durationOffset >= fetchEnd) break;
      if (entry.manifest.init && !entry.appendedInit) {
        const key = pendingKey(entry.id, -1);
        if (!this.pending.has(key)) {
          void this.fetchInit(entry);
          return;
        }
      }
      const chunks = entry.manifest.chunks;
      const localStart = i === startIdx ? t - entry.durationOffset : 0;
      const localFetchEnd = fetchEnd - entry.durationOffset;
      const fromIdx = Math.max(0, findChunkAtTime(chunks, localStart));
      for (let j = fromIdx; j < chunks.length; j++) {
        const cs = chunkStartSeconds(chunks, j);
        if (cs >= localFetchEnd) break;
        const ce = chunks[j]!.endSeconds;
        const mid = (Math.max(cs, localStart) + ce) / 2;
        if (!coversTime(ranges, entry.durationOffset + mid)) {
          void this.fetchChunk(entry, j);
          return;
        }
      }
    }

    // 5. After a live tier switch, re-fetch buffered-ahead chunks of the switched track still at
    // the old tier. Lowest priority — only reached once the forward window is fully buffered.
    if (!this.desiredQuality) return;
    const target = this.entryById(this.desiredQuality.trackId);
    if (!target || target.durationOffset === null) return;
    const chunks = target.manifest.chunks;
    const localStart = Math.max(0, t - target.durationOffset);
    const localFetchEnd = fetchEnd - target.durationOffset;
    const fromIdx = Math.max(0, findChunkAtTime(chunks, localStart));
    for (let j = fromIdx; j < chunks.length; j++) {
      const cs = chunkStartSeconds(chunks, j);
      if (cs >= localFetchEnd) break;
      const concatKey = Math.round(target.durationOffset + cs);
      if (this.upgradedStarts.has(concatKey)) continue;
      const ce = chunks[j]!.endSeconds;
      const mid = (Math.max(cs, localStart) + ce) / 2;
      if (!coversTime(ranges, target.durationOffset + mid)) continue;
      const q = this.qualityByStart.get(concatKey);
      if (q !== undefined && q !== this.desiredQuality.quality) {
        this.upgradedStarts.add(concatKey);
        void this.fetchChunk(target, j);
        return;
      }
    }
  }

  private cancelAllPending(): void {
    for (const ctrl of this.pending.values()) ctrl.abort();
    this.pending.clear();
  }

  private cancelPendingForTrack(trackId: string): void {
    for (const [key, ctrl] of this.pending) {
      const parsed = parsePendingKey(key);
      if (parsed?.trackId === trackId) {
        ctrl.abort();
        this.pending.delete(key);
      }
    }
  }

  /** Fetch (or re-use cached) init bytes for `entry`, push them to the front of the append queue, and drain. Cached bytes survive a buffer wipe so the post-wipe re-append doesn't need a network round-trip. */
  private async fetchInit(entry: TrackEntry): Promise<void> {
    const init = entry.manifest.init;
    if (!init || entry.durationOffset === null) return;
    if (entry.initBytes) {
      this.appendQueue.unshift({
        trackId: entry.id,
        chunkIndex: -1,
        data: entry.initBytes,
        absStartSeconds: entry.durationOffset,
      });
      this.drainAppendQueue();
      return;
    }
    const key = pendingKey(entry.id, -1);
    const ctrl = new AbortController();
    this.pending.set(key, ctrl);
    try {
      const res = await this.fetchRange(entry.url, init.byteStart, init.byteEnd, ctrl.signal);
      if (!res || this.disposed || ctrl.signal.aborted) return;
      entry.initBytes = res.data;
      this.appendQueue.unshift({
        trackId: entry.id,
        chunkIndex: -1,
        data: res.data,
        absStartSeconds: entry.durationOffset,
      });
      this.drainAppendQueue();
    } finally {
      this.pending.delete(key);
    }
  }

  /** Fetch `entry`'s chunk at `chunkIndex`, record its `X-Quality`, and push to the append queue. */
  private async fetchChunk(entry: TrackEntry, chunkIndex: number): Promise<void> {
    const chunk = entry.manifest.chunks[chunkIndex];
    if (!chunk || entry.durationOffset === null) return;
    const key = pendingKey(entry.id, chunkIndex);
    const ctrl = new AbortController();
    this.pending.set(key, ctrl);
    const localStart = chunkStartSeconds(entry.manifest.chunks, chunkIndex);
    const absStart = entry.durationOffset + localStart;
    try {
      const res = await this.fetchRange(
        entry.url,
        chunk.byteStart,
        chunk.byteEnd,
        ctrl.signal,
        this.options.onTransfer,
      );
      if (!res || this.disposed || ctrl.signal.aborted) return;
      if (res.quality) {
        this.qualityByStart.set(Math.round(absStart), res.quality);
      }
      this.appendQueue.push({
        trackId: entry.id,
        chunkIndex,
        data: res.data,
        absStartSeconds: absStart,
      });
      this.drainAppendQueue();
    } finally {
      this.pending.delete(key);
    }
  }

  /** Issue a HTTP `Range` request and stream the response. Returns the body bytes and the `X-Quality` header. When `onTransfer` is supplied (chunk fetches only — init segments skip it), fires periodic mid-flight rate samples once `TRANSFER_MIN_MS` of body has been read (so TCP slow-start doesn't distort the first reading), then a final sample with `chunkFinished = true`. */
  private async fetchRange(
    url: string,
    byteStart: number,
    byteEnd: number,
    signal: AbortSignal,
    onTransfer?: (bitsPerSecond: number, chunkFinished: boolean) => void,
  ): Promise<{ data: Uint8Array; quality: string | null } | null> {
    try {
      const res = await fetch(url, {
        signal,
        headers: { Range: `bytes=${byteStart}-${byteEnd - 1}` },
      });
      if (!res.ok) return null;
      const quality = res.headers.get('X-Quality');
      // Stream the body so we can time first-byte → last-byte (line speed) rather than including
      // the request's TTFB, which on this route is dominated by encode-wait, not the network.
      const reader = res.body?.getReader();
      if (!reader) {
        return { data: new Uint8Array(await res.arrayBuffer()), quality };
      }
      const parts: Uint8Array[] = [];
      let total = 0;
      let firstByteAt = 0;
      let lastReportAt = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteAt === 0) firstByteAt = performance.now();
        parts.push(value);
        total += value.byteLength;
        if (onTransfer) {
          const elapsed = performance.now() - firstByteAt;
          if (elapsed >= TRANSFER_MIN_MS && elapsed - lastReportAt >= PROGRESS_INTERVAL_MS) {
            lastReportAt = elapsed;
            onTransfer(bitsPerSecond(total, elapsed), false);
          }
        }
      }
      if (onTransfer && firstByteAt !== 0) {
        const transferMs = performance.now() - firstByteAt;
        if (transferMs > 0) onTransfer(bitsPerSecond(total, transferMs), true);
      }
      const data = parts.length === 1 ? parts[0]! : concatChunks(parts, total);
      return { data, quality };
    } catch {
      return null;
    }
  }

  /** Pick the next eligible item from the append queue and hand it to the SourceBuffer. Eligibility: an init item, or a media item whose track's init has already landed. Before appending, switches the parser's codec via `SourceBuffer.changeType` if the item's track contentType differs from the parser's current config; re-appends the target track's cached init if the parser was configured for a different track. */
  private drainAppendQueue(): void {
    if (!this.isLive() || this.sourceBuffer.updating) return;
    if (this.appendQueue.length === 0) return;

    let pickIdx = -1;
    for (let i = 0; i < this.appendQueue.length; i++) {
      const item = this.appendQueue[i]!;
      const entry = this.entryById(item.trackId);
      if (!entry) continue;
      if (item.chunkIndex === -1) {
        pickIdx = i;
        break;
      }
      if (!entry.manifest.init || entry.appendedInit) {
        pickIdx = i;
        break;
      }
    }
    if (pickIdx === -1) return;

    const candidate = this.appendQueue[pickIdx]!;
    const entry = this.entryById(candidate.trackId)!;

    // Codec switch: if the parser's currently configured for a different contentType, reconfigure
    // it. `changeType` resets the parser, so we also invalidate `lastInitAppendedFor` — the init
    // will be re-appended below. Recompute `setTimestampOffsetPerChunk` for the new container.
    if (this.parserContentType !== entry.contentType) {
      try {
        this.sourceBuffer.changeType(entry.contentType);
      } catch (err) {
        // The browser refused (e.g. NotSupportedError). Treat like a quota exhaustion — the
        // mediasource is permanently mis-configured for this codec; bail rather than loop.
        if ((err as DOMException).name !== 'QuotaExceededError') return;
        return;
      }
      this.parserContentType = entry.contentType;
      this.setTimestampOffsetPerChunk = entry.contentType.startsWith('audio/mpeg');
      this.lastInitAppendedFor = null;
    }

    if (
      candidate.chunkIndex >= 0 &&
      entry.manifest.init &&
      entry.initBytes &&
      this.lastInitAppendedFor !== entry.id
    ) {
      try {
        this.sourceBuffer.appendBuffer(entry.initBytes.buffer as ArrayBuffer);
        this.lastInitAppendedFor = entry.id;
      } catch (err) {
        if ((err as DOMException).name !== 'QuotaExceededError') return;
      }
      return;
    }

    const next = this.appendQueue.splice(pickIdx, 1)[0]!;
    try {
      if (next.chunkIndex >= 0) {
        if (this.setTimestampOffsetPerChunk) {
          this.sourceBuffer.timestampOffset = next.absStartSeconds;
        } else if (entry.durationOffset !== null) {
          this.sourceBuffer.timestampOffset = entry.durationOffset;
        }
      }
      this.sourceBuffer.appendBuffer(next.data.buffer as ArrayBuffer);
      if (next.chunkIndex === -1) {
        entry.appendedInit = true;
        this.lastInitAppendedFor = entry.id;
      }
    } catch (err) {
      if ((err as DOMException).name === 'QuotaExceededError' && this.isLive()) {
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

  /** Fire `MediaSource.endOfStream()` once `nextEnded` is set and `current`'s tail is buffered. Gated on `readyState === 'open'` so we don't re-invoke after the source has already ended (a seek-back can leave the source in `'ended'`). */
  private tryEndOfStream(): void {
    if (!this.nextEnded || this.disposed || this.mediaSource.readyState !== 'open') return;
    if (this.sourceBuffer.updating || this.appendQueue.length > 0) return;
    if (!this.current) return;
    if (!this.current.manifest.done) return;
    const tail = trackEncodedEnd(this.current);
    if (tail === null || tail <= 0) return;
    const ranges = this.bufferedRanges();
    const lastRange = ranges[ranges.length - 1];
    if (!lastRange || lastRange.end < tail - 0.5) return;
    try {
      this.mediaSource.endOfStream();
    } catch {
      // Already ended or closing.
    }
  }
}
