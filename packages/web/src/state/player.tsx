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
import {
  acceptHeaderFor,
  capabilities,
  defaultFormat,
  type Format,
  isFormatAvailable,
  isMaxQualityAvailable,
  type Quality,
} from '../lib/capabilities.ts';
import { graphql, type ResultOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { createPlayer, type CreatePlayerError, type Player as MsePlayer } from '../lib/mse.ts';
import { subscribe } from '../lib/sse-client.ts';

export const TrackByIdDocument = graphql(
  `
    query TrackById($id: ID!, $quality: Quality) {
      track(id: $id) {
        id
        url(quality: $quality)
        ...PlaybackBar
      }
    }
  `,
  [PlaybackBarDocument],
);

const TranscodeProgressDocument = graphql(`
  subscription TranscodeProgress($trackId: ID!, $acceptHeaderValue: String, $quality: String) {
    transcodeProgress(trackId: $trackId, acceptHeaderValue: $acceptHeaderValue, quality: $quality) {
      readyChunks
      chunkDurationSeconds
      isDone
    }
  }
`);

type TrackNode = NonNullable<ResultOf<typeof TrackByIdDocument>['track']>;

export type { Format, Quality };

const QUALITY_STORAGE_KEY = 'lofify.player.quality';
const QUALITY_VALUES: readonly Quality[] = ['max', 'high', 'medium', 'low'];
const FORMAT_STORAGE_KEY = 'lofify.player.format';
const FORMAT_VALUES: readonly Format[] = ['mp4', 'mp3'];

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

function defaultQuality(): Quality {
  return isMaxQualityAvailable() ? 'max' : 'high';
}

function loadStoredQuality(): Quality {
  if (typeof window === 'undefined') return defaultQuality();
  const stored = window.localStorage.getItem(QUALITY_STORAGE_KEY);
  if (stored && (QUALITY_VALUES as readonly string[]).includes(stored)) {
    const q = stored as Quality;
    // A persisted `max` from a previous session is no longer valid if the browser lost flac support — fall back.
    if (q === 'max' && !isMaxQualityAvailable()) return defaultQuality();
    return q;
  }
  return defaultQuality();
}

function loadStoredFormat(): Format {
  if (typeof window === 'undefined') return defaultFormat();
  const stored = window.localStorage.getItem(FORMAT_STORAGE_KEY);
  if (stored && (FORMAT_VALUES as readonly string[]).includes(stored)) {
    const f = stored as Format;
    if (!isFormatAvailable(f)) return defaultFormat();
    return f;
  }
  return defaultFormat();
}

/** Map the player's coarse quality knob to a GraphQL `Quality` enum value (or `null` for `max`, which the server infers from the `Accept` header instead). */
function qualityForGql(quality: Quality): 'LOW' | 'MEDIUM' | 'HIGH' | null {
  switch (quality) {
    case 'max':
      return null;
    case 'high':
      return 'HIGH';
    case 'medium':
      return 'MEDIUM';
    case 'low':
      return 'LOW';
  }
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
  maxQualityAvailable: boolean;
  setQuality: (q: Quality) => void;
  format: Format;
  formatAvailability: Record<Format, boolean>;
  setFormat: (f: Format) => void;
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
      return `This browser cannot play ${err.contentType} via MSE. Pick a different quality.`;
    case 'probe-failed':
      return 'Could not reach the playback endpoint.';
    case 'direct-fetch-failed':
      return 'Failed to download the audio file.';
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
  const readySecondsRef = useRef(0);
  readySecondsRef.current = readySeconds;
  const [quality, setQualityState] = useState<Quality>(loadStoredQuality);
  const [format, setFormatState] = useState<Format>(loadStoredFormat);
  const [error, setError] = useState<PlayerError | null>(null);
  const setQuality = useCallback((q: Quality) => {
    setQualityState(q);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(QUALITY_STORAGE_KEY, q);
    }
  }, []);
  const setFormat = useCallback((f: Format) => {
    setFormatState(f);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(FORMAT_STORAGE_KEY, f);
    }
  }, []);
  const dismissError = useCallback(() => setError(null), []);
  const nextRef = useRef<() => void>(() => undefined);
  const playerRef = useRef<MsePlayer | null>(null);
  const transcodeUnsubRef = useRef<(() => void) | null>(null);

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
          queryKey: ['track', nextId, quality],
          queryFn: ({ signal }) =>
            gqlRequest(TrackByIdDocument, { id: nextId, quality: qualityForGql(quality) }, signal),
        });
      })();
    },
    [queryClient, quality],
  );

  const loadTrack = useCallback(
    async (track: TrackNode) => {
      setCurrent(track);
      setPositionSeconds(0);
      setBufferedRanges([]);
      setReadySeconds(0);
      const audio = audioRef.current;
      if (!audio) return;
      playerRef.current?.dispose();
      playerRef.current = null;
      transcodeUnsubRef.current?.();
      const meta = readFragment(PlaybackBarDocument, track);
      const totalSeconds = meta.duration.seconds;
      const accept = acceptHeaderFor(quality, format, capabilities);
      transcodeUnsubRef.current = subscribe(
        TranscodeProgressDocument,
        {
          trackId: track.id,
          acceptHeaderValue: accept,
          quality: quality === 'max' ? null : quality,
        },
        {
          next: (data) => {
            const p = data.transcodeProgress;
            if (!p) return;
            // Once ffmpeg signals done, the whole track is ready — `readyChunks * chunkDurationSeconds` floor-rounds below the actual duration (chunks are fixed-length, tracks aren't), and passthrough emits `isDone: true` with `readyChunks: 0`. Both cases collapse to "the seek bar should clear".
            const ready = p.isDone ? totalSeconds : p.readyChunks * p.chunkDurationSeconds;
            const clamped = Math.min(ready, totalSeconds);
            setReadySeconds(clamped);
            playerRef.current?.setReadyChunks(p.readyChunks);
          },
          error: () => {
            transcodeUnsubRef.current = null;
          },
          complete: () => {
            transcodeUnsubRef.current = null;
          },
        },
      );
      const player = await createPlayer(audio, resolvePlaybackUrl(track.url), accept, {
        onError: (err) => setError({ message: errorMessageFor(err) }),
      });
      if (!player) return;
      playerRef.current = player;
      audio.currentTime = 0;
      await audio.play().catch(() => undefined);
      prefetchNext(track.id);
    },
    [prefetchNext, quality, format],
  );

  const playTrack = useCallback(
    async (id: string) => {
      const data = await queryClient.fetchQuery({
        queryKey: ['track', id, quality],
        queryFn: ({ signal }) =>
          gqlRequest(TrackByIdDocument, { id, quality: qualityForGql(quality) }, signal),
      });
      if (data.track) await loadTrack(data.track);
    },
    [queryClient, quality, loadTrack],
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
    const ready = readySecondsRef.current;
    const target = ready > 0 ? Math.min(seconds, ready) : seconds;
    setPositionSeconds(target);
    await player.seekTo(target);
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
      maxQualityAvailable: isMaxQualityAvailable(),
      setQuality,
      format,
      formatAvailability: {
        mp4: isFormatAvailable('mp4'),
        mp3: isFormatAvailable('mp3'),
      },
      setFormat,
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
      format,
      setFormat,
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
