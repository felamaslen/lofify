import type { QueryClient } from '@tanstack/react-query';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { readFragment } from 'gql.tada';
import { ListPlus } from 'lucide-react';
import { type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useIsMobile } from '../hooks/use-is-mobile.ts';
import { type FragmentOf, graphql, type ResultOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { useSwipeRight } from '../lib/use-swipe-right.ts';
import { cn } from '../lib/utils.ts';
import { useLibraryFilter } from '../state/library-filter.tsx';
import { playOrderChanged } from '../state/play-order.ts';
import { TrackByIdDocument, trackFormatFor, usePlayer } from '../state/player.tsx';
import { queueIdValue, rememberQueueId } from '../state/queue.ts';
import { useShowDuplicates } from '../state/show-duplicates.tsx';
import { LetterScrubber } from './letter-scrubber.tsx';
import { showQueueToast } from './queue-toast.tsx';
import { type EditableTrack, TagEditDialog } from './tag-edit-dialog.tsx';
import { TrackInfoButton, TrackInfoDocument } from './track-info-popover.tsx';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from './ui/context-menu.tsx';

const QueueAppendDocument = graphql(`
  mutation QueueAppend($trackId: ID!, $queueId: ID) {
    queueAppend(trackId: $trackId, queueId: $queueId) {
      id
    }
  }
`);

/** Append `trackIds` to the play queue in order, threading the lazily-created queue id through, then refresh queue readers and the player's prefetched successor, and confirm with a toast. */
async function enqueueTracks(queryClient: QueryClient, trackIds: string[]): Promise<void> {
  let queueId = queueIdValue();
  for (const trackId of trackIds) {
    const data = await gqlRequest(QueueAppendDocument, { trackId, queueId });
    queueId = data.queueAppend.id;
    rememberQueueId(queueId);
  }
  void queryClient.invalidateQueries({ queryKey: ['playback-queue'] });
  playOrderChanged();
  showQueueToast(
    trackIds.length > 1 ? `Added ${trackIds.length} tracks to queue` : 'Added to queue',
  );
}

export const TrackListRowDocument = graphql(`
  fragment TrackListRow on Track {
    title
    path
    trackNumber
    discNumber
    artist
    albumArtist
    album
    year
    isLossless
    duration {
      seconds
      formatted
    }
  }
`);

/** One page of the library: the matching total plus a window of rows. Composed into the index-addressed `TracksWindowDocument` and the home bootstrap query (`routes/home.tsx`) alike. */
export const TrackWindowDocument = graphql(
  `
    fragment TrackWindow on TrackConnection {
      totalCount
      edges {
        cursor
        node {
          id
          ...TrackListRow
          ...TrackInfo
        }
      }
    }
  `,
  [TrackListRowDocument, TrackInfoDocument],
);

/** A window of the list addressed by absolute index, so the scrubber can jump to any offset. */
const TracksWindowDocument = graphql(
  `
    query TracksWindow(
      $offset: Int!
      $first: Int!
      $filterArtistIn: [String!]
      $filterAlbumIn: [String!]
      $includeDuplicates: Boolean
    ) {
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
  [TrackWindowDocument],
);

/** The A–Z scrubber buckets for the active filters: each first-letter label and the row index it starts at. Composed into the index-addressed `ArtistIndexQueryDocument` and the home bootstrap query (`routes/home.tsx`) alike. */
export const ArtistIndexDocument = graphql(`
  fragment ArtistIndex on Query {
    artistIndex(
      filterArtistIn: $filterArtistIn
      filterAlbumIn: $filterAlbumIn
      includeDuplicates: $includeDuplicates
    ) {
      label
      offset
    }
  }
`);

/** Standalone artist index for a view filtered after load; the opening view's index rides the home bootstrap query instead. */
const ArtistIndexQueryDocument = graphql(
  `
    query ArtistIndexQuery(
      $filterArtistIn: [String!]
      $filterAlbumIn: [String!]
      $includeDuplicates: Boolean
    ) {
      ...ArtistIndex
    }
  `,
  [ArtistIndexDocument],
);

type WindowEdge = ResultOf<typeof TrackWindowDocument>['edges'][number];

/** Unmask a track connection selected via the `TrackWindow` fragment. */
function readWindow(
  connection: ResultOf<typeof TracksWindowDocument>['tracks'] | undefined,
): ResultOf<typeof TrackWindowDocument> | null {
  return connection ? readFragment(TrackWindowDocument, connection) : null;
}

/** Unmask a query result carrying the `ArtistIndex` fragment. */
function readIndex(
  source: FragmentOf<typeof ArtistIndexDocument> | undefined,
): ResultOf<typeof ArtistIndexDocument> | null {
  return source ? readFragment(ArtistIndexDocument, source) : null;
}

export const PAGE_SIZE = 100;
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
  const { showDuplicates } = useShowDuplicates();
  const filterArtistIn = artist ? [artist] : null;
  const filterAlbumIn = album ? [album] : null;

  // A cheap, stable source of the total — independent of which windows are loaded — so the
  // virtualizer's row count (and thus the scrollbar range) never collapses while paging.
  // The home bootstrap (`routes/home.tsx`) seeds this key for the opening view, so the
  // staleTime keeps the seed from being refetched straight back on mount.
  const countQuery = useQuery({
    queryKey: ['tracks-count', artist, album, showDuplicates],
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      gqlRequest(
        TracksWindowDocument,
        { offset: 0, first: 0, filterArtistIn, filterAlbumIn, includeDuplicates: showDuplicates },
        signal,
      ),
  });
  const totalCount = readWindow(countQuery.data?.tracks)?.totalCount ?? 0;

  // Only refetched when the key (filters) changes or it is invalidated — never on
  // focus. The opening view's index is seeded by the home bootstrap.
  const indexQuery = useQuery({
    queryKey: ['artist-index', artist, album, showDuplicates],
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      gqlRequest(
        ArtistIndexQueryDocument,
        { filterArtistIn, filterAlbumIn, includeDuplicates: showDuplicates },
        signal,
      ),
  });
  const buckets = useMemo(() => readIndex(indexQuery.data)?.artistIndex ?? [], [indexQuery.data]);

  const spacerRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);

  // An open info preview is dismissed by Radix on the outside pointerdown, but the same tap still
  // lands a click on the row. Snapshot whether a preview was open at the start of the gesture (in
  // the capture phase, before Radix's bubble-phase dismiss) so the click can be swallowed: it
  // should only close the preview, not play or change the selection.
  const previewCountRef = useRef(0);
  const tapClosedPreviewRef = useRef(false);

  // Escape clears the selection, unless the tag-edit dialog owns the key (it closes itself first).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editing) return;
      setSelected((prev) => (prev.size === 0 ? prev : new Set()));
      anchorRef.current = null;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editing]);

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

  // The row index under the top of the list, derived from page scroll. Because the row container
  // starts exactly `scrollMargin` (the sticky-chrome height) down the document, that offset cancels
  // and the index is simply `scrollY / rowHeight`. Drives the scrubber's active letter.
  const [topIndex, setTopIndex] = useState(0);
  useEffect(() => {
    const onScroll = () => setTopIndex(Math.max(0, Math.floor(window.scrollY / rowHeight)));
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [rowHeight]);

  // Which index-pages cover the visible range; fetched on demand so a jump loads only its window.
  const firstPage = Math.floor((items[0]?.index ?? 0) / PAGE_SIZE);
  const lastPage = Math.floor((items.at(-1)?.index ?? 0) / PAGE_SIZE);
  const pageIndexes: number[] = [];
  for (let p = firstPage; p <= lastPage; p++) pageIndexes.push(p);

  const windowResults = useQueries({
    queries: pageIndexes.map((p) => ({
      // Page 0 of the opening view is seeded by the home bootstrap query.
      queryKey: ['tracks-window', artist, album, showDuplicates, p],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        gqlRequest(
          TracksWindowDocument,
          {
            offset: p * PAGE_SIZE,
            first: PAGE_SIZE,
            filterArtistIn,
            filterAlbumIn,
            includeDuplicates: showDuplicates,
          },
          signal,
        ),
      staleTime: 30_000,
    })),
  });

  const rowsByIndex = new Map<number, WindowEdge>();
  pageIndexes.forEach((p, i) => {
    const edges = readWindow(windowResults[i]?.data?.tracks)?.edges ?? [];
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
        albumArtist: t.albumArtist,
        album: t.album,
        trackNumber: t.trackNumber,
        discNumber: t.discNumber,
        year: t.year,
      });
    }
    return out;
    // rowsByIndex is rebuilt every render; depend on the loaded windows + selection instead.
  }, [windowResults, selected]);

  /** The selected ids in row order (selection sets carry insertion order, which a shift-range or ctrl-click sequence needn't match). */
  const selectedIdsInRowOrder = (): string[] =>
    [...rowsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, edge]) => selected.has(edge.node.id))
      .map(([, edge]) => edge.node.id);

  const enqueueSelected = (): void => {
    const ids = selectedIdsInRowOrder();
    if (ids.length > 0) void enqueueTracks(queryClient, ids);
  };

  const swipeHandlers = useSwipeRight((id) => void enqueueTracks(queryClient, [id]));

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

  // The count query drives the loading/error state; the opening view never shows
  // either because the home bootstrap seeded its data before this rendered.
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
          'sticky top-14 z-20 border-b border-border bg-background py-2 text-[11px] uppercase tracking-wider text-muted-foreground max-sm:hidden',
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
        <span aria-hidden />
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={spacerRef}
            // overflow-x-clip: a swiped row slides right by up to MAX_PULL_PX; clip (rather than
            // hidden) cuts it off without creating a horizontal scroll container.
            className="relative w-full overflow-x-clip"
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
                  onPointerDownCapture={() => {
                    tapClosedPreviewRef.current = previewCountRef.current > 0;
                  }}
                  onMouseDown={(e) => {
                    // Suppress the browser's native text-selection on
                    // double-click and shift-click (range select); plain
                    // click-and-drag selection is left untouched.
                    if (e.detail >= 2 || e.shiftKey) e.preventDefault();
                  }}
                  onClick={(e) => {
                    // A tap that dismissed an open info preview should only close it — not play or
                    // change the selection.
                    if (tapClosedPreviewRef.current) {
                      tapClosedPreviewRef.current = false;
                      return;
                    }
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
                  {...(isMobile ? swipeHandlers(edge.node.id) : {})}
                  className={cn(
                    // touch-pan-y: vertical scrolling stays native, but the browser never pans the
                    // view for a horizontal gesture starting on a row — that belongs to the
                    // swipe-to-enqueue handler alone.
                    'group cursor-pointer touch-pan-y text-sm',
                    !isSelected && 'hover:bg-accent',
                    // The long-press that opens the context menu must not start a native text
                    // selection; desktop keeps click-drag text selection.
                    isMobile && 'select-none',
                    !t.isLossless && !active && 'text-muted-foreground',
                    virtualRow.index % 2 === 1 && !isSelected && 'bg-muted/70',
                    isSelected && 'bg-primary text-primary-foreground hover:bg-primary/90',
                    active && 'shadow-[inset_4px_0_0_0]',
                    active && !isSelected && 'shadow-primary text-primary',
                    active && isSelected && 'shadow-primary-foreground',
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
                  {isMobile && (
                    <span
                      data-swipe-icon
                      aria-hidden
                      className="absolute inset-y-0 left-0 flex w-12 items-center justify-center text-primary opacity-0"
                    >
                      <ListPlus className="size-5" />
                    </span>
                  )}
                  <div
                    data-swipe-content
                    className={cn(
                      COLS,
                      'h-full group-aria-selected:[&>span]:text-primary-foreground',
                      showScrubber && 'pr-8',
                    )}
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
                          (untitled){' '}
                          <span className="text-muted-foreground/60 group-aria-selected:text-primary-foreground/70">
                            {t.path}
                          </span>
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
                    <span className="flex justify-end max-sm:col-start-3 max-sm:row-start-1 max-sm:self-center">
                      <TrackInfoButton
                        track={edge.node}
                        onOpenChange={(open) => {
                          previewCountRef.current += open ? 1 : -1;
                        }}
                      />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={selected.size === 0} onSelect={enqueueSelected}>
            Add to queue{selected.size > 1 ? ` (${selected.size})` : ''}
          </ContextMenuItem>
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
