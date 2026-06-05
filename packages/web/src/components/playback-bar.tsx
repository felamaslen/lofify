import { type FragmentOf, readFragment } from 'gql.tada';
import { AudioLines, Pause, Play, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';

import { getAnalyser, isVisualiserSupported } from '../lib/audio-analyser.ts';
import { graphql } from '../lib/gql.ts';
import { useCoarsePointer } from '../lib/use-coarse-pointer.ts';
import { usePlayer } from '../state/player.tsx';
import { useShuffle } from '../state/shuffle.tsx';
import { useVisualiser } from '../state/visualiser.tsx';
import { PlaybackFormatBadge } from './playback-format-badge.tsx';
import { SettingsDialog } from './settings-dialog.tsx';
import {
  artworkDisplayUrl,
  ArtworkTile,
  TrackArtworkDocument,
  useTrackArtwork,
} from './track-artwork.tsx';
import { Button } from './ui/button.tsx';
import { Slider } from './ui/slider.tsx';

export const PlaybackBarDocument = graphql(
  `
    fragment PlaybackBar on Track {
      title
      artist
      album
      duration {
        seconds
        formatted
      }
      ...TrackArtwork
    }
  `,
  [TrackArtworkDocument],
);

/** Cover thumbnail for the playing track. Keeps the Media Session artwork in step as a download resolves — `setMediaArtwork` ignores stale and redundant calls, so the effect can fire freely. */
function BarArtwork({ track }: { track: FragmentOf<typeof TrackArtworkDocument> }) {
  const { id, artwork: initial } = readFragment(TrackArtworkDocument, track);
  const { artwork, download, upload, uploadFromUrl, uploading, error } = useTrackArtwork(
    id,
    initial,
  );
  const { setMediaArtwork } = usePlayer();

  const coverUrl = artworkDisplayUrl(artwork);
  useEffect(() => {
    setMediaArtwork(id, coverUrl);
  }, [id, coverUrl, setMediaArtwork]);

  return (
    <ArtworkTile
      artwork={artwork}
      download={download}
      upload={upload}
      uploadFromUrl={uploadFromUrl}
      uploading={uploading}
      error={error}
      className="size-10"
    />
  );
}

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
    cachedRanges,
    readySeconds,
    togglePlay,
    next,
    previous,
    seek,
  } = usePlayer();
  const { active: visualiserActive, toggle: toggleVisualiser } = useVisualiser();
  const { enabled: shuffleEnabled, toggle: toggleShuffle } = useShuffle();
  // Touch devices are excluded (the small screen is for the list, not a
  // visualiser) and so are browsers without `captureStream` (Safari).
  const showVisualiser = !useCoarsePointer() && isVisualiserSupported();

  const onToggleVisualiser = () => {
    // Prime + resume the AudioContext inside the click gesture so the browser
    // permits the resume; the visualiser's own mount call is then idempotent.
    if (!visualiserActive) getAnalyser();
    toggleVisualiser();
  };

  const meta = current ? readFragment(PlaybackBarDocument, current) : null;
  const total = meta?.duration.seconds ?? 0;
  const sliderValue = useMemo(() => [Math.min(positionSeconds, total)], [positionSeconds, total]);
  // The un-encoded tail shrinks as the subscription advances. Clamp so the stripe never spills past the slider; treat `readySeconds === 0` as "we haven't heard from the server yet" → no overlay (avoids flashing a full-track stripe between mount and the first subscription event).
  const pendingStart = readySeconds > 0 && readySeconds < total ? Math.ceil(readySeconds) : null;

  const barRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);

  const onBarMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = barRef.current;
    if (!el || total === 0) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    setHover({ x, time: (x / (rect.width || 1)) * total });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-4 border-t border-border bg-card/60 px-4 py-3 backdrop-blur max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-2 max-sm:pb-0">
      <div className="flex min-w-0 items-center gap-3 max-sm:col-start-1 max-sm:row-start-1">
        {meta && <BarArtwork track={meta} />}
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
      </div>

      <div className="mx-auto flex w-full max-w-[640px] flex-col items-center gap-1.5 max-sm:contents">
        <div className="flex items-center gap-1 max-sm:col-span-2 max-sm:row-start-2 max-sm:justify-center">
          <Button
            variant={shuffleEnabled ? 'secondary' : 'ghost'}
            size="icon"
            onClick={() => toggleShuffle(current?.id ?? null)}
            aria-label="Shuffle"
            aria-pressed={shuffleEnabled}
          >
            <Shuffle />
          </Button>
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
          <Button variant="ghost" size="icon" onClick={next} disabled={!current} aria-label="Next">
            <SkipForward />
          </Button>
          {showVisualiser && (
            <Button
              variant={visualiserActive ? 'secondary' : 'ghost'}
              size="icon"
              onClick={onToggleVisualiser}
              disabled={!current}
              aria-label="Visualiser"
              aria-pressed={visualiserActive}
            >
              <AudioLines />
            </Button>
          )}
        </div>

        <div className="flex w-full items-center gap-2 text-[11px] tabular-nums text-muted-foreground max-sm:col-span-2 max-sm:row-start-3 max-sm:grid max-sm:grid-cols-2 max-sm:items-end max-sm:gap-x-2 max-sm:gap-y-1">
          <span className="w-10 text-right max-sm:col-start-1 max-sm:row-start-1 max-sm:w-auto max-sm:text-left">
            {fmt(positionSeconds)}
          </span>
          <div
            ref={barRef}
            className="relative flex-1 max-sm:col-span-2 max-sm:row-start-2 max-sm:-mx-4"
            onMouseMove={onBarMove}
            onMouseLeave={() => setHover(null)}
          >
            {hover && current && (
              <div
                className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 text-[10px] tabular-nums text-popover-foreground shadow"
                style={{ left: hover.x }}
              >
                {fmt(hover.time)}
              </div>
            )}
            <Slider
              value={sliderValue}
              min={0}
              max={total || 1}
              step={1}
              bufferedRanges={bufferedRanges}
              cachedRanges={cachedRanges}
              {...(pendingStart != null ? { pendingStart } : {})}
              onValueChange={(v) => {
                if (v[0] === undefined) return;
                // Clamp drags into the un-encoded tail to the ready cursor — seeking past it would 504 on the server and the SourceBuffer would stall.
                const clamped = pendingStart != null ? Math.min(v[0], pendingStart) : v[0];
                seek(clamped);
              }}
              disabled={!current || total === 0}
              aria-label="Scrub"
            />
          </div>
          <span className="w-10 max-sm:col-start-2 max-sm:row-start-1 max-sm:w-auto max-sm:text-right">
            {meta?.duration.formatted ?? '00:00'}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 max-sm:col-start-2 max-sm:row-start-1">
        <PlaybackFormatBadge />
        <SettingsDialog />
      </div>
    </div>
  );
}
