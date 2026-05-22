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
import { graphql, type ResultOf, type VariablesOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { createPlayer, type Player as MsePlayer } from '../lib/mse.ts';
import { subscribe } from '../lib/sse-client.ts';

export const TrackByIdDocument = graphql(
  `
    query TrackById($id: ID!, $format: Format, $quality: Int) {
      track(id: $id) {
        id
        url(format: $format, quality: $quality)
        ...PlaybackBar
      }
    }
  `,
  [PlaybackBarDocument],
);

const TranscodeProgressDocument = graphql(`
  subscription TranscodeProgress($trackId: ID!, $format: Format, $quality: Int) {
    transcodeProgress(trackId: $trackId, format: $format, quality: $quality) {
      readyChunks
      chunkDurationSeconds
      isDone
    }
  }
`);

type TrackNode = NonNullable<ResultOf<typeof TrackByIdDocument>['track']>;

export type Format = NonNullable<VariablesOf<typeof TrackByIdDocument>['format']>;

const FORMAT_STORAGE_KEY = 'lofify.player.format';
const FORMAT_VALUES: readonly Format[] = [
  'AAC',
  'AUTO_HI',
  'AUTO_LO',
  'FLAC',
  'OGG',
  'ORIGINAL',
  'WEBM',
];

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

function loadStoredFormat(): Format {
  if (typeof window === 'undefined') return 'AUTO_HI';
  const stored = window.localStorage.getItem(FORMAT_STORAGE_KEY);
  if (stored && (FORMAT_VALUES as readonly string[]).includes(stored)) {
    return stored as Format;
  }
  return 'AUTO_HI';
}

export type BufferedRange = { start: number; end: number };

type PlayerCtx = {
  current: TrackNode | null;
  isPlaying: boolean;
  positionSeconds: number;
  bufferedRanges: BufferedRange[];
  /** Seconds of the current track the server has finished encoding (derived from the `transcodeProgress` subscription). Seeks past this are rejected; the UI uses it to overlay a "still encoding" stripe on the unloaded tail of the seek bar. Equals the total duration once the transcode is done, and is `0` while we're still waiting for the first progress event. For passthrough playback the subscription emits `isDone: true` immediately with `readyChunks: 0`, leaving this at the track's duration. */
  readySeconds: number;
  format: Format;
  setFormat: (f: Format) => void;
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
  // `preload='none'` can cause Chrome to detach a freshly-set MediaSource blob URL before `play()` fires, transitioning the MediaSource to `closed` and rejecting subsequent `appendBuffer` calls with "this SourceBuffer has been removed". `'metadata'` keeps the attachment live without preloading the actual audio data.
  el.preload = 'metadata';
  return el;
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
  const [format, setFormatState] = useState<Format>(loadStoredFormat);
  const setFormat = useCallback((f: Format) => {
    setFormatState(f);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(FORMAT_STORAGE_KEY, f);
    }
  }, []);
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
        // Also warm the full track-by-id (with the signed URL) so stepping to
        // the next track skips the network entirely.
        await queryClient.prefetchQuery({
          queryKey: ['track', nextId, format],
          queryFn: ({ signal }) =>
            gqlRequest(TrackByIdDocument, { id: nextId, format, quality: null }, signal),
        });
      })();
    },
    [queryClient, format],
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
      transcodeUnsubRef.current = subscribe(
        TranscodeProgressDocument,
        { trackId: track.id, format, quality: null },
        {
          next: (data) => {
            const p = data.transcodeProgress;
            if (!p) return;
            // Once ffmpeg signals done, the whole track is ready — `readyChunks * chunkDurationSeconds` floor-rounds below the actual duration (chunks are fixed-length, tracks aren't), and passthrough emits `isDone: true` with `readyChunks: 0`. Both cases collapse to "the seek bar should clear".
            const ready = p.isDone
              ? totalSeconds
              : p.readyChunks * p.chunkDurationSeconds;
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
      const player = await createPlayer(audio, resolvePlaybackUrl(track.url));
      playerRef.current = player;
      audio.currentTime = 0;
      await audio.play().catch(() => undefined);
      prefetchNext(track.id);
    },
    [prefetchNext, format],
  );

  const playTrack = useCallback(
    async (id: string) => {
      const data = await queryClient.fetchQuery({
        queryKey: ['track', id, format],
        queryFn: ({ signal }) =>
          gqlRequest(TrackByIdDocument, { id, format, quality: null }, signal),
      });
      if (data.track) await loadTrack(data.track);
    },
    [queryClient, format, loadTrack],
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
    // Clamp to the ready cursor so the UI can't strand MSE on an un-encoded chunk; the playback bar already prevents the user dragging past it but a programmatic seek (e.g. next-track auto-resume) might still try.
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
      format,
      setFormat,
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
      format,
      setFormat,
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
