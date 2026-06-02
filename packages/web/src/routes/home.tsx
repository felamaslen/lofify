import { X } from 'lucide-react';

import { ErrorToast } from '../components/error-toast.tsx';
import { PlaybackBar } from '../components/playback-bar.tsx';
import { SearchBox } from '../components/search-box.tsx';
import { TrackList } from '../components/track-list.tsx';
import { Visualiser } from '../components/visualiser.tsx';
import { LibraryFilterProvider, useLibraryFilter } from '../state/library-filter.tsx';
import { ShowDuplicatesProvider } from '../state/show-duplicates.tsx';
import { useVisualiser, VisualiserProvider } from '../state/visualiser.tsx';

function FilterChip() {
  const { artist, album, clear } = useLibraryFilter();
  if (!artist && !album) return null;
  const label = album ? `Album: ${album}` : `Artist: ${artist}`;
  return (
    <button
      type="button"
      onClick={clear}
      className="flex items-center gap-1 rounded-full bg-accent/60 px-2 py-0.5 text-xs text-foreground hover:bg-accent"
      title="Clear filter"
    >
      <span className="max-w-48 truncate">{label}</span>
      <X className="size-3 shrink-0" />
    </button>
  );
}

function HomeLayout() {
  const { active } = useVisualiser();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex h-10 items-center gap-3 border-b border-border bg-background px-3 max-sm:h-auto max-sm:py-1.5">
        <h1 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Lofify
        </h1>
        <SearchBox />
        <FilterChip />
      </header>
      {active ? <Visualiser /> : <TrackList />}
      <div className="sticky bottom-0 z-30">
        <PlaybackBar />
      </div>
      <ErrorToast />
    </div>
  );
}

export function Home() {
  return (
    <LibraryFilterProvider>
      <ShowDuplicatesProvider>
        <VisualiserProvider>
          <HomeLayout />
        </VisualiserProvider>
      </ShowDuplicatesProvider>
    </LibraryFilterProvider>
  );
}
