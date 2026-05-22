import { readFragment } from 'gql.tada';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useMemo } from 'react';

import { graphql } from '../lib/gql.ts';
import { usePlayer } from '../state/player.tsx';
import { Button } from './ui/button.tsx';
import { Slider } from './ui/slider.tsx';

export const PlaybackBarDocument = graphql(`
  fragment PlaybackBar on Track {
    title
    artist
    album
    duration {
      seconds
      formatted
    }
  }
`);

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
}

export function PlaybackBar() {
  const {
    current,
    isPlaying,
    positionSeconds,
    bufferedRanges,
    transcodedSeconds,
    togglePlay,
    next,
    previous,
    seek,
  } = usePlayer();

  const meta = current ? readFragment(PlaybackBarDocument, current) : null;
  const total = meta?.duration.seconds ?? 0;
  const sliderValue = useMemo(() => [Math.min(positionSeconds, total)], [positionSeconds, total]);

  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 border-t border-border bg-card/60 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={previous}
          disabled={!current}
          aria-label="Previous"
        >
          <SkipBack />
        </Button>
        <Button
          variant="default"
          size="icon"
          onClick={togglePlay}
          disabled={!current}
          aria-label="Play/pause"
        >
          {isPlaying ? <Pause /> : <Play />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={next}
          disabled={!current}
          aria-label="Next"
        >
          <SkipForward />
        </Button>
      </div>
      <div className="flex min-w-0 flex-col">
        {meta ? (
          <>
            <span className="truncate text-sm font-medium">{meta.title ?? '(untitled)'}</span>
            <span className="truncate text-xs text-muted-foreground">
              {meta.artist ?? 'Unknown artist'}
              {meta.album ? ` — ${meta.album}` : ''}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Nothing playing</span>
        )}
      </div>
      <div className="flex w-[320px] items-center gap-3 text-xs tabular-nums text-muted-foreground">
        <span className="w-10 text-right">{fmt(positionSeconds)}</span>
        <Slider
          value={sliderValue}
          min={0}
          max={total || 1}
          step={1}
          availableEnd={transcodedSeconds}
          bufferedRanges={bufferedRanges}
          onValueChange={(v) => {
            if (v[0] === undefined) return;
            // Clamp to transcoded region — anything past it would stall MSE.
            const target = transcodedSeconds > 0 ? Math.min(v[0], transcodedSeconds) : v[0];
            seek(target);
          }}
          disabled={!current || total === 0}
          aria-label="Scrub"
          className="flex-1"
        />
        <span className="w-10">{meta?.duration.formatted ?? '00:00'}</span>
      </div>
    </div>
  );
}
