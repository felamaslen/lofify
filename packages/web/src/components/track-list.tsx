import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { readFragment } from 'gql.tada';
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';

import { useIsMobile } from '../hooks/use-is-mobile.ts';
import { graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { cn } from '../lib/utils.ts';
import { useLibraryFilter } from '../state/library-filter.tsx';
import { TrackByIdDocument, trackFormatFor, usePlayer } from '../state/player.tsx';
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

  const query = useInfiniteQuery({
    queryKey: ['tracks', artist, album],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      gqlRequest(
        TracksDocument,
        {
          first: PAGE_SIZE,
          last: null,
          after: pageParam,
          before: null,
          filterArtistIn,
          filterAlbumIn,
        },
        signal,
      ),
    getNextPageParam: (last) =>
      last.tracks?.pageInfo.hasNextPage ? (last.tracks.pageInfo.endCursor ?? null) : undefined,
  });

  const edges = useMemo(
    () => query.data?.pages.flatMap((page) => page.tracks?.edges ?? []) ?? [],
    [query.data],
  );

  // The server reports the full match count up front, so the scrollbar can span
  // the whole library from the first page — rows past what's loaded render as
  // placeholders until paging fills them in.
  const totalCount = query.data?.pages[0]?.tracks?.totalCount ?? 0;
  const rowCount = Math.max(edges.length, totalCount);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);

  const selectRow = (e: MouseEvent, index: number, id: string): void => {
    if (e.shiftKey && anchorRef.current !== null) {
      const from = Math.min(anchorRef.current, index);
      const to = Math.max(anchorRef.current, index);
      setSelected(new Set(edges.slice(from, to + 1).map((edge) => edge.node.id)));
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

  const selectedTracks = useMemo<EditableTrack[]>(
    () =>
      edges
        .filter((edge) => selected.has(edge.node.id))
        .map((edge) => {
          const t = readFragment(TrackListRowDocument, edge.node);
          return {
            id: edge.node.id,
            title: t.title,
            artist: t.artist,
            album: t.album,
            trackNumber: t.trackNumber,
            discNumber: t.discNumber,
            year: t.year,
          };
        }),
    [edges, selected],
  );

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

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  const items = virtualizer.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? 0;

  useEffect(() => {
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    if (lastIndex < edges.length - PAGE_SIZE / 2) return;
    void query.fetchNextPage();
  }, [query, lastIndex, edges.length]);

  if (query.isError) {
    return (
      <div className="p-6 text-sm text-destructive-foreground">
        Failed to load: {(query.error as Error).message}
      </div>
    );
  }
  if (edges.length === 0 && query.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (edges.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {artist || album ? 'No tracks match this filter.' : 'No tracks yet. Run a library scan.'}
      </div>
    );
  }

  return (
    <div className="grid grid-rows-[auto_1fr] overflow-hidden">
      <div
        role="row"
        className={cn(
          COLS,
          'border-b border-border py-2 text-[11px] uppercase tracking-wider text-muted-foreground max-sm:hidden',
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
          <div ref={scrollRef} className="relative overflow-y-auto">
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: 'relative',
                width: '100%',
              }}
            >
              {items.map((virtualRow) => {
                const edge = edges[virtualRow.index];
                if (!edge) {
                  // A row within the library's range that paging hasn't reached yet.
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
                        transform: `translateY(${virtualRow.start}px)`,
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
                    )}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
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
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={selected.size === 0} onSelect={() => setEditing(true)}>
            Edit tags{selected.size > 1 ? ` (${selected.size})` : ''}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {selectedTracks.length > 0 && (
        <TagEditDialog tracks={selectedTracks} open={editing} onOpenChange={setEditing} />
      )}
    </div>
  );
}
