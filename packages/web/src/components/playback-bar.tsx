import { useMemo } from 'react';
import { usePlayer } from '../state/player.tsx';

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
    togglePlay,
    next,
    previous,
    seek,
  } = usePlayer();

  const total = current?.duration.seconds ?? 0;
  const percent = useMemo(
    () => (total > 0 ? Math.min(100, (positionSeconds / total) * 100) : 0),
    [positionSeconds, total],
  );

  return (
    <div className="playback-bar">
      <div className="playback-controls">
        <button onClick={previous} disabled={!current} aria-label="Previous">
          ⏮
        </button>
        <button onClick={togglePlay} disabled={!current} aria-label="Play/pause">
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button onClick={next} disabled={!current} aria-label="Next">
          ⏭
        </button>
      </div>
      <div className="playback-track-info">
        {current ? (
          <>
            <span className="track-title">{current.title ?? '(untitled)'}</span>
            <span className="track-meta">
              {current.artist ?? 'Unknown artist'}
              {current.album ? ` — ${current.album}` : ''}
            </span>
          </>
        ) : (
          <span className="track-meta">Nothing playing</span>
        )}
      </div>
      <div className="playback-scrub">
        <span className="time">{fmt(positionSeconds)}</span>
        <input
          type="range"
          min={0}
          max={total || 0}
          step={1}
          value={Math.min(positionSeconds, total)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!current || total === 0}
          aria-label="Scrub"
        />
        <span className="time">{current?.duration.formatted ?? '00:00'}</span>
        <span className="scrub-fill" style={{ width: `${percent}%` }} aria-hidden />
      </div>
    </div>
  );
}
