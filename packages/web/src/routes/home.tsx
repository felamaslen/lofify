import { FormatPicker } from '../components/format-picker.tsx';
import { PlaybackBar } from '../components/playback-bar.tsx';
import { RescanButton } from '../components/rescan-button.tsx';
import { TrackList } from '../components/track-list.tsx';

export function Home() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Lofify</h1>
        <div className="app-header-actions">
          <RescanButton />
          <FormatPicker />
        </div>
      </header>
      <TrackList />
      <PlaybackBar />
    </div>
  );
}
