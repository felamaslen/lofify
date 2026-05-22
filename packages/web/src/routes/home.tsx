import { FormatPicker } from '../components/format-picker.tsx';
import { PlaybackBar } from '../components/playback-bar.tsx';
import { RescanButton } from '../components/rescan-button.tsx';
import { TrackList } from '../components/track-list.tsx';

export function Home() {
  return (
    <div className="grid h-full grid-rows-[auto_1fr_auto]">
      <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
        <h1 className="m-0 text-base font-semibold tracking-wide">Lofify</h1>
        <div className="flex items-center gap-3">
          <RescanButton />
          <FormatPicker />
        </div>
      </header>
      <TrackList />
      <PlaybackBar />
    </div>
  );
}
