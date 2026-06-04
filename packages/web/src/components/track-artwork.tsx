import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageDown, Loader2, TriangleAlert } from 'lucide-react';
import { type DragEvent, useEffect, useRef, useState } from 'react';

import { graphql, readFragment, type ResultOf } from '../lib/gql.ts';
import { gqlRequest, gqlUpload } from '../lib/gql-request.ts';
import { cn } from '../lib/utils.ts';

export const TrackArtworkDocument = graphql(`
  fragment TrackArtwork on Track {
    id
    artwork {
      __typename
      ... on Artwork {
        album
        albumArtist
        media {
          ... on Image {
            preview(size: SQUARE_500) {
              src
            }
          }
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
          ... on Image {
            preview(size: SQUARE_500) {
              src
            }
          }
        }
      }
      ... on ArtworkStatus {
        inProgress
        message
      }
    }
  }
`);

const TrackArtworkUploadDocument = graphql(
  `
    mutation TrackArtworkUpload($id: ID!, $artwork: Upload) {
      trackUpdate(id: $id, artwork: $artwork) {
        ...TrackArtwork
      }
    }
  `,
  [TrackArtworkDocument],
);

type TrackArtworkValue = ResultOf<typeof TrackArtworkDocument>['artwork'];

/**
 * The URL to render for a track's artwork: the immutably-cached 500px preview. The original (`media.url`) is served no-store — it exists for downloads/full-size use, never for display.
 */
export function artworkDisplayUrl(artwork: TrackArtworkValue | null | undefined): string | null {
  if (artwork?.__typename !== 'Artwork') return null;
  return artwork.media.preview.src;
}

const POLL_INTERVAL_MS = 2000;

function isInProgress(artwork: TrackArtworkValue | undefined): boolean {
  return artwork?.__typename === 'ArtworkStatus' && artwork.inProgress;
}

/**
 * The live artwork state for a track, and a `download` trigger. `initial` seeds the state from a colocated fragment (the playback bar's case); pass `fetchOnMount` instead to load lazily (the info popover, where embedding artwork in the list fragment would fan a resolver query out to every visible row). Polls while a download is running, stopping on resolution; the query key is shared, so the bar and the popover never poll the same track twice.
 *
 * A track whose artwork has never been requested is requested automatically the moment it is previewed. Only the never-requested state auto-fires: a FAILED row stays failed until the user retries by hand, and an auto-request that errors (e.g. the track has no album) is not repeated.
 */
export function useTrackArtwork(
  trackId: string,
  initial: TrackArtworkValue | undefined,
  { fetchOnMount = false } = {},
) {
  // Bridges the gap after a download is requested but before the first poll lands; without it the
  // stale fragment (artwork: null) would keep the query disabled and nothing would ever poll.
  // Keyed by track id: the playback bar's hook instance survives track changes, and one track's
  // request must not bleed into the next.
  const [requested, setRequested] = useState<{
    forId: string;
    value: TrackArtworkValue;
  } | null>(null);
  const requestedValue = requested?.forId === trackId ? requested.value : undefined;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['track-artwork', trackId],
    queryFn: ({ signal }) => gqlRequest(TrackArtworkRefreshDocument, { id: trackId }, signal),
    enabled: fetchOnMount || isInProgress(requestedValue ?? initial),
    refetchInterval: (q) => {
      const node = q.state.data?.track;
      const latest = node ? readFragment(TrackArtworkDocument, node).artwork : undefined;
      return isInProgress(latest ?? requestedValue ?? initial) ? POLL_INTERVAL_MS : false;
    },
  });

  const polled = query.data?.track
    ? readFragment(TrackArtworkDocument, query.data.track).artwork
    : undefined;
  const artwork = polled !== undefined ? polled : (requestedValue ?? initial ?? null);
  const loading = fetchOnMount && query.isPending;

  const mutation = useMutation({
    mutationFn: () => gqlRequest(ArtworkDownloadDocument, { trackId }),
    onSuccess: (data) => {
      setRequested({ forId: trackId, value: data.artworkDownload });
      void queryClient.invalidateQueries({ queryKey: ['track-artwork', trackId] });
    },
  });
  const { mutate } = mutation;

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      gqlUpload(TrackArtworkUploadDocument, { id: trackId, artwork: file }),
    onSuccess: (data) => {
      setRequested({
        forId: trackId,
        value: readFragment(TrackArtworkDocument, data.trackUpdate).artwork,
      });
      void queryClient.invalidateQueries({ queryKey: ['track-artwork', trackId] });
    },
  });

  // The auto-request. The ref stops it re-firing for the same track (StrictMode remounts, an
  // errored attempt leaving artwork null); the server-side upsert makes concurrent fires from the
  // bar and the popover harmless.
  const autoRequestedFor = useRef<string | null>(null);
  const neverRequested = artwork === null && !loading;
  useEffect(() => {
    if (!neverRequested || autoRequestedFor.current === trackId) return;
    autoRequestedFor.current = trackId;
    mutate();
  }, [neverRequested, trackId, mutate]);

  const error = uploadMutation.error ?? mutation.error;
  return {
    artwork,
    loading,
    download: () => mutate(),
    upload: (file: File) => uploadMutation.mutate(file),
    uploading: uploadMutation.isPending,
    error: error instanceof Error ? error.message : null,
  };
}

/**
 * Square artwork tile: the cover once downloaded, a spinner while one is fetched or uploaded, and a download/retry affordance otherwise. Size and rounding come from `className`. Dropping an image file onto the tile — in any state — uploads it as the album's artwork.
 */
export function ArtworkTile({
  artwork,
  loading = false,
  download,
  upload,
  uploading = false,
  error,
  className,
  iconClassName = 'size-4',
}: {
  artwork: TrackArtworkValue | null;
  loading?: boolean;
  download: () => void;
  upload: (file: File) => void;
  uploading?: boolean;
  error: string | null;
  className?: string;
  iconClassName?: string;
}) {
  const [dragOver, setDragOver] = useState(false);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
    if (file) upload(file);
  };

  let inner;
  if (loading || uploading || isInProgress(artwork)) {
    inner = (
      <div
        className="flex size-full items-center justify-center rounded-md bg-muted/40 ring-1 ring-border"
        aria-label="Fetching album art"
      >
        <Loader2 className={cn('animate-spin text-muted-foreground/70', iconClassName)} />
      </div>
    );
  } else if (artwork?.__typename === 'Artwork') {
    inner = (
      <img
        src={artworkDisplayUrl(artwork) ?? undefined}
        alt={`Cover of ${artwork.album} by ${artwork.albumArtist}`}
        loading="lazy"
        title="Drop an image to replace the album art"
        className="size-full rounded-md object-cover ring-1 ring-border animate-in fade-in"
      />
    );
  } else {
    const failed = artwork?.__typename === 'ArtworkStatus' || error != null;
    const message = error ?? (artwork?.__typename === 'ArtworkStatus' ? artwork.message : null);
    inner = (
      <button
        type="button"
        onClick={download}
        title={
          message
            ? `${message} — click to retry, or drop an image`
            : 'Download album art, or drop an image'
        }
        aria-label={failed ? 'Retry album art download' : 'Download album art'}
        className={cn(
          'group flex size-full items-center justify-center rounded-md border border-dashed border-border text-muted-foreground/50 transition-colors hover:border-solid hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          failed && 'text-destructive-foreground/70 hover:text-destructive-foreground',
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

  return (
    <div
      className={cn(
        'relative shrink-0 rounded-md',
        dragOver && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
        className,
      )}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {inner}
    </div>
  );
}
