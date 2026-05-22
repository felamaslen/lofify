import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { gqlRequest } from '../lib/gql-request.ts';
import { TracksQuery } from '../lib/queries.ts';
import { usePlayer } from '../state/player.tsx';

const PAGE_SIZE = 100;
const ROW_HEIGHT = 32;

export function TrackList() {
  const { format, play, current } = usePlayer();

  const query = useInfiniteQuery({
    queryKey: ['tracks', format],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      gqlRequest(
        TracksQuery,
        {
          first: PAGE_SIZE,
          last: null,
          after: pageParam,
          before: null,
          format,
          quality: null,
        },
        signal,
      ),
    getNextPageParam: (last) =>
      last.tracks?.pageInfo.hasNextPage
        ? (last.tracks.pageInfo.endCursor ?? null)
        : undefined,
  });

  const edges = useMemo(
    () =>
      query.data?.pages.flatMap((page) => page.tracks?.edges ?? []) ?? [],
    [query.data],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
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
      <div className="track-list-status">
        Failed to load: {(query.error as Error).message}
      </div>
    );
  }
  if (edges.length === 0 && query.isLoading) {
    return <div className="track-list-status">Loading…</div>;
  }
  if (edges.length === 0) {
    return (
      <div className="track-list-status">No tracks yet. Run a library scan.</div>
    );
  }

  return (
    <div className="track-list">
      <div className="track-list-header" role="row">
        <span className="col-disc">#</span>
        <span className="col-track">Track</span>
        <span className="col-title">Title</span>
        <span className="col-duration">Time</span>
        <span className="col-artist">Artist</span>
        <span className="col-album">Album</span>
        <span className="col-year">Year</span>
      </div>
      <div ref={scrollRef} className="track-list-scroll">
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
            const t = edge.node;
            const active = current?.id === t.id;
            return (
              <div
                key={edge.cursor}
                role="row"
                className={`track-row${active ? ' is-active' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onDoubleClick={() => play(t.id)}
              >
                <span className="col-disc">{t.discNumber ?? ''}</span>
                <span className="col-track">{t.trackNumber ?? ''}</span>
                <span className="col-title">{t.title ?? '(untitled)'}</span>
                <span className="col-duration">{t.duration.formatted}</span>
                <span className="col-artist">{t.artist ?? ''}</span>
                <span className="col-album">{t.album ?? ''}</span>
                <span className="col-year">{t.year ?? ''}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
