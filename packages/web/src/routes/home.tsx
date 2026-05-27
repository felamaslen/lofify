import { ErrorToast } from '../components/error-toast.tsx';
import { PlaybackBar } from '../components/playback-bar.tsx';
import { TrackList } from '../components/track-list.tsx';

export function Home() {
  return (
    <div className="grid h-full grid-rows-[auto_1fr_auto]">
      <header className="flex items-center border-b border-border px-3 py-1">
        <h1 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Lofify
        </h1>
      </header>
      <TrackList />
      <PlaybackBar />
      <ErrorToast />
    </div>
  );
}
