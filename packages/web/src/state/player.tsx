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
import { type Capabilities,capabilities } from '../lib/capabilities.ts';
import { graphql, type ResultOf, type VariablesOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import {
  createPlayer,
  type CreatePlayerError,
  type Player as MsePlayer,
} from '../lib/mse.ts';
import { subscribe } from '../lib/sse-client.ts';

export const TrackByIdDocument = graphql(
  `
    query TrackById($id: ID!, $format: TrackFormat) {
      track(id: $id) {
        id
        isLossless
        url(format: $format)
        ...PlaybackBar
      }
    }
  `,
  [PlaybackBarDocument],
);

export const TrackManifestDocument = graphql(`
  subscription TrackManifest($trackId: ID!, $format: TrackFormat!) {
    trackManifest(trackId: $trackId, format: $format) {
      chunkDurationSeconds
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
export type FormatLossy = TrackFormat['formatLossy'];

/** Server-emitted manifest snapshot. The player consumes this shape directly. */
export type ManifestSnapshot = NonNullable<
  ResultOf<typeof TrackManifestDocument>['trackManifest']
>;
export type ManifestChunk = ManifestSnapshot['chunks'][number];

type TrackNode = NonNullable<ResultOf<typeof TrackByIdDocument>['track']>;

/** Resolved delivery codec inferred from `(quality, formatLossy, isLossless)` — the same rule the server uses in `resolve.ts`. */
export type ActualFormat = 'flac' | 'opus' | 'mp3';

function resolveActualFormat(
  quality: Quality,
  formatLossy: FormatLossy,
  isLossless: boolean,
): ActualFormat {
  if (isLossless && quality === 'MAX') return 'flac';
  return formatLossy === 'OPUS' ? 'opus' : 'mp3';
}

function contentTypeFor(actual: ActualFormat): string {
  switch (actual) {
    case 'flac':
      return 'audio/mp4; codecs="flac"';
    case 'opus':
      return 'audio/mp4; codecs="opus"';
    case 'mp3':
      return 'audio/mpeg';
  }
}

export function isFormatLossyAvailable(
  f: FormatLossy,
  caps: Capabilities = capabilities,
): boolean {
  return f === 'OPUS' ? caps.opusInMp4 : caps.mp3;
}

export function defaultFormatLossy(caps: Capabilities = capabilities): FormatLossy {
  return caps.opusInMp4 ? 'OPUS' : 'MP3';
}

const QUALITY_STORAGE_KEY = 'lofify.player.quality';
const QUALITY_VALUES: readonly Quality[] = ['MAX', 'HIGH', 'MEDIUM', 'LOW'];
const FORMAT_STORAGE_KEY = 'lofify.player.format-lossy';
const FORMAT_VALUES: readonly FormatLossy[] = ['OPUS', 'MP3'];

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

function loadStoredFormatLossy(): FormatLossy {
  if (typeof window === 'undefined') return defaultFormatLossy();
  const stored = window.localStorage.getItem(FORMAT_STORAGE_KEY);
  if (stored && (FORMAT_VALUES as readonly string[]).includes(stored)) {
    const f = stored as FormatLossy;
    if (!isFormatLossyAvailable(f)) return defaultFormatLossy();
    return f;
  }
  return defaultFormatLossy();
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
  formatLossy: FormatLossy;
  formatLossyAvailability: Record<FormatLossy, boolean>;
  setFormatLossy: (f: FormatLossy) => void;
  /** Codec actually being delivered for the current track, derived from `(quality, formatLossy, track.isLossless)`. `null` between track changes or when no track is loaded. */
  actualFormat: ActualFormat | null;
  error: PlayerError | null;
  dismissError: () => void;
  play: (id: string) => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
};

const Ctx = createContext<PlayerCtx | null>(null);

function singletonAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  const el = new Audio();
  el.preload = 'metadata';
  return el;
}

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
  if (audioRef.current === null) audioRef.current = singletonAudio();
  const [current, setCurrent] = useState<TrackNode | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionSeconds, setPositionSeconds] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState<BufferedRange[]>([]);
  const [readySeconds, setReadySeconds] = useState(0);
  const [quality, setQualityState] = useState<Quality>(loadStoredQuality);
  const [formatLossy, setFormatLossyState] = useState<FormatLossy>(loadStoredFormatLossy);
  const [error, setError] = useState<PlayerError | null>(null);
  const [actualFormat, setActualFormat] = useState<ActualFormat | null>(null);
  const setQuality = useCallback((q: Quality) => {
    setQualityState(q);
    if (typeof window !== 'undefined') window.localStorage.setItem(QUALITY_STORAGE_KEY, q);
  }, []);
  const setFormatLossy = useCallback((f: FormatLossy) => {
    setFormatLossyState(f);
    if (typeof window !== 'undefined') window.localStorage.setItem(FORMAT_STORAGE_KEY, f);
  }, []);
  const dismissError = useCallback(() => setError(null), []);
  const nextRef = useRef<() => void>(() => undefined);
  const playerRef = useRef<MsePlayer | null>(null);
  const manifestUnsubRef = useRef<(() => void) | null>(null);

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
          queryKey: ['track', nextId, quality, formatLossy],
          queryFn: ({ signal }) =>
            gqlRequest(
              TrackByIdDocument,
              { id: nextId, format: { quality, formatLossy } },
              signal,
            ),
        });
      })();
    },
    [queryClient, quality, formatLossy],
  );

  const loadTrack = useCallback(
    async (track: TrackNode) => {
      setCurrent(track);
      setPositionSeconds(0);
      setBufferedRanges([]);
      setReadySeconds(0);
      setActualFormat(null);
      const audio = audioRef.current;
      if (!audio) return;
      playerRef.current?.dispose();
      playerRef.current = null;
      manifestUnsubRef.current?.();

      const actual = resolveActualFormat(quality, formatLossy, track.isLossless);
      const contentType = contentTypeFor(actual);
      setActualFormat(actual);

      const created = await createPlayer(audio, resolvePlaybackUrl(track.url), contentType, {
        onError: (err) => setError({ message: errorMessageFor(err) }),
      });
      if (!created) return;
      playerRef.current = created;

      const meta = readFragment(PlaybackBarDocument, track);
      const totalSeconds = meta.duration.seconds;

      manifestUnsubRef.current = subscribe(
        TrackManifestDocument,
        { trackId: track.id, format: { quality, formatLossy } },
        {
          next: (data) => {
            const snap = data.trackManifest;
            if (!snap) return;
            playerRef.current?.setManifest(snap);
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

      audio.currentTime = 0;
      await audio.play().catch(() => undefined);
      prefetchNext(track.id);
    },
    [prefetchNext, quality, formatLossy],
  );

  const playTrack = useCallback(
    async (id: string) => {
      const data = await queryClient.fetchQuery({
        queryKey: ['track', id, quality, formatLossy],
        queryFn: ({ signal }) =>
          gqlRequest(
            TrackByIdDocument,
            { id, format: { quality, formatLossy } },
            signal,
          ),
      });
      if (data.track) await loadTrack(data.track);
    },
    [queryClient, quality, formatLossy, loadTrack],
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
    await player.seekTo(seconds);
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
      formatLossy,
      formatLossyAvailability: {
        OPUS: isFormatLossyAvailable('OPUS'),
        MP3: isFormatLossyAvailable('MP3'),
      },
      setFormatLossy,
      actualFormat,
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
      formatLossy,
      setFormatLossy,
      actualFormat,
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
