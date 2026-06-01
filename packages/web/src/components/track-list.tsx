import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { readFragment } from 'gql.tada';
import { type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useIsMobile } from '../hooks/use-is-mobile.ts';
import { graphql, type ResultOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { cn } from '../lib/utils.ts';
import { useLibraryFilter } from '../state/library-filter.tsx';
import { TrackByIdDocument, trackFormatFor, usePlayer } from '../state/player.tsx';
import { LetterScrubber } from './letter-scrubber.tsx';
import { type EditableTrack, TagEditDialog } from './tag-edit-dialog.tsx';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from './ui/context-menu.tsx';

const TrackListRowDocument = graphql(`
  fragment TrackListRow on Track {
    title
    path
    trackNumber
    discNumber
    artist
    album
    year
    sourceFormat
    isLossless
    duration {
      seconds
      formatted
    }
  }
`);

/**
 * Cursor-paginated track list. Kept for the player's next/previous resolution, which walks the
 * library relative to the current track. The list view itself loads by index (see
 * `TracksWindowDocument`) so it can jump anywhere without paging through the gap.
 */
export const TracksDocument = graphql(
  `
    query Tracks(
      $first: Int
      $last: Int
      $after: String
      $before: String
      $filterArtistIn: [String!]
      $filterAlbumIn: [String!]
    ) {
      tracks(
        first: $first
        last: $last
        after: $after
        before: $before
        filterArtistIn: $filterArtistIn
        filterAlbumIn: $filterAlbumIn
      ) {
        totalCount
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        edges {
          cursor
          node {
            id
            ...TrackListRow
          }
        }
      }
    }
  `,
  [TrackListRowDocument],
);

/** A window of the list addressed by absolute index, so the scrubber can jump to any offset. */
const TracksWindowDocument = graphql(
  `
    query TracksWindow(
      $offset: Int!
      $first: Int!
      $filterArtistIn: [String!]
      $filterAlbumIn: [String!]
    ) {
      tracks(
        offset: $offset
        first: $first
        filterArtistIn: $filterArtistIn
        filterAlbumIn: $filterAlbumIn
      ) {
        totalCount
        edges {
          cursor
          node {
            id
            ...TrackListRow
          }
        }
      }
    }
  `,
  [TrackListRowDocument],
);

const ArtistIndexDocument = graphql(`
  query ArtistIndex($filterArtistIn: [String!], $filterAlbumIn: [String!]) {
    artistIndex(filterArtistIn: $filterArtistIn, filterAlbumIn: $filterAlbumIn) {
      label
      offset
    }
  }
`);

type WindowEdge = NonNullable<
  NonNullable<ResultOf<typeof TracksWindowDocument>['tracks']>['edges']
>[number];

const PAGE_SIZE = 100;
const ROW_HEIGHT = 36;
// Mobile rows stack title over artist, so they need room for two lines.
const ROW_HEIGHT_MOBILE = 52;
const HOVER_PREFETCH_MS = 200;

const COLS =
  'grid grid-cols-[40px_60px_minmax(0,2fr)_80px_minmax(0,1.2fr)_minmax(0,1.4fr)_80px_64px] items-center gap-3 px-4 max-sm:grid-cols-[minmax(0,1fr)_auto_auto] max-sm:content-center max-sm:gap-y-0';

export function TrackList() {
  const { requestedTier, lossyPreference, play, current } = usePlayer();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const rowHeight = isMobile ? ROW_HEIGHT_MOBILE : ROW_HEIGHT;

  const { artist, album } = useLibraryFilter();
  const filterArtistIn = artist ? [artist] : null;
  const filterAlbumIn = album ? [album] : null;

  // A cheap, stable source of the total — independent of which windows are loaded — so the
  // virtualizer's row count (and thus the scrollbar range) never collapses while paging.
  const countQuery = useQuery({
    queryKey: ['tracks-count', artist, album],
    queryFn: ({ signal }) =>
      gqlRequest(
        TracksWindowDocument,
        { offset: 0, first: 0, filterArtistIn, filterAlbumIn },
        signal,
      ),
  });
  const totalCount = countQuery.data?.tracks?.totalCount ?? 0;

  const indexQuery = useQuery({
    queryKey: ['artist-index', artist, album],
    queryFn: ({ signal }) =>
      gqlRequest(ArtistIndexDocument, { filterArtistIn, filterAlbumIn }, signal),
  });
  const buckets = useMemo(() => indexQuery.data?.artistIndex ?? [], [indexQuery.data]);

  const spacerRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);

  // The page itself scrolls (body scroll), so the virtualizer tracks the window. `scrollMargin` is
  // how far the row container sits below the document top (the sticky app + column headers), so
  // virtual offsets map onto page scroll.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setScrollMargin(spacerRef.current?.offsetTop ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [totalCount, isMobile, artist, album]);

  const virtualizer = useWindowVirtualizer({
    count: totalCount,
    estimateSize: () => rowHeight,
    overscan: 12,
    scrollMargin,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  const items = virtualizer.getVirtualItems();
  const topIndex = items[0]?.index ?? 0;

  // Which index-pages cover the visible range; fetched on demand so a jump loads only its window.
  const firstPage = Math.floor((items[0]?.index ?? 0) / PAGE_SIZE);
  const lastPage = Math.floor((items.at(-1)?.index ?? 0) / PAGE_SIZE);
  const pageIndexes: number[] = [];
  for (let p = firstPage; p <= lastPage; p++) pageIndexes.push(p);

  const windowResults = useQueries({
    queries: pageIndexes.map((p) => ({
      queryKey: ['tracks-window', artist, album, p],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        gqlRequest(
          TracksWindowDocument,
          { offset: p * PAGE_SIZE, first: PAGE_SIZE, filterArtistIn, filterAlbumIn },
          signal,
        ),
      staleTime: 30_000,
    })),
  });

  const rowsByIndex = new Map<number, WindowEdge>();
  pageIndexes.forEach((p, i) => {
    const edges = windowResults[i]?.data?.tracks?.edges ?? [];
    edges.forEach((edge, j) => rowsByIndex.set(p * PAGE_SIZE + j, edge));
  });

  const selectRow = (e: MouseEvent, index: number, id: string): void => {
    if (e.shiftKey && anchorRef.current !== null) {
      const from = Math.min(anchorRef.current, index);
      const to = Math.max(anchorRef.current, index);
      const ids: string[] = [];
      for (let i = from; i <= to; i++) {
        const edge = rowsByIndex.get(i);
        if (edge) ids.push(edge.node.id);
      }
      setSelected(new Set(ids));
      // The browser extends a text selection from the prior click's caret on
      // shift-click; drop it so range-selecting rows doesn't highlight text.
      window.getSelection()?.removeAllRanges();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchorRef.current = index;
      return;
    }
    setSelected(new Set([id]));
    anchorRef.current = index;
  };

  const selectedTracks = useMemo<EditableTrack[]>(() => {
    const out: EditableTrack[] = [];
    for (const edge of rowsByIndex.values()) {
      if (!selected.has(edge.node.id)) continue;
      const t = readFragment(TrackListRowDocument, edge.node);
      out.push({
        id: edge.node.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        trackNumber: t.trackNumber,
        discNumber: t.discNumber,
        year: t.year,
      });
    }
    return out;
    // rowsByIndex is rebuilt every render; depend on the loaded windows + selection instead.
  }, [windowResults, selected]);

  const onRowEnter = (id: string): void => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      void queryClient.prefetchQuery({
        queryKey: ['track', id, requestedTier, lossyPreference],
        queryFn: ({ signal }) =>
          gqlRequest(
            TrackByIdDocument,
            { id, format: trackFormatFor(requestedTier, lossyPreference) },
            signal,
          ),
      });
    }, HOVER_PREFETCH_MS);
  };
  const onRowLeave = (): void => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  // The bucket the list is scrolled to: the last one starting at or before the top row.
  const activeLabel = buckets.reduce<string | null>(
    (acc, b) => (b.offset <= topIndex ? b.label : acc),
    null,
  );
  // scrollMargin equals the sticky chrome height, so scrolling to `offset * rowHeight` lands the
  // target row just below the header rather than under it.
  const jumpToOffset = (offset: number) => window.scrollTo({ top: offset * rowHeight });

  // When the scrubber is shown, reserve a right lane on the header and rows so neither the column
  // labels nor the source badge slide under the letters.
  const showScrubber = buckets.length > 1;

  if (countQuery.isError) {
    return (
      <div className="flex-1 p-6 text-sm text-destructive-foreground">
        Failed to load: {(countQuery.error as Error).message}
      </div>
    );
  }
  if (totalCount === 0 && countQuery.isLoading) {
    return <div className="flex-1 p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (totalCount === 0) {
    return (
      <div className="flex-1 p-6 text-sm text-muted-foreground">
        {artist || album ? 'No tracks match this filter.' : 'No tracks yet. Run a library scan.'}
      </div>
    );
  }

  return (
    <div className="flex-1">
      <div
        role="row"
        className={cn(
          COLS,
          'sticky top-10 z-20 border-b border-border bg-background py-2 text-[11px] uppercase tracking-wider text-muted-foreground max-sm:hidden',
          showScrubber && 'pr-8',
        )}
      >
        <span>#</span>
        <span>Track</span>
        <span>Title</span>
        <span>Time</span>
        <span>Artist</span>
        <span>Album</span>
        <span>Year</span>
        <span className="text-right">Source</span>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={spacerRef}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((virtualRow) => {
              const edge = rowsByIndex.get(virtualRow.index);
              if (!edge) {
                // A row within the library's range whose window hasn't loaded yet.
                return (
                  <div
                    key={virtualRow.key}
                    role="row"
                    aria-hidden
                    className={cn(COLS, 'text-sm')}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                    }}
                  />
                );
              }
              const t = readFragment(TrackListRowDocument, edge.node);
              const active = current?.id === edge.node.id;
              const isSelected = selected.has(edge.node.id);
              return (
                <div
                  key={edge.cursor}
                  role="row"
                  aria-selected={isSelected}
                  onMouseDown={(e) => {
                    // Suppress the browser's native text-selection on
                    // double-click and shift-click (range select); plain
                    // click-and-drag selection is left untouched.
                    if (e.detail >= 2 || e.shiftKey) e.preventDefault();
                  }}
                  onClick={(e) => {
                    // Touch has no hover/double-click affordance, so a plain
                    // tap plays; long-press still opens the context menu.
                    if (isMobile) {
                      play(edge.node.id);
                      return;
                    }
                    selectRow(e, virtualRow.index, edge.node.id);
                  }}
                  onContextMenu={() => {
                    if (!selected.has(edge.node.id)) {
                      setSelected(new Set([edge.node.id]));
                      anchorRef.current = virtualRow.index;
                    }
                  }}
                  onMouseEnter={() => onRowEnter(edge.node.id)}
                  onMouseLeave={onRowLeave}
                  onDoubleClick={() => play(edge.node.id)}
                  className={cn(
                    COLS,
                    'cursor-pointer text-sm hover:bg-accent/40',
                    t.isLossless && 'shadow-[inset_3px_0_0_0] shadow-amber-400',
                    isSelected && 'bg-accent/60',
                    active && 'bg-primary/15 text-primary-foreground',
                    showScrubber && 'pr-8',
                  )}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                  }}
                >
                  <span className="text-muted-foreground tabular-nums max-sm:hidden">
                    {t.discNumber ?? ''}
                  </span>
                  <span className="text-muted-foreground tabular-nums max-sm:hidden">
                    {t.trackNumber ?? ''}
                  </span>
                  <span
                    className={cn(
                      'truncate max-sm:col-start-1 max-sm:row-start-1 max-sm:self-baseline max-sm:font-medium max-sm:leading-tight',
                      t.isLossless && 'font-medium',
                    )}
                  >
                    {t.title ?? (
                      <>
                        (untitled) <span className="text-muted-foreground/60">{t.path}</span>
                      </>
                    )}
                  </span>
                  <span className="tabular-nums text-muted-foreground max-sm:col-start-2 max-sm:row-start-1 max-sm:self-baseline max-sm:text-xs">
                    {t.duration.formatted}
                  </span>
                  <span className="truncate text-muted-foreground max-sm:col-start-1 max-sm:row-start-2 max-sm:self-start max-sm:text-xs max-sm:leading-tight">
                    {t.artist ?? ''}
                  </span>
                  <span className="truncate text-muted-foreground max-sm:hidden">
                    {t.album ?? ''}
                  </span>
                  <span className="text-muted-foreground tabular-nums max-sm:hidden">
                    {t.year ?? ''}
                  </span>
                  <span className="flex justify-end max-sm:col-start-3 max-sm:row-start-1 max-sm:self-baseline">
                    <span
                      className={cn(
                        'text-[10px] uppercase tracking-wide',
                        t.isLossless ? 'text-primary/80' : 'text-muted-foreground/70',
                      )}
                    >
                      {t.sourceFormat}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={selected.size === 0} onSelect={() => setEditing(true)}>
            Edit tags{selected.size > 1 ? ` (${selected.size})` : ''}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {showScrubber && (
        <LetterScrubber
          buckets={buckets}
          activeLabel={activeLabel}
          top={scrollMargin}
          onJump={jumpToOffset}
        />
      )}
      {selectedTracks.length > 0 && (
        <TagEditDialog tracks={selectedTracks} open={editing} onOpenChange={setEditing} />
      )}
    </div>
  );
}
