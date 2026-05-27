import { useQueryClient } from '@tanstack/react-query';
import { readFragment } from 'gql.tada';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { PlaybackBarDocument } from '../components/playback-bar.tsx';
import { TracksDocument } from '../components/track-list.tsx';
import { getAudioElement } from '../lib/audio-element.ts';
import { type Capabilities, capabilities, type LossyPreference } from '../lib/capabilities.ts';
import { graphql, type ResultOf, type VariablesOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { createPlayer, type CreatePlayerError, type Player as MsePlayer } from '../lib/mse.ts';
import { subscribe } from '../lib/sse-client.ts';

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

const QUALITY_STORAGE_KEY = 'lofify.player.quality';
const QUALITY_VALUES: readonly Quality[] = ['MAX', 'HIGH', 'MEDIUM', 'LOW', 'MIN'];
const FORMAT_STORAGE_KEY = 'lofify.player.lossy-preference';
const FORMAT_VALUES: readonly LossyPreference[] = ['OPUS', 'MP3'];

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

function loadStoredQuality(): Quality {
  if (typeof window === 'undefined') return 'MAX';
  const stored = window.localStorage.getItem(QUALITY_STORAGE_KEY);
  if (stored && (QUALITY_VALUES as readonly string[]).includes(stored)) return stored as Quality;
  return 'MAX';
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

export type BufferedRange = { start: number; end: number };
export type PlayerError = { message: string };

type PlayerCtx = {
  current: TrackNode | null;
  isPlaying: boolean;
  positionSeconds: number;
  bufferedRanges: BufferedRange[];
  /** Seconds of the current track the server has finished encoding. */
  readySeconds: number;
  quality: Quality;
  setQuality: (q: Quality) => void;
  lossyPreference: LossyPreference;
  lossyPreferenceAvailability: Record<LossyPreference, boolean>;
  setLossyPreference: (p: LossyPreference) => void;
  /** Resolved delivery plan for the current track (codec, MIME, copy-vs-transcode, description). `null` between track changes or when no track is loaded. */
  delivery: Delivery | null;
  /** Quality of the bytes currently under the playhead, from the playback `X-Quality` header. During an on-the-fly bitrate switch this trails `quality` until the old-quality buffer drains. `null` until the first chunk is fetched. */
  playingQuality: Quality | null;
  error: PlayerError | null;
  dismissError: () => void;
  play: (id: string) => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
};

const Ctx = createContext<PlayerCtx | null>(null);

function errorMessageFor(err: CreatePlayerError): string {
  switch (err.kind) {
    case 'mse-unsupported':
      return 'This browser does not support Media Source Extensions; playback is unavailable.';
    case 'codec-unsupported':
      return `This browser cannot decode ${err.contentType}. Pick a different format.`;
  }
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (audioRef.current === null) audioRef.current = getAudioElement();
  const [current, setCurrent] = useState<TrackNode | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionSeconds, setPositionSeconds] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState<BufferedRange[]>([]);
  const [readySeconds, setReadySeconds] = useState(0);
  const [quality, setQualityState] = useState<Quality>(loadStoredQuality);
  const [lossyPreference, setLossyPreferenceState] =
    useState<LossyPreference>(loadStoredLossyPreference);
  const [error, setError] = useState<PlayerError | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [playingQuality, setPlayingQuality] = useState<Quality | null>(null);
  const dismissError = useCallback(() => setError(null), []);
  const nextRef = useRef<() => void>(() => undefined);
  const playerRef = useRef<MsePlayer | null>(null);
  const manifestUnsubRef = useRef<(() => void) | null>(null);
  // Read inside changeFormat without re-creating it on every change (which would churn the context
  // value and the manifest subscription). changeTokenRef is a latest-wins guard for its async fetch.
  const currentRef = useRef<TrackNode | null>(null);
  const deliveryRef = useRef<Delivery | null>(null);
  const qualityRef = useRef<Quality>(quality);
  const lossyPreferenceRef = useRef<LossyPreference>(lossyPreference);
  const changeTokenRef = useRef(0);
  currentRef.current = current;
  deliveryRef.current = delivery;
  qualityRef.current = quality;
  lossyPreferenceRef.current = lossyPreference;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => setPositionSeconds(audio.currentTime);
    const onBuffered = () => {
      const ranges: BufferedRange[] = [];
      for (let i = 0; i < audio.buffered.length; i++) {
        ranges.push({ start: audio.buffered.start(i), end: audio.buffered.end(i) });
      }
      setBufferedRanges(ranges);
    };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('progress', onBuffered);
    audio.addEventListener('seeked', onBuffered);
    audio.addEventListener('loadedmetadata', onBuffered);
    audio.addEventListener('emptied', onBuffered);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('progress', onBuffered);
      audio.removeEventListener('seeked', onBuffered);
      audio.removeEventListener('loadedmetadata', onBuffered);
      audio.removeEventListener('emptied', onBuffered);
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => {
      setIsPlaying(false);
      nextRef.current();
    };
    audio.addEventListener('ended', onEnded);
    return () => audio.removeEventListener('ended', onEnded);
  }, []);

  const prefetchNext = useCallback(
    (currentId: string) => {
      void (async () => {
        const data = await queryClient.fetchQuery({
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
        await queryClient.prefetchQuery({
          queryKey: ['track', nextId, quality, lossyPreference],
          queryFn: ({ signal }) =>
            gqlRequest(
              TrackByIdDocument,
              { id: nextId, format: trackFormatFor(quality, lossyPreference) },
              signal,
            ),
        });
      })();
    },
    [queryClient, quality, lossyPreference],
  );

  const startManifest = useCallback(
    (trackId: string, totalSeconds: number, format: TrackFormat) => {
      manifestUnsubRef.current?.();
      // The subscription sends `chunks` as deltas (only the chunks finalised since the previous
      // emission). Accumulate them into the full list the player consumes. This `chunks` is fresh per
      // call, so a track/format change starts from empty. A transparent SSE reconnect, though, restarts
      // the server stream and replays the whole list into this same closure — so merge idempotently,
      // appending only chunks beyond our tail (endSeconds strictly increases).
      let chunks: ManifestChunk[] = [];
      manifestUnsubRef.current = subscribe(
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
            playerRef.current?.setManifest({ ...snap, chunks });
            const ready = snap.done ? totalSeconds : snap.durationSeconds;
            setReadySeconds(Math.min(ready, totalSeconds));
          },
          error: () => {
            manifestUnsubRef.current = null;
          },
          complete: () => {
            manifestUnsubRef.current = null;
          },
        },
      );
    },
    [],
  );

  const loadTrack = useCallback(
    async (track: TrackNode) => {
      setCurrent(track);
      setPositionSeconds(0);
      setBufferedRanges([]);
      setReadySeconds(0);
      setDelivery(null);
      setPlayingQuality(null);
      const audio = audioRef.current;
      if (!audio) return;
      playerRef.current?.dispose();
      playerRef.current = null;
      manifestUnsubRef.current?.();

      setDelivery(track.delivery);

      const meta = readFragment(PlaybackBarDocument, track);
      const totalSeconds = meta.duration.seconds;

      const created = await createPlayer(
        audio,
        resolvePlaybackUrl(track.delivery.url),
        track.delivery.mimeType,
        totalSeconds,
        {
          onError: (err) => setError({ message: errorMessageFor(err) }),
          onQuality: (q) => setPlayingQuality(q as Quality | null),
        },
      );
      if (!created) return;
      playerRef.current = created;

      startManifest(track.id, totalSeconds, trackFormatFor(quality, lossyPreference));

      audio.currentTime = 0;
      await audio.play().catch(() => undefined);
      prefetchNext(track.id);
    },
    [prefetchNext, quality, lossyPreference, startManifest],
  );

  const playTrack = useCallback(
    async (id: string) => {
      const data = await queryClient.fetchQuery({
        queryKey: ['track', id, quality, lossyPreference],
        queryFn: ({ signal }) =>
          gqlRequest(
            TrackByIdDocument,
            { id, format: trackFormatFor(quality, lossyPreference) },
            signal,
          ),
      });
      if (data.track) await loadTrack(data.track);
    },
    [queryClient, quality, lossyPreference, loadTrack],
  );

  // Re-target the playing track at a new quality/preference. A bitrate-only change (same codec ⇒
  // same delivery mimeType) swaps the stream live with no gap; a codec-crossing change (to/from Max,
  // Opus↔MP3) is left for the next track to pick up, since the SourceBuffer codec can't be changed.
  const changeFormat = useCallback(
    async (nextQuality: Quality, nextPreference: LossyPreference) => {
      const track = currentRef.current;
      const player = playerRef.current;
      if (!track || !player) return;
      const token = ++changeTokenRef.current;
      const format = trackFormatFor(nextQuality, nextPreference);
      const data = await queryClient.fetchQuery({
        queryKey: ['track', track.id, nextQuality, nextPreference],
        queryFn: ({ signal }) => gqlRequest(TrackByIdDocument, { id: track.id, format }, signal),
      });
      if (token !== changeTokenRef.current || currentRef.current?.id !== track.id) return;
      const next = data.track;
      if (!next) return;
      if (next.delivery.mimeType !== deliveryRef.current?.mimeType) return;
      setCurrent(next);
      setDelivery(next.delivery);
      player.switchStream(resolvePlaybackUrl(next.delivery.url));
      const totalSeconds = readFragment(PlaybackBarDocument, next).duration.seconds;
      startManifest(next.id, totalSeconds, format);
    },
    [queryClient, startManifest],
  );

  const setQuality = useCallback(
    (q: Quality) => {
      setQualityState(q);
      if (typeof window !== 'undefined') window.localStorage.setItem(QUALITY_STORAGE_KEY, q);
      void changeFormat(q, lossyPreferenceRef.current);
    },
    [changeFormat],
  );
  const setLossyPreference = useCallback(
    (p: LossyPreference) => {
      setLossyPreferenceState(p);
      if (typeof window !== 'undefined') window.localStorage.setItem(FORMAT_STORAGE_KEY, p);
      void changeFormat(qualityRef.current, p);
    },
    [changeFormat],
  );

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  }, [current]);

  const seek = useCallback(async (seconds: number) => {
    const audio = audioRef.current;
    const player = playerRef.current;
    if (!audio || !player) return;
    setPositionSeconds(seconds);
    player.seekTo(seconds);
    await audio.play().catch(() => undefined);
  }, []);

  const step = useCallback(
    async (direction: 'next' | 'previous') => {
      if (!current) return;
      const variables =
        direction === 'next'
          ? { first: 1, last: null, after: current.id, before: null }
          : { first: null, last: 1, after: null, before: current.id };
      const data = await queryClient.fetchQuery({
        queryKey: ['step', direction, current.id],
        queryFn: ({ signal }) => gqlRequest(TracksDocument, variables, signal),
      });
      const nextId = data.tracks?.edges[0]?.node.id;
      if (nextId) await playTrack(nextId);
    },
    [queryClient, current, playTrack],
  );

  const next = useCallback(() => void step('next'), [step]);
  const previous = useCallback(() => void step('previous'), [step]);

  useEffect(() => {
    nextRef.current = next;
  }, [next]);

  const value = useMemo<PlayerCtx>(
    () => ({
      current,
      isPlaying,
      positionSeconds,
      bufferedRanges,
      readySeconds,
      quality,
      setQuality,
      lossyPreference,
      lossyPreferenceAvailability: {
        OPUS: isLossyPreferenceAvailable('OPUS'),
        MP3: isLossyPreferenceAvailable('MP3'),
      },
      setLossyPreference,
      delivery,
      playingQuality,
      error,
      dismissError,
      play: (id) => void playTrack(id),
      togglePlay,
      next,
      previous,
      seek: (s) => void seek(s),
    }),
    [
      current,
      isPlaying,
      positionSeconds,
      bufferedRanges,
      readySeconds,
      quality,
      setQuality,
      lossyPreference,
      setLossyPreference,
      delivery,
      playingQuality,
      error,
      dismissError,
      playTrack,
      togglePlay,
      next,
      previous,
      seek,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePlayer must be inside <PlayerProvider>');
  return ctx;
}
