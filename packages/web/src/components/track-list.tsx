import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { readFragment } from 'gql.tada';
import { useEffect, useMemo, useRef } from 'react';

import { graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { cn } from '../lib/utils.ts';
import { TrackByIdDocument, usePlayer } from '../state/player.tsx';

const TrackListRowDocument = graphql(`
  fragment TrackListRow on Track {
    title
    trackNumber
    discNumber
    artist
    album
    year
    duration {
      seconds
      formatted
    }
  }
`);

export const TracksDocument = graphql(
  `
    query Tracks($first: Int, $last: Int, $after: String, $before: String) {
      tracks(first: $first, last: $last, after: $after, before: $before) {
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
const HOVER_PREFETCH_MS = 200;

const COLS =
  'grid grid-cols-[40px_60px_minmax(0,2fr)_80px_minmax(0,1.2fr)_minmax(0,1.4fr)_80px] items-center gap-3 px-4';

export function TrackList() {
  const { format, play, current } = usePlayer();
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: ['tracks'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      gqlRequest(
        TracksDocument,
        { first: PAGE_SIZE, last: null, after: pageParam, before: null },
        signal,
      ),
    getNextPageParam: (last) =>
      last.tracks?.pageInfo.hasNextPage ? (last.tracks.pageInfo.endCursor ?? null) : undefined,
  });

  const edges = useMemo(
    () => query.data?.pages.flatMap((page) => page.tracks?.edges ?? []) ?? [],
    [query.data],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onRowEnter = (id: string): void => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      void queryClient.prefetchQuery({
        queryKey: ['track', id, format],
        queryFn: ({ signal }) =>
          gqlRequest(TrackByIdDocument, { id, format, quality: null }, signal),
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
    count: edges.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

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
      <div className="p-6 text-sm text-muted-foreground">No tracks yet. Run a library scan.</div>
    );
  }

  return (
    <div className="grid grid-rows-[auto_1fr] overflow-hidden">
      <div
        role="row"
        className={cn(
          COLS,
          'border-b border-border py-2 text-[11px] uppercase tracking-wider text-muted-foreground',
        )}
      >
        <span>#</span>
        <span>Track</span>
        <span>Title</span>
        <span>Time</span>
        <span>Artist</span>
        <span>Album</span>
        <span>Year</span>
      </div>
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
            if (!edge) return null;
            const t = readFragment(TrackListRowDocument, edge.node);
            const active = current?.id === edge.node.id;
            return (
              <div
                key={edge.cursor}
                role="row"
                onMouseDown={(e) => {
                  if (e.detail >= 2) e.preventDefault();
                }}
                onMouseEnter={() => onRowEnter(edge.node.id)}
                onMouseLeave={onRowLeave}
                onDoubleClick={() => play(edge.node.id)}
                className={cn(
                  COLS,
                  'cursor-pointer text-sm hover:bg-accent/40',
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
                <span className="text-muted-foreground tabular-nums">{t.discNumber ?? ''}</span>
                <span className="text-muted-foreground tabular-nums">{t.trackNumber ?? ''}</span>
                <span className="truncate">{t.title ?? '(untitled)'}</span>
                <span className="tabular-nums text-muted-foreground">{t.duration.formatted}</span>
                <span className="truncate text-muted-foreground">{t.artist ?? ''}</span>
                <span className="truncate text-muted-foreground">{t.album ?? ''}</span>
                <span className="text-muted-foreground tabular-nums">{t.year ?? ''}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
