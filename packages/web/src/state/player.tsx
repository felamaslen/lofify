import { useQueryClient } from '@tanstack/react-query';
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

import type { ResultOf, VariablesOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { resolvePlaybackUrl } from '../lib/playback-url.ts';
import { TrackByIdQuery, TracksQuery } from '../lib/queries.ts';

type TrackNode = NonNullable<ResultOf<typeof TrackByIdQuery>['track']>;

export type Format = NonNullable<VariablesOf<typeof TracksQuery>['format']>;

type PlayerCtx = {
  current: TrackNode | null;
  isPlaying: boolean;
  positionSeconds: number;
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
  el.preload = 'none';
  return el;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (audioRef.current === null) audioRef.current = singletonAudio();
  const [current, setCurrent] = useState<TrackNode | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionSeconds, setPositionSeconds] = useState(0);
  const [format, setFormat] = useState<Format>('AUTO_HI');
  const nextRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      nextRef.current();
    };
    const onTime = () => setPositionSeconds(audio.currentTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTime);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTime);
    };
  }, []);

  const loadTrack = useCallback(async (track: TrackNode) => {
    setCurrent(track);
    setPositionSeconds(0);
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = resolvePlaybackUrl(track.url);
    audio.currentTime = 0;
    await audio.play().catch(() => undefined);
  }, []);

  const playTrack = useCallback(
    async (id: string) => {
      const data = await queryClient.fetchQuery({
        queryKey: ['track', id, format],
        queryFn: ({ signal }) =>
          gqlRequest(
            TrackByIdQuery,
            { id, format, quality: null },
            signal,
          ),
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

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setPositionSeconds(seconds);
  }, []);

  const step = useCallback(
    async (direction: 'next' | 'previous') => {
      if (!current) return;
      const variables =
        direction === 'next'
          ? { first: 1, last: null, after: current.id, before: null, format, quality: null }
          : { first: null, last: 1, after: null, before: current.id, format, quality: null };
      const data = await queryClient.fetchQuery({
        queryKey: ['step', direction, current.id, format],
        queryFn: ({ signal }) => gqlRequest(TracksQuery, variables, signal),
      });
      const node = data.tracks?.edges[0]?.node;
      if (node) await loadTrack(node);
    },
    [queryClient, current, format, loadTrack],
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
      format,
      setFormat,
      play: (id) => void playTrack(id),
      togglePlay,
      next,
      previous,
      seek,
    }),
    [
      current,
      isPlaying,
      positionSeconds,
      format,
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
