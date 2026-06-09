import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useRef } from 'react';

import { PlaybackBar } from '../components/playback-bar.tsx';
import { QueuePanel } from '../components/queue-panel.tsx';
import { QueueToast } from '../components/queue-toast.tsx';
import { SearchBox } from '../components/search-box.tsx';
import {
  ArtistIndexDocument,
  PAGE_SIZE,
  TrackList,
  TrackWindowDocument,
} from '../components/track-list.tsx';
import { UpdateIndicator, UpdateIndicatorDocument } from '../components/update-indicator.tsx';
import { Visualiser } from '../components/visualiser.tsx';
import { graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { GIT_SHA } from '../lib/version.ts';
import { LibraryFilterProvider, useLibraryFilter } from '../state/library-filter.tsx';
import { ShowDuplicatesProvider, useShowDuplicates } from '../state/show-duplicates.tsx';
import { useVisualiser, VisualiserProvider } from '../state/visualiser.tsx';

/** Bootstraps the home screen in one request: the first window of the view the page opened on (whatever its persisted filters) and whether the server is running a newer build than this bundle. */
const HomeDocument = graphql(
  `
    query Home(
      $offset: Int!
      $first: Int!
      $appVersion: String!
      $filterArtistIn: [String!]
      $filterAlbumIn: [String!]
      $includeDuplicates: Boolean
    ) {
      ...UpdateIndicator
      ...ArtistIndex
      tracks(
        offset: $offset
        first: $first
        filterArtistIn: $filterArtistIn
        filterAlbumIn: $filterAlbumIn
        includeDuplicates: $includeDuplicates
      ) {
        ...TrackWindow
      }
    }
  `,
  [ArtistIndexDocument, TrackWindowDocument, UpdateIndicatorDocument],
);

function HomeLayout() {
  const { active } = useVisualiser();
  const { artist, album } = useLibraryFilter();
  const { showDuplicates } = useShowDuplicates();
  // The view the page opened on, captured once: filter changes mustn't re-run
  // (and so re-suspend) the bootstrap — they fetch their own data in the list.
  const { current: opening } = useRef({ artist, album, showDuplicates });
  const queryClient = useQueryClient();
  // Seeds the cache for the track list's first page/index and the update
  // indicator. Runs regardless of the visualiser so the flag stays current.
  useSuspenseQuery({
    queryKey: ['home', GIT_SHA, opening.artist, opening.album, opening.showDuplicates],
    queryFn: async ({ signal }) => {
      const data = await gqlRequest(
        HomeDocument,
        {
          offset: 0,
          first: PAGE_SIZE,
          appVersion: GIT_SHA,
          filterArtistIn: opening.artist ? [opening.artist] : null,
          filterAlbumIn: opening.album ? [opening.album] : null,
          includeDuplicates: opening.showDuplicates,
        },
        signal,
      );
      // Decompose the bootstrap into the track list's own query keys so the
      // opening view renders from cache without refetching. The list owns these
      // keys — and crucially their refetching — from here on, so invalidation
      // anywhere (tag edits, scans) just works; nothing observes this query's
      // data for track content.
      const view = [opening.artist, opening.album, opening.showDuplicates];
      queryClient.setQueryData(['tracks-window', ...view, 0], { tracks: data.tracks });
      queryClient.setQueryData(['tracks-count', ...view], { tracks: data.tracks });
      queryClient.setQueryData(['artist-index', ...view], data);
      return data;
    },
  });
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background px-3 max-sm:h-16">
        <div className="flex flex-1 items-center gap-3 max-sm:flex-none">
          <QueuePanel />
          <h1 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Lofify
          </h1>
        </div>
        <SearchBox />
        <div className="flex flex-1 items-center justify-end max-sm:flex-none">
          <UpdateIndicator />
        </div>
      </header>
      {active ? <Visualiser /> : <TrackList />}
      <div className="sticky bottom-0 z-30">
        <PlaybackBar />
      </div>
      <QueueToast />
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
