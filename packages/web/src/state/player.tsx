import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { readFragment } from 'gql.tada';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { PlaybackBarDocument } from '../components/playback-bar.tsx';
import { TracksDocument } from '../components/track-list.tsx';
import { getAudioElement } from '../lib/audio-element.ts';
import { type Capabilities, capabilities, type LossyPreference } from '../lib/capabilities.ts';
import { graphql, type ResultOf, type VariablesOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { type CreatePlayerOptions, MsePlayer, type QueuedTrack } from '../lib/mse.ts';
import { subscribe as subscribeToStream } from '../lib/sse-client.ts';

export const TrackByIdDocument = graphql(
  `
    query TrackById($id: ID!, $format: TrackFormat) {
      track(id: $id) {
        id
        delivery(format: $format) {
          url
          mimeType
          isPassthrough
          description
          tiers {
            quality
            bitrateKbps
          }
        }
        ...PlaybackBar
      }
    }
  `,
  [PlaybackBarDocument],
);

export const TrackManifestDocument = graphql(`
  subscription TrackManifest($trackId: ID!, $format: TrackFormat!) {
    trackManifest(trackId: $trackId, format: $format) {
      durationSeconds
      done
      init {
        byteStart
        byteEnd
      }
      chunks {
        byteStart
        byteEnd
        endSeconds
      }
    }
  }
`);

/** Derived from the `TrackById` variables so the frontend's enum strings can't drift from the GraphQL schema. */
export type TrackFormat = NonNullable<VariablesOf<typeof TrackByIdDocument>['format']>;
export type Quality = TrackFormat['quality'];

/**
 * The user-facing playback setting. `ADAPTIVE` automatically picks a lossy tier from the measured connection speed; `ORIGINAL` asks for the best representation of the source (lossless or a copy) and assumes the connection can sustain it. The five `Quality` tiers remain the wire-level requests: `ORIGINAL` maps to `MAX`, `ADAPTIVE` to one of the ladder tiers chosen at runtime.
 */
export type QualityMode = 'ADAPTIVE' | 'ORIGINAL';

/** Lossy tiers the adaptive controller climbs/drops between, ascending. `MAX` is excluded — it's the `ORIGINAL` request, where the codec may differ (lossless/copy). */
const ADAPTIVE_LADDER: readonly Quality[] = ['MIN', 'LOW', 'MEDIUM', 'HIGH'];

/** Server-emitted manifest snapshot. The player consumes this shape directly. */
export type ManifestSnapshot = NonNullable<ResultOf<typeof TrackManifestDocument>['trackManifest']>;
export type ManifestChunk = ManifestSnapshot['chunks'][number];

type TrackNode = NonNullable<ResultOf<typeof TrackByIdDocument>['track']>;
/** The resolved delivery plan for the current track, as returned by the server. */
export type Delivery = TrackNode['delivery'];

/** Build the `TrackFormat` to request: quality plus the capability-derived MIME lists, with the lossy list ordered by the user's codec preference. */
export function trackFormatFor(quality: Quality, preference: LossyPreference): TrackFormat {
  return {
    quality,
    losslessFormats: capabilities.losslessFormats,
    lossyFormats: capabilities.lossyFormats(preference),
  };
}

export function isLossyPreferenceAvailable(
  p: LossyPreference,
  caps: Capabilities = capabilities,
): boolean {
  return p === 'OPUS' ? caps.opusSupported : caps.mp3Supported;
}

export function defaultLossyPreference(caps: Capabilities = capabilities): LossyPreference {
  return caps.opusSupported ? 'OPUS' : 'MP3';
}

const MODE_STORAGE_KEY = 'lofify.player.quality-mode';
const ADAPTIVE_TIER_STORAGE_KEY = 'lofify.player.adaptive-tier';
const LEGACY_QUALITY_STORAGE_KEY = 'lofify.player.quality';
const FORMAT_STORAGE_KEY = 'lofify.player.lossy-preference';
const FORMAT_VALUES: readonly LossyPreference[] = ['OPUS', 'MP3'];

// Adaptive controller tuning. The decision compares the most recently observed download speed
// against each tier's advertised data rate, gated on buffer health, with a cooldown so it can't
// flap. No smoothing: line speed is bursty (a 5G→LTE handover is a step-change a moving average
// would lag), so we track the current observation and lean on the cooldown + hysteresis to stay
// stable rather than averaging the responsiveness away.
/** Step up only when the connection can pull this many times the current tier's bitrate. */
const UP_FACTOR = 2;
/** Step down when throughput drops below this multiple of the current tier's bitrate. */
const DOWN_FACTOR = 1.3;
/** Step up only when this much is buffered ahead, so a brief spike doesn't over-commit. */
const BUFFER_HIGH_SECONDS = 20;
/** Minimum gap between tier switches. */
const SWITCH_COOLDOWN_MS = 5000;
/** Ignore in-flight download progress until this much body has transferred, so TCP slow-start doesn't trigger a spurious drop. */
const INFLIGHT_MIN_MS = 500;

const GRAPHQL_URL = import.meta.env.VITE_GRAPHQL_URL ?? '/graphql';

/** Lock-screen / notification artwork for the Media Session. The app icon stands in until the schema carries per-track cover art. */
const MEDIA_ARTWORK = [
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
];

function hasMediaSession(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

function backendOrigin(): string {
  try {
    return new URL(GRAPHQL_URL, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

export function resolvePlaybackUrl(url: string): string {
  if (/^https?:/i.test(url)) return url;
  return `${backendOrigin()}${url}`;
}

function loadStoredMode(): QualityMode {
  if (typeof window === 'undefined') return 'ADAPTIVE';
  // Force Adaptive in a PWA: gapless cross-track buffering needs a single codec, which only Adaptive guarantees. See QualityPicker / lib/mse.ts for the rationale.
  if (capabilities.standalone) return 'ADAPTIVE';
  const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
  if (stored === 'ADAPTIVE' || stored === 'ORIGINAL') return stored;
  // Migrate the pre-adaptive single-tier setting: `MAX` becomes Original, any lower tier Adaptive.
  return window.localStorage.getItem(LEGACY_QUALITY_STORAGE_KEY) === 'MAX'
    ? 'ORIGINAL'
    : 'ADAPTIVE';
}

/** The tier Adaptive starts a track at: where the last session left off (cold start `LOW`). Table-free — only the chosen tier is remembered, so there's no bandwidth-to-tier mapping to maintain. */
function loadStoredAdaptiveTier(): Quality {
  const onLadder = (v: string | null): v is Quality =>
    v !== null && (ADAPTIVE_LADDER as readonly string[]).includes(v);
  if (typeof window === 'undefined') return 'LOW';
  const stored = window.localStorage.getItem(ADAPTIVE_TIER_STORAGE_KEY);
  if (onLadder(stored)) return stored;
  const legacy = window.localStorage.getItem(LEGACY_QUALITY_STORAGE_KEY);
  return onLadder(legacy) ? legacy : 'LOW';
}

function initialActiveTier(): Quality {
  return loadStoredMode() === 'ORIGINAL' ? 'MAX' : loadStoredAdaptiveTier();
}

function loadStoredLossyPreference(): LossyPreference {
  if (typeof window === 'undefined') return defaultLossyPreference();
  const stored = window.localStorage.getItem(FORMAT_STORAGE_KEY);
  if (stored && (FORMAT_VALUES as readonly string[]).includes(stored)) {
    const p = stored as LossyPreference;
    if (!isLossyPreferenceAvailable(p)) return defaultLossyPreference();
    return p;
  }
  return defaultLossyPreference();
}

const URL_TRACK_PARAM = 'track';
const URL_TIME_PARAM = 't';
/** Throttle for writing the playhead to the URL during playback; a pause flushes immediately. */
const URL_WRITE_THROTTLE_MS = 2000;

/** Read the track id and start position the last session left in the URL, so a refresh resumes where it left off. `null` when no track is encoded. */
function readPlaybackFromUrl(): { trackId: string; startAt: number } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const trackId = params.get(URL_TRACK_PARAM);
  if (!trackId) return null;
  const t = Number(params.get(URL_TIME_PARAM));
  const startAt = Number.isFinite(t) && t > 0 ? t : 0;
  return { trackId, startAt };
}

/** Mirror the current track and playhead into the URL (`replaceState`, so the back button doesn't walk through every position). A null `trackId` clears both params. */
function writePlaybackToUrl(trackId: string | null, seconds: number): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (trackId) {
    url.searchParams.set(URL_TRACK_PARAM, trackId);
    url.searchParams.set(URL_TIME_PARAM, String(Math.round(seconds)));
  } else {
    url.searchParams.delete(URL_TRACK_PARAM);
    url.searchParams.delete(URL_TIME_PARAM);
  }
  window.history.replaceState(window.history.state, '', url);
}

/** Bytes/second as rounded kbps, for the adaptive log lines. */
function toKbps(bytesPerSecond: number): number {
  return Math.round((bytesPerSecond * 8) / 1000);
}

/** Seconds of contiguous buffer ahead of the playhead, or 0 if the playhead isn't inside a buffered range. */
function bufferedAheadSeconds(audio: HTMLAudioElement): number {
  const t = audio.currentTime;
  const b = audio.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) - 0.25 <= t && t < b.end(i)) return b.end(i) - t;
  }
  return 0;
}

