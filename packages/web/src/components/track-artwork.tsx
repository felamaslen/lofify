import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageDown, Loader2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { graphql, readFragment, type ResultOf } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { cn } from '../lib/utils.ts';
import { resolvePlaybackUrl } from '../state/player.tsx';

export const TrackArtworkDocument = graphql(`
  fragment TrackArtwork on Track {
    id
    artwork {
      __typename
      ... on Artwork {
        album
        albumArtist
        media {
          url
        }
      }
      ... on ArtworkStatus {
        inProgress
        message
      }
    }
  }
`);

const TrackArtworkRefreshDocument = graphql(
  `
    query TrackArtworkRefresh($id: ID!) {
      track(id: $id) {
        ...TrackArtwork
      }
    }
  `,
  [TrackArtworkDocument],
);

const ArtworkDownloadDocument = graphql(`
  mutation ArtworkDownload($trackId: ID!) {
    artworkDownload(trackId: $trackId) {
      __typename
      ... on Artwork {
        album
        albumArtist
        media {
          url
        }
      }
      ... on ArtworkStatus {
        inProgress
        message
      }
    }
  }
`);

type TrackArtworkValue = ResultOf<typeof TrackArtworkDocument>['artwork'];

const POLL_INTERVAL_MS = 2000;

function isInProgress(artwork: TrackArtworkValue | undefined): boolean {
  return artwork?.__typename === 'ArtworkStatus' && artwork.inProgress;
}

/**
 * The live artwork state for a track, and a `download` trigger. `initial` seeds the state from a
 * colocated fragment (the playback bar's case); pass `fetchOnMount` instead to load lazily (the
 * info popover, where embedding artwork in the list fragment would fan a resolver query out to
 * every visible row). Polls while a download is running, stopping on resolution; the query key is
 * shared, so the bar and the popover never poll the same track twice.
 */
export function useTrackArtwork(
  trackId: string,
  initial: TrackArtworkValue | undefined,
  { fetchOnMount = false } = {},
) {
  // Bridges the gap after a download is requested but before the first poll lands; without it the
  // stale fragment (artwork: null) would keep the query disabled and nothing would ever poll.
  const [requested, setRequested] = useState<TrackArtworkValue | null>(null);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['track-artwork', trackId],
    queryFn: ({ signal }) => gqlRequest(TrackArtworkRefreshDocument, { id: trackId }, signal),
    enabled: fetchOnMount || isInProgress(requested ?? initial),
    refetchInterval: (q) => {
      const node = q.state.data?.track;
      const latest = node ? readFragment(TrackArtworkDocument, node).artwork : undefined;
      return isInProgress(latest ?? requested ?? initial) ? POLL_INTERVAL_MS : false;
    },
  });

  const polled = query.data?.track
    ? readFragment(TrackArtworkDocument, query.data.track).artwork
    : undefined;
  const artwork = polled !== undefined ? polled : (requested ?? initial ?? null);

  const mutation = useMutation({
    mutationFn: () => gqlRequest(ArtworkDownloadDocument, { trackId }),
    onSuccess: (data) => {
      setRequested(data.artworkDownload);
      void queryClient.invalidateQueries({ queryKey: ['track-artwork', trackId] });
    },
  });

  return {
    artwork,
    loading: fetchOnMount && query.isPending,
    download: () => mutation.mutate(),
    downloadError: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

/**
 * Square artwork tile: the cover once downloaded, a spinner while one is fetched, and a
 * download/retry affordance otherwise. Size and rounding come from `className`.
 */
export function ArtworkTile({
  artwork,
  loading = false,
  download,
  downloadError,
  className,
  iconClassName = 'size-4',
}: {
  artwork: TrackArtworkValue | null;
  loading?: boolean;
  download: () => void;
  downloadError: string | null;
  className?: string;
  iconClassName?: string;
}) {
  if (artwork?.__typename === 'Artwork') {
    return (
      <img
        src={resolvePlaybackUrl(artwork.media.url)}
        alt={`Cover of ${artwork.album} by ${artwork.albumArtist}`}
        loading="lazy"
        className={cn(
          'shrink-0 rounded-md object-cover ring-1 ring-border animate-in fade-in',
          className,
        )}
      />
    );
  }

  if (loading || isInProgress(artwork)) {
    return (
      <div
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md bg-muted/40 ring-1 ring-border',
          className,
        )}
        aria-label="Fetching album art"
      >
        <Loader2 className={cn('animate-spin text-muted-foreground/70', iconClassName)} />
      </div>
    );
  }

  const failed = artwork?.__typename === 'ArtworkStatus' || downloadError != null;
  const message =
    downloadError ?? (artwork?.__typename === 'ArtworkStatus' ? artwork.message : null);
  return (
    <button
      type="button"
      onClick={download}
      title={message ? `${message} — click to retry` : 'Download album art'}
      aria-label={failed ? 'Retry album art download' : 'Download album art'}
      className={cn(
        'group flex shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground/50 transition-colors hover:border-solid hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        failed && 'text-destructive-foreground/70 hover:text-destructive-foreground',
        className,
      )}
    >
      {failed ? (
        <TriangleAlert className={iconClassName} />
      ) : (
        <ImageDown className={iconClassName} />
      )}
    </button>
  );
}
