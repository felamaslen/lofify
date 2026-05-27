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
import {
  addSample as addBandwidthSample,
  type BandwidthEstimate,
  bytesPerSecond as bandwidthBytesPerSecond,
  emptyBandwidthEstimate,
} from '../lib/bandwidth.ts';
import { type Capabilities, capabilities, type LossyPreference } from '../lib/capabilities.ts';
import { graphql, type ResultOf, type VariablesOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { createPlayer, type CreatePlayerError, type Player as MsePlayer } from '../lib/mse.ts';
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

// Adaptive controller tuning. The decision compares the smoothed download throughput against the
// current tier's data rate, gated on buffer health, with a cooldown so it can't flap.
/** Step up only when the connection can pull this many times the current tier's bitrate. */
const UP_FACTOR = 2;
/** Step down when throughput drops below this multiple of the current tier's bitrate. */
const DOWN_FACTOR = 1.3;
/** Step down (regardless of throughput) when buffered-ahead falls below this — a stall is imminent. */
const BUFFER_LOW_SECONDS = 10;
/** Step up only when this much is buffered ahead, so a brief spike doesn't over-commit. */
const BUFFER_HIGH_SECONDS = 20;
/** Minimum gap between tier switches. */
const SWITCH_COOLDOWN_MS = 5000;

const GRAPHQL_URL = import.meta.env.VITE_GRAPHQL_URL ?? '/graphql';

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
 * Imperative playback orchestrator, held as a single long-lived instance for the provider's lifetime (an external store React reads via `useSyncExternalStore`). It owns the singleton `<audio>` element, the bandwidth estimate, the user's settings, and the current `MsePlayer` — which is the part rebuilt per track and on any codec-crossing change (its SourceBuffer is codec-locked). Keeping the orchestration in a class lets `loadTrack`, `changeFormat`, and the adaptive controller call each other directly, without the ref/closure gymnastics the equivalent hooks would need.
 */
class Player {
  private snapshot: PlayerSnapshot;
  private readonly listeners = new Set<() => void>();
  private mse: MsePlayer | null = null;
  private manifestUnsub: (() => void) | null = null;
  private estimate: BandwidthEstimate = emptyBandwidthEstimate();
  private lastSwitchAt = 0;
  /** Latest-wins guard for `changeFormat`'s async fetch. */
  private changeToken = 0;
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

  // --- External-store interface ------------------------------------------------------------------

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
    return () => this.dispose();
  }

  /** Detach the audio listeners, end the manifest subscription, and tear down the current `MsePlayer`. The teardown returned by `activate`. */
  private dispose(): void {
    for (const detach of this.detachers) detach();
    this.detachers.length = 0;
    this.manifestUnsub?.();
    this.mse?.dispose();
    this.mse = null;
  }

  // --- Audio element wiring ----------------------------------------------------------------------

  private on(type: string, handler: () => void): void {
    this.audio.addEventListener(type, handler);
    this.detachers.push(() => this.audio.removeEventListener(type, handler));
  }

  private attachAudioListeners(): void {
    this.on('play', () => this.set({ isPlaying: true }));
    this.on('pause', () => this.set({ isPlaying: false }));
    this.on('timeupdate', () => this.set({ positionSeconds: this.audio.currentTime }));
    const onBuffered = () => this.set({ bufferedRanges: this.readBuffered() });
    this.on('progress', onBuffered);
    this.on('seeked', onBuffered);
    this.on('loadedmetadata', onBuffered);
    this.on('emptied', onBuffered);
    this.on('ended', () => {
      this.set({ isPlaying: false });
      void this.step('next');
    });
  }

  private readBuffered(): BufferedRange[] {
    const out: BufferedRange[] = [];
    const b = this.audio.buffered;
    for (let i = 0; i < b.length; i++) out.push({ start: b.start(i), end: b.end(i) });
    return out;
  }

  // --- Public actions ----------------------------------------------------------------------------

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

  /** Seek to `seconds`; the reconcile loop fetches the chunk under the new playhead and resumes. */
  seek(seconds: number): void {
    if (!this.mse) return;
    this.set({ positionSeconds: seconds });
    this.mse.seekTo(seconds);
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

  // --- Track lifecycle ---------------------------------------------------------------------------

  /** Tear down the current `MsePlayer` and start `track` from `startAt`. Called to play a new track and, via `changeFormat`, when a format change crosses a codec boundary. */
  async loadTrack(track: TrackNode, startAt = 0): Promise<void> {
    this.set({
      current: track,
      positionSeconds: startAt,
      bufferedRanges: [],
      readySeconds: 0,
      delivery: track.delivery,
      playingQuality: null,
    });
    this.mse?.dispose();
    this.mse = null;
    this.manifestUnsub?.();

    const totalSeconds = readFragment(PlaybackBarDocument, track).duration.seconds;
    const mse = await createPlayer(
      this.audio,
      resolvePlaybackUrl(track.delivery.url),
      track.delivery.mimeType,
      totalSeconds,
      {
        onError: (err) => this.set({ error: { message: errorMessageFor(err) } }),
        onQuality: (q) => this.set({ playingQuality: q as Quality | null }),
        onThroughput: (bytes, transferMs, contentSeconds) =>
          this.onThroughput(bytes, transferMs, contentSeconds),
      },
    );
    if (!mse) return;
    this.mse = mse;

    this.startManifest(
      track.id,
      totalSeconds,
      trackFormatFor(this.snapshot.requestedTier, this.snapshot.lossyPreference),
    );

    this.audio.currentTime = startAt;
    await this.audio.play().catch(() => undefined);
    void this.prefetchNext(track.id);
  }

  /**
   * Re-target the playing track at a new tier/preference. A same-codec change (equal delivery mimeType — every Adaptive bitrate step, and Original↔Adaptive when the source copies into the same codec) swaps the stream live with no gap; a codec-crossing change reloads at the current playback position, since the SourceBuffer codec can't be changed in place.
   */
  private async changeFormat(tier: Quality, preference: LossyPreference): Promise<void> {
    this.applyTier(tier);
    const track = this.snapshot.current;
    if (!track || !this.mse) return;
    const token = ++this.changeToken;
    const format = trackFormatFor(tier, preference);
    const next = await this.fetchTrack(track.id, tier, preference, format);
    if (token !== this.changeToken || this.snapshot.current?.id !== track.id || !next) return;
    const totalSeconds = readFragment(PlaybackBarDocument, next).duration.seconds;
    if (next.delivery.mimeType === this.snapshot.delivery?.mimeType && this.mse) {
      this.set({ current: next, delivery: next.delivery });
      this.mse.switchStream(resolvePlaybackUrl(next.delivery.url), tier);
      this.startManifest(next.id, totalSeconds, format);
    } else {
      await this.loadTrack(next, this.audio.currentTime);
    }
  }

  /** Record the tier being requested and remember it (sub-Max only) as the Adaptive cold-start tier. */
  private applyTier(tier: Quality): void {
    this.set({ requestedTier: tier });
    if (tier !== 'MAX' && typeof window !== 'undefined') {
      window.localStorage.setItem(ADAPTIVE_TIER_STORAGE_KEY, tier);
    }
  }

  // --- Adaptive controller -----------------------------------------------------------------------

  /**
   * Feed each chunk fetch into the bandwidth estimator and, in Adaptive mode, step the tier: stepwise (±1) against the current tier's measured data rate, so no static bitrate table is needed, gated by buffer health and a cooldown so it can't flap.
   */
  private onThroughput(bytes: number, transferMs: number, contentSeconds: number): void {
    this.estimate = addBandwidthSample(this.estimate, bytes, transferMs);
    if (this.snapshot.qualityMode !== 'ADAPTIVE') return;
    const now = performance.now();
    if (now - this.lastSwitchAt < SWITCH_COOLDOWN_MS) return;
    const idx = ADAPTIVE_LADDER.indexOf(this.snapshot.requestedTier);
    if (idx < 0) return;
    const ahead = bufferedAheadSeconds(this.audio);
    const contentRate = bytes / contentSeconds; // bytes/s the current tier consumes
    const estimate = bandwidthBytesPerSecond(this.estimate); // bytes/s, or null until warmed up
    let nextIdx = idx;
    if (
      (ahead < BUFFER_LOW_SECONDS || (estimate !== null && estimate < contentRate * DOWN_FACTOR)) &&
      idx > 0
    ) {
      nextIdx = idx - 1;
    } else if (
      estimate !== null &&
      ahead > BUFFER_HIGH_SECONDS &&
      estimate > contentRate * UP_FACTOR &&
      idx < ADAPTIVE_LADDER.length - 1
    ) {
      nextIdx = idx + 1;
    }
    if (nextIdx === idx) return;
    this.lastSwitchAt = now;
    void this.changeFormat(ADAPTIVE_LADDER[nextIdx]!, this.snapshot.lossyPreference);
  }

  // --- Manifest + queries ------------------------------------------------------------------------

  private startManifest(trackId: string, totalSeconds: number, format: TrackFormat): void {
    this.manifestUnsub?.();
    // The subscription sends `chunks` as deltas (only the chunks finalised since the previous
    // emission). Accumulate them into the full list the player consumes. This `chunks` is fresh per
    // call, so a track/format change starts from empty. A transparent SSE reconnect, though, restarts
    // the server stream and replays the whole list into this same closure — so merge idempotently,
    // appending only chunks beyond our tail (endSeconds strictly increases).
    let chunks: ManifestChunk[] = [];
    this.manifestUnsub = subscribeToStream(
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
          this.mse?.setManifest({ ...snap, chunks });
          const ready = snap.done ? totalSeconds : snap.durationSeconds;
          this.set({ readySeconds: Math.min(ready, totalSeconds) });
        },
        error: () => {
          this.manifestUnsub = null;
        },
        complete: () => {
          this.manifestUnsub = null;
        },
      },
    );
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

  private async prefetchNext(currentId: string): Promise<void> {
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
    if (!nextId) return;
    const tier = this.snapshot.requestedTier;
    const preference = this.snapshot.lossyPreference;
    await this.queryClient.prefetchQuery({
      queryKey: ['track', nextId, tier, preference],
      queryFn: ({ signal }) =>
        gqlRequest(
          TrackByIdDocument,
          { id: nextId, format: trackFormatFor(tier, preference) },
          signal,
        ),
    });
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

function errorMessageFor(err: CreatePlayerError): string {
  switch (err.kind) {
    case 'mse-unsupported':
      return 'This browser does not support Media Source Extensions; playback is unavailable.';
    case 'codec-unsupported':
      return `This browser cannot decode ${err.contentType}. Pick a different format.`;
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