export type BufferedRange = { start: number; end: number };
export type PlayerError = { message: string };

/** Everything the UI renders. Immutable: the `Player` swaps the whole object on any change, so `useSyncExternalStore` can compare snapshots by reference. */
type PlayerSnapshot = {
  current: TrackNode | null;
  isPlaying: boolean;
  positionSeconds: number;
  bufferedRanges: BufferedRange[];
  /** Seconds of the current track the server has finished encoding. */
  readySeconds: number;
  qualityMode: QualityMode;
  /** The tier currently being requested: `MAX` in Original, or the adaptive controller's live pick. */
  requestedTier: Quality;
  lossyPreference: LossyPreference;
  /** Resolved delivery plan for the current track (codec, MIME, copy-vs-transcode, description). `null` between track changes or when no track is loaded. */
  delivery: Delivery | null;
  /** Quality of the bytes currently under the playhead, from the playback `X-Quality` header. Trails `requestedTier` while a bitrate switch's old buffer drains. `null` until the first chunk is fetched. */
  playingQuality: Quality | null;
  error: PlayerError | null;
};

/**
 * Imperative playback orchestrator, held as a single long-lived instance for the provider's lifetime (an external store React reads via `useSyncExternalStore`). It owns the singleton `<audio>` element, the user's settings, and the current `MsePlayer` — which is the part rebuilt per track and on any codec-crossing change (its SourceBuffer is codec-locked). Keeping the orchestration in a class lets `loadTrack`, `changeFormat`, and the adaptive controller call each other directly, without the ref/closure gymnastics the equivalent hooks would need.
 */
class Player {
  private snapshot: PlayerSnapshot;
  private readonly listeners = new Set<() => void>();
  private mse: MsePlayer | null = null;
  /** Resolved track metadata by id, populated when a track is fetched. Looked up when the mse player reports a track change so the UI snapshot can swap to the new track without another fetch. */
  private readonly tracksById = new Map<string, TrackNode>();
  private lastSwitchAt = 0;
  /** Latest-wins guard for `changeFormat`'s async fetch. */
  private changeToken = 0;
  /** Pending debounced URL playhead write; cleared/flushed on pause and teardown. */
  private urlWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly detachers: Array<() => void> = [];

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly queryClient: QueryClient,
  ) {
    this.snapshot = {
      current: null,
      isPlaying: false,
      positionSeconds: 0,
      bufferedRanges: [],
      readySeconds: 0,
      qualityMode: loadStoredMode(),
      requestedTier: initialActiveTier(),
      lossyPreference: loadStoredLossyPreference(),
      delivery: null,
      playingQuality: null,
      error: null,
    };
  }

  /** Register a listener invoked on every snapshot change; returns an unsubscribe. The `useSyncExternalStore` contract. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current snapshot, stable by reference until the next change so `useSyncExternalStore` can skip redundant renders. */
  getSnapshot = (): PlayerSnapshot => this.snapshot;

  private set(patch: Partial<PlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Attach the audio-element listeners and return a teardown that detaches them, ends the manifest subscription, and tears down the `MsePlayer`. Drive from the provider's mount effect: `useEffect(() => player.activate(), [player])`. Guarded so a repeat call (e.g. a StrictMode remount) without a teardown in between is a no-op. */
  activate(): undefined | (() => void) {
    if (this.detachers.length > 0) return;
    this.attachAudioListeners();
    this.setupMediaSession();
    void this.restoreFromUrl();
    return () => this.dispose();
  }

  /** Re-load the track and playhead the URL carries from a previous session, paused (a fresh page load has no user gesture to satisfy autoplay). A stale/deleted id resolves to nothing and is a no-op. */
  private async restoreFromUrl(): Promise<void> {
    const saved = readPlaybackFromUrl();
    if (!saved) return;
    const track = await this.fetchTrack(
      saved.trackId,
      this.snapshot.requestedTier,
      this.snapshot.lossyPreference,
    );
    if (track) await this.loadTrack(track, saved.startAt, false);
  }

  /** Detach the audio listeners and tear down the current `MsePlayer` (which closes its per-track manifest subscriptions). The teardown returned by `activate`. */
  private dispose(): void {
    this.flushUrl();
    for (const detach of this.detachers) detach();
    this.detachers.length = 0;
    this.mse?.dispose();
    this.mse = null;
    if (hasMediaSession()) {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    }
  }

  private on(type: string, handler: () => void): void {
    this.audio.addEventListener(type, handler);
    this.detachers.push(() => this.audio.removeEventListener(type, handler));
  }

  private attachAudioListeners(): void {
    this.on('play', () => {
      this.set({ isPlaying: true });
      this.setMediaPlaybackState('playing');
    });
    this.on('pause', () => {
      this.set({ isPlaying: false });
      this.setMediaPlaybackState('paused');
      this.flushUrl();
    });
    this.on('timeupdate', () => {
      this.set({ positionSeconds: this.mse?.currentPosition() ?? 0 });
      this.updateMediaPosition();
      this.scheduleUrlWrite();
    });
    const onBuffered = () =>
      this.set({
        bufferedRanges: this.readBuffered(),
        readySeconds: this.mse?.currentTrackReadySeconds() ?? 0,
      });
    this.on('progress', onBuffered);
    this.on('seeked', onBuffered);
    this.on('loadedmetadata', onBuffered);
    this.on('emptied', onBuffered);
    // `ended` only fires after `MediaSource.endOfStream()` — which the mse player calls when the
    // queue is closed. Same-codec cross-track boundaries happen *without* `ended` (the next track's
    // bytes splice onto the buffer in the same `MediaSource`); they're handled by `onTrackChange`.
    // `endQueue` runs in two cases: no successor exists (end of library) or the next track has a
    // different codec (can't splice — needs a fresh `MsePlayer`). For the codec-mismatch case we
    // need to advance into the new codec; `step('next')` does that by reloading. For the end-of-
    // library case `step('next')` is a no-op (the query returns no successor), so the same call
    // handles both.
    // TODO: make MsePlayer support cross-codec splicing, and remove this
    this.on('ended', () => {
      this.set({ isPlaying: false });
      void this.step('next');
    });
  }

  /** Read the buffered ranges for the current track in its local timeline, for the progress bar. */
  private readBuffered(): BufferedRange[] {
    return this.mse?.currentBuffered() ?? [];
  }

  /** Register the OS media-control handlers once. These are what make a backgrounded PWA keep playing and surface lock-screen / notification controls — without them mobile platforms (iOS especially) pause hidden web audio. Idempotent: the handlers close over `this`, so re-registering is harmless. */
  private setupMediaSession(): void {
    if (!hasMediaSession()) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.togglePlay());
    ms.setActionHandler('pause', () => this.togglePlay());
    ms.setActionHandler('previoustrack', () => this.previous());
    ms.setActionHandler('nexttrack', () => this.next());
    ms.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') this.seek(details.seekTime);
    });
  }

  private setMediaPlaybackState(state: 'none' | 'paused' | 'playing'): void {
    if (hasMediaSession()) navigator.mediaSession.playbackState = state;
  }

  /** Publish the current track's title/artist/album (and stand-in artwork) to the OS. */
  private updateMediaMetadata(track: TrackNode): void {
    if (!hasMediaSession()) return;
    const meta = readFragment(PlaybackBarDocument, track);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.title ?? 'Untitled',
      artist: meta.artist ?? 'Unknown artist',
      album: meta.album ?? '',
      artwork: MEDIA_ARTWORK,
    });
  }

  /** Feed the scrub position to the OS so the lock-screen progress bar tracks playback. `setPositionState` throws on inconsistent values (position past duration, non-finite), so guard and swallow. */
  private updateMediaPosition(): void {
    if (!hasMediaSession() || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const track = this.snapshot.current;
    if (!track) return;
    const duration = readFragment(PlaybackBarDocument, track).duration.seconds;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const position = Math.min(this.mse?.currentPosition() ?? 0, duration);
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position,
        playbackRate: this.audio.playbackRate || 1,
      });
    } catch {
      // Inconsistent values mid-seek; the next timeupdate corrects it.
    }
  }

  /** Throttle URL playhead writes while playing: `timeupdate` fires ~4×/s, so write at most once per `URL_WRITE_THROTTLE_MS` rather than on every tick. Leaving an already-pending timer untouched (rather than resetting it) is what makes this a throttle, not a debounce — a debounce would never fire under a continuous event stream. */
  private scheduleUrlWrite(): void {
    if (this.urlWriteTimer !== null) return;
    this.urlWriteTimer = setTimeout(() => {
      this.urlWriteTimer = null;
      writePlaybackToUrl(this.snapshot.current?.id ?? null, this.mse?.currentPosition() ?? 0);
    }, URL_WRITE_THROTTLE_MS);
  }

  /** Cancel any pending debounced write and persist the playhead now (on pause and teardown). */
  private flushUrl(): void {
    if (this.urlWriteTimer !== null) {
      clearTimeout(this.urlWriteTimer);
      this.urlWriteTimer = null;
    }
    writePlaybackToUrl(this.snapshot.current?.id ?? null, this.mse?.currentPosition() ?? 0);
  }

  /** Load the track with id `id`, fetched at the current tier/preference, and start it from the top. */
  async play(id: string): Promise<void> {
    const track = await this.fetchTrack(
      id,
      this.snapshot.requestedTier,
      this.snapshot.lossyPreference,
    );
    if (track) await this.loadTrack(track);
  }

  /** Toggle play/pause for the loaded track. No-op when nothing is loaded. */
  togglePlay(): void {
    if (!this.snapshot.current) return;
    if (this.audio.paused) void this.audio.play().catch(() => undefined);
    else this.audio.pause();
  }

  /** Seek to `seconds` within the current track; the reconcile loop fetches the chunk under the new playhead and resumes. */
  seek(seconds: number): void {
    if (!this.mse) return;
    const track = this.snapshot.current;
    if (!track) return;
    this.set({ positionSeconds: seconds });
    this.mse.seekTo(track.id, seconds);
    void this.audio.play().catch(() => undefined);
  }

  /** Advance to the next track in library order. */
  next(): void {
    void this.step('next');
  }

  /** Go to the previous track in library order. */
  previous(): void {
    void this.step('previous');
  }

  /** Switch between Adaptive and Original, re-targeting the playing track (a live swap or, across a codec boundary, a reload at the current position). */
  setQualityMode(mode: QualityMode): void {
    if (mode === 'ORIGINAL' && capabilities.standalone) return;
    this.set({ qualityMode: mode });
    if (typeof window !== 'undefined') window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    const tier = mode === 'ORIGINAL' ? 'MAX' : loadStoredAdaptiveTier();
    void this.changeFormat(tier, this.snapshot.lossyPreference);
  }

  /** Set the preferred lossy codec, re-targeting the playing track the same way as `setQualityMode`. */
  setLossyPreference(preference: LossyPreference): void {
    this.set({ lossyPreference: preference });
    if (typeof window !== 'undefined') window.localStorage.setItem(FORMAT_STORAGE_KEY, preference);
    void this.changeFormat(this.snapshot.requestedTier, preference);
  }

  /** Clear the current playback error. */
  dismissError(): void {
    this.set({ error: null });
  }

  /** Start `track` from `startAt`, replacing whatever is queued. Reuses the existing `MsePlayer` when the codec matches (Adaptive's case — the SourceBuffer stays, the buffer gets wiped, the new track's chunks land in the same MediaSource), otherwise tears it down and creates a fresh one for the new codec. Pass `autoPlay = false` to load paused (restoring from the URL on a fresh page load, where there's no gesture to satisfy autoplay). */
  async loadTrack(track: TrackNode, startAt = 0, autoPlay = true): Promise<void> {
    this.tracksById.set(track.id, track);
    // Pre-seed snapshot for synchronous consumers; `onTrackChange` will fire and confirm.
    writePlaybackToUrl(track.id, startAt);
    this.set({
      current: track,
      positionSeconds: startAt,
      bufferedRanges: [],
      readySeconds: 0,
      delivery: track.delivery,
      playingQuality: null,
    });
    this.updateMediaMetadata(track);

    const totalSeconds = readFragment(PlaybackBarDocument, track).duration.seconds;
    const queued = this.buildQueuedTrack(track, totalSeconds);

    try {
      this.mse = await MsePlayer.init(
        this.mse,
        this.audio,
        queued,
        startAt,
        () => this.resolveNextTrack(),
        this.mseOptions(),
      );
    } catch (err) {
      this.mse = null;
      this.set({ error: { message: (err as Error).message } });
      return;
    }

    this.updateMediaPosition();
    if (autoPlay) await this.audio.play().catch(() => undefined);
  }

  /** Bundle of construction-time callbacks the player gives mse. Stable across `init` calls — same hooks apply whether mse reuses or rebuilds. */
  private mseOptions(): CreatePlayerOptions {
    return {
      onQuality: (q) => this.set({ playingQuality: q as Quality | null }),
      onThroughput: (bytes, transferMs) => this.onThroughput(bytes, transferMs),
      onProgress: (bytes, elapsedMs) => this.onProgress(bytes, elapsedMs),
      onTrackChange: (trackId) => this.handleTrackChange(trackId),
    };
  }

  /** Assemble the `QueuedTrack` mse needs, bundling the per-track manifest-subscription factory the player owns. The factory captures `trackId` and reads `lossyPreference` live so a preference change between enqueue and a later live tier swap is picked up automatically. */
  private buildQueuedTrack(track: TrackNode, totalSeconds: number): QueuedTrack {
    const trackId = track.id;
    return {
      id: trackId,
      url: resolvePlaybackUrl(track.delivery.url),
      contentType: track.delivery.mimeType,
      quality: this.snapshot.requestedTier,
      totalSeconds,
      /** Open a `trackManifest` SSE subscription for `trackId` at `quality` and pipe cumulative snapshots into `onEmit`. The closure handles SSE delta merging (each emission carries only the chunks finalised since the previous one) and idempotent replay after a transparent reconnect. Returns the teardown mse will run on slot replacement / live swap / dispose. */
      subscribeManifest: (quality, onEmit) => {
        const format = trackFormatFor(quality as Quality, this.snapshot.lossyPreference);
        let chunks: ManifestChunk[] = [];
        return subscribeToStream(
          TrackManifestDocument,
          { trackId, format },
          {
            next: (data) => {
              const snap = data.trackManifest;
              if (!snap) return;
              if (snap.chunks.length > 0) {
                const merged = chunks.slice();
                for (const c of snap.chunks) {
                  const tailEnd = merged.length > 0 ? merged[merged.length - 1]!.endSeconds : 0;
                  if (c.endSeconds > tailEnd) merged.push(c);
                }
                chunks = merged;
              }
              onEmit({ ...snap, chunks });
            },
            error: () => {},
            complete: () => {},
          },
        );
      },
    };
  }

  /** Called by the mse player when the playhead crosses into a new track. Swaps snapshot + Media Session metadata and prunes the now-past track from the player's local cache so it doesn't grow across a long session. No-op when the callback fires for the track the snapshot already shows — that's the initial-load case (during `loadTrack`, mse fires `onTrackChange` for the freshly-installed `current` *before* `audio.currentTime` is set, so `currentPosition()` would read 0 and stomp the caller-provided `startAt` already baked into the snapshot and the URL). */
  private handleTrackChange(trackId: string): void {
    const track = this.tracksById.get(trackId);
    if (!track) return;
    const prevId = this.snapshot.current?.id;
    if (prevId === trackId) return;
    if (prevId) this.tracksById.delete(prevId);
    const position = this.mse?.currentPosition() ?? 0;
    this.set({
      current: track,
      delivery: track.delivery,
      positionSeconds: position,
      bufferedRanges: this.readBuffered(),
      readySeconds: this.mse?.currentTrackReadySeconds() ?? 0,
      playingQuality: null,
    });
    this.updateMediaMetadata(track);
    writePlaybackToUrl(track.id, position);
  }

  /** Re-target the playing track at a new tier/preference. `MsePlayer.init` decides internally whether the change is a live tier swap (same id, same codec — no gap) or a codec-crossing rebuild (different codec) — we just hand it the freshly-resolved delivery, then refresh snapshot state from the new mse and resume playback if it was running. */
  private async changeFormat(tier: Quality, preference: LossyPreference): Promise<void> {
    this.applyTier(tier);
    const track = this.snapshot.current;
    if (!track || !this.mse) return;
    const token = ++this.changeToken;
    const format = trackFormatFor(tier, preference);
    const next = await this.fetchTrack(track.id, tier, preference, format);
    if (token !== this.changeToken || this.snapshot.current?.id !== track.id || !next) return;
    this.tracksById.set(next.id, next);
    const totalSeconds = readFragment(PlaybackBarDocument, next).duration.seconds;
    const queued = this.buildQueuedTrack(next, totalSeconds);
    const startAt = this.mse.currentPosition();
    const wasPlaying = !this.audio.paused;
    // Pre-seed the snapshot to the post-init resting state. Otherwise the `emptied` event that
    // fires during `init`'s audio.src reassignment lands on the still-pointing-to-the-old mse and
    // bleeds old `readySeconds` / `bufferedRanges` into the new track's bar (the "next track in
    // transcoding state" artefact).
    this.set({
      current: next,
      delivery: next.delivery,
      positionSeconds: startAt,
      bufferedRanges: [],
      readySeconds: 0,
      playingQuality: null,
    });
    try {
      this.mse = await MsePlayer.init(
        this.mse,
        this.audio,
        queued,
        startAt,
        () => this.resolveNextTrack(),
        this.mseOptions(),
      );
    } catch (err) {
      this.mse = null;
      this.set({ error: { message: (err as Error).message } });
      return;
    }
    // Refresh from the new instance (live-swap leaves the buffered audio in place; rebuild starts
    // empty — either way mse holds the right values now).
    this.set({
      bufferedRanges: this.readBuffered(),
      readySeconds: this.mse.currentTrackReadySeconds(),
      positionSeconds: this.mse.currentPosition(),
    });
    if (wasPlaying) await this.audio.play().catch(() => undefined);
  }

  /** Record the tier being requested and remember it (sub-Max only) as the Adaptive cold-start tier. */
  private applyTier(tier: Quality): void {
    this.set({ requestedTier: tier });
    if (tier !== 'MAX' && typeof window !== 'undefined') {
      window.localStorage.setItem(ADAPTIVE_TIER_STORAGE_KEY, tier);
    }
  }

  /**
   * Upscale on a just-finished chunk fetch's observed speed (`bytes / transferMs`, TTFB already excluded). Climbing is the on-completion concern: it wants a full, confident sample and buffer headroom, and can't sensibly happen mid-download (that would abort a perfectly good fetch on a partial reading). With a healthy buffer it jumps straight to the highest tier the speed covers with `UP_FACTOR` headroom. Downscaling is owned entirely by `onProgress`, which reacts during the transfer rather than after it. Gated by a cooldown so it can't flap, and logged for diagnosing churn.
   */
  private onThroughput(bytes: number, transferMs: number): void {
    if (this.snapshot.qualityMode !== 'ADAPTIVE') return;
    const now = performance.now();
    if (now - this.lastSwitchAt < SWITCH_COOLDOWN_MS) return;
    const idx = ADAPTIVE_LADDER.indexOf(this.snapshot.requestedTier);
    if (idx < 0 || this.tierBytesPerSecond(idx) === null) return;
    const ahead = bufferedAheadSeconds(this.audio);
    if (ahead <= BUFFER_HIGH_SECONDS) return;
    const observed = (bytes * 1000) / Math.max(transferMs, 1); // bytes/s on the just-finished fetch
    // Healthy buffer and spare bandwidth: climb straight to the highest tier with headroom.
    let up = idx;
    while (up + 1 < ADAPTIVE_LADDER.length && this.rateFits(observed, up + 1, UP_FACTOR)) up++;
    if (up === idx) return;
    const thresholdKbps = toKbps(this.tierBytesPerSecond(up)! * UP_FACTOR);
    this.switchTier(
      'upscale',
      up,
      idx,
      `speed ${toKbps(observed)} kbps ≥ ${UP_FACTOR}× = ${thresholdKbps} kbps (buffer ${ahead.toFixed(1)}s)`,
    );
  }

  /**
   * The downscale path: react to a still-in-flight chunk download. If the speed observed on the open body already can't sustain the current tier, drop straight to the highest tier it can — and abort the doomed fetch (`changeFormat` cancels it) — rather than waiting for it to finish and the buffer to drain. A completion-only signal is too late: by then a collapsed link has already emptied the buffer, and the finished rate is just the final value of what we're sampling here anyway.
   */
  private onProgress(bytes: number, elapsedMs: number): void {
    if (this.snapshot.qualityMode !== 'ADAPTIVE') return;
    if (elapsedMs < INFLIGHT_MIN_MS) return;
    const now = performance.now();
    if (now - this.lastSwitchAt < SWITCH_COOLDOWN_MS) return;
    const idx = ADAPTIVE_LADDER.indexOf(this.snapshot.requestedTier);
    if (idx <= 0 || this.tierBytesPerSecond(idx) === null) return;
    const rate = (bytes * 1000) / elapsedMs; // bytes/s on the open body
    if (this.rateFits(rate, idx, DOWN_FACTOR)) return; // current tier still sustainable on the live signal
    const nextIdx = this.sustainableFloor(rate, idx);
    const thresholdKbps = toKbps(this.tierBytesPerSecond(idx)! * DOWN_FACTOR);
    this.switchTier(
      'downscale',
      nextIdx,
      idx,
      `in-flight speed ${toKbps(rate)} kbps < ${DOWN_FACTOR}× = ${thresholdKbps} kbps`,
    );
  }

  /** bytes/s the ladder tier at `i` consumes, from its advertised kbps (kbps × 1000 / 8), or `null` if the delivery didn't carry one. */
  private tierBytesPerSecond(i: number): number | null {
    const kbps = this.snapshot.delivery?.tiers.find(
      (t) => t.quality === ADAPTIVE_LADDER[i],
    )?.bitrateKbps;
    return kbps == null ? null : (kbps * 1000) / 8;
  }

  /** Whether an observed `rate` (bytes/s) covers the ladder tier at `i` with `factor` headroom. */
  private rateFits(rate: number, i: number, factor: number): boolean {
    const b = this.tierBytesPerSecond(i);
    return b !== null && rate >= b * factor;
  }

  /** Highest ladder index below `idx` whose tier the observed `rate` can sustain (down to `MIN`). */
  private sustainableFloor(rate: number, idx: number): number {
    let floor = idx - 1;
    while (floor > 0 && !this.rateFits(rate, floor, DOWN_FACTOR)) floor--;
    return floor;
  }

  /** Commit a tier change, stamping the cooldown and logging the reason so churn is diagnosable from the console. */
  private switchTier(
    kind: 'upscale' | 'downscale',
    nextIdx: number,
    fromIdx: number,
    reason: string,
  ): void {
    this.lastSwitchAt = performance.now();
    const label = (i: number): string => {
      const b = this.tierBytesPerSecond(i);
      return `${ADAPTIVE_LADDER[i]} [${b === null ? '?' : `${toKbps(b)} kbps`}]`;
    };
    console.info(`[abr] [${kind}] ${label(fromIdx)} → ${label(nextIdx)} — ${reason}`);
    void this.changeFormat(ADAPTIVE_LADDER[nextIdx]!, this.snapshot.lossyPreference);
  }

  private fetchTrack(
    id: string,
    tier: Quality,
    preference: LossyPreference,
    format: TrackFormat = trackFormatFor(tier, preference),
  ): Promise<TrackNode | null | undefined> {
    return this.queryClient
      .fetchQuery({
        queryKey: ['track', id, tier, preference],
        queryFn: ({ signal }) => gqlRequest(TrackByIdDocument, { id, format }, signal),
      })
      .then((data) => data.track);
  }

  /** mse-invoked thunk: resolve the track after whatever is currently playing, fetch its delivery at the current tier/preference, stash the metadata for `handleTrackChange`, and return a `QueuedTrack`. Returns `null` if no successor exists (end of library) — mse interprets that as "play out and end". mse also handles codec-mismatch detection on the returned track. Reads the current id from the live snapshot so the lookup re-anchors after every boundary cross. */
  private async resolveNextTrack(): Promise<QueuedTrack | null> {
    const currentId = this.snapshot.current?.id;
    if (!currentId) return null;
    const data = await this.queryClient.fetchQuery({
      queryKey: ['step', 'next', currentId],
      queryFn: ({ signal }) =>
        gqlRequest(
          TracksDocument,
          { first: 1, last: null, after: currentId, before: null },
          signal,
        ),
    });
    const nextId = data.tracks?.edges[0]?.node.id;
    if (!nextId) return null;
    const tier = this.snapshot.requestedTier;
    const preference = this.snapshot.lossyPreference;
    const next = await this.fetchTrack(nextId, tier, preference);
    if (!next) return null;
    this.tracksById.set(next.id, next);
    const totalSeconds = readFragment(PlaybackBarDocument, next).duration.seconds;
    return this.buildQueuedTrack(next, totalSeconds);
  }

  private async step(direction: 'next' | 'previous'): Promise<void> {
    const current = this.snapshot.current;
    if (!current) return;
    const variables =
      direction === 'next'
        ? { first: 1, last: null, after: current.id, before: null }
        : { first: null, last: 1, after: null, before: current.id };
    const data = await this.queryClient.fetchQuery({
      queryKey: ['step', direction, current.id],
      queryFn: ({ signal }) => gqlRequest(TracksDocument, variables, signal),
    });
    const nextId = data.tracks?.edges[0]?.node.id;
    if (nextId) await this.play(nextId);
  }
}

type PlayerActions = {
  setQualityMode: (m: QualityMode) => void;
  setLossyPreference: (p: LossyPreference) => void;
  lossyPreferenceAvailability: Record<LossyPreference, boolean>;
  dismissError: () => void;
  play: (id: string) => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
};

type PlayerCtx = PlayerSnapshot & PlayerActions;

const Ctx = createContext<PlayerCtx | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [player] = useState(() => {
    const audio = getAudioElement();
    if (!audio) throw new Error('PlayerProvider requires a browser environment');
    return new Player(audio, queryClient);
  });

  useEffect(() => player.activate(), [player]);

  const snapshot = useSyncExternalStore(player.subscribe, player.getSnapshot);

  // Actions are stable (the `player` instance never changes), so this memo only re-runs when the
  // snapshot does — which is exactly when the UI needs to re-render.
  const value = useMemo<PlayerCtx>(
    () => ({
      ...snapshot,
      lossyPreferenceAvailability: {
        OPUS: isLossyPreferenceAvailable('OPUS'),
        MP3: isLossyPreferenceAvailable('MP3'),
      },
      setQualityMode: (m) => player.setQualityMode(m),
      setLossyPreference: (p) => player.setLossyPreference(p),
      dismissError: () => player.dismissError(),
      play: (id) => void player.play(id),
      togglePlay: () => player.togglePlay(),
      next: () => player.next(),
      previous: () => player.previous(),
      seek: (s) => player.seek(s),
    }),
    [snapshot, player],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePlayer must be inside <PlayerProvider>');
  return ctx;
}
