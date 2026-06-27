import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { graphql, readFragment } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { cn } from '../lib/utils.ts';
import {
  artworkDisplayUrl,
  ArtworkTile,
  TrackArtworkDocument,
  useTrackArtwork,
} from './track-artwork.tsx';
import { Button } from './ui/button.tsx';

const SHARE_PATH_PREFIX = '/share/';

/** The track id a shared link path (`/share/<id>`) carries, or null on any other path. */
function readShareTrackFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const { pathname } = window.location;
  if (!pathname.startsWith(SHARE_PATH_PREFIX)) return null;
  const id = decodeURIComponent(pathname.slice(SHARE_PATH_PREFIX.length).split('/')[0] ?? '');
  return id.length > 0 ? id : null;
}

/** Return to the library path (`/`), keeping the query the player owns (`track`/`t`) and the history depth, so dismissing the landing leaves the track loaded and resumable. */
function removeShareTrackFromUrl(): void {
  if (typeof window === 'undefined') return;
  const { search, hash } = window.location;
  window.history.replaceState(window.history.state, '', `/${search}${hash}`);
}

// The shared-track id is a tiny external store rather than per-hook state, so the landing (home)
// and the search box — which dismisses the landing when an artist/album result is chosen — read
// and clear one shared value. Seeded from the URL at load and resynced on back/forward.
let current = readShareTrackFromUrl();
const listeners = new Set<() => void>();
let popstateBound = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (!popstateBound && typeof window !== 'undefined') {
    popstateBound = true;
    window.addEventListener('popstate', () => {
      const next = readShareTrackFromUrl();
      if (next === current) return;
      current = next;
      emit();
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Dismiss the shared-track landing (revealing the library): drop the param and notify readers. A no-op when no landing is showing, so callers can fire it unconditionally. The player keeps the track loaded — only the `track`/`t` params it owns remain. */
export function clearSharedTrack(): void {
  if (current === null) return;
  removeShareTrackFromUrl();
  current = null;
  emit();
}

/** The track id a shared link (`/share/<id>`) names, read live from the URL so a refresh or back/forward restores the landing. `clear` dismisses the landing without a reload. */
export function useSharedTrack(): { shareTrackId: string | null; clear: () => void } {
  const shareTrackId = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  return { shareTrackId, clear: clearSharedTrack };
}

const SharedTrackDocument = graphql(
  `
    query SharedTrack($id: ID!) {
      track(id: $id) {
        id
        title
        artist
        album
        isLossless
        format
        sampleRate
        ...TrackArtwork
      }
    }
  `,
  [TrackArtworkDocument],
);

/** The landing a shared link opens on: a full-bleed hero for the single track, with the playback bar below to play it (the player loads it paused). `onBrowse` reveals the full library. */
export function SharedTrack({ id, onBrowse }: { id: string; onBrowse: () => void }) {
  const query = useQuery({
    queryKey: ['shared-track', id],
    queryFn: ({ signal }) => gqlRequest(SharedTrackDocument, { id }, signal),
  });
  const node = query.data?.track ?? null;
  const seed = node ? readFragment(TrackArtworkDocument, node).artwork : undefined;
  const { artwork, download, upload, uploadFromUrl, uploading, clear, error } = useTrackArtwork(
    id,
    seed,
  );
  const coverUrl = artworkDisplayUrl(artwork);

  if (query.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!node) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          This track couldn’t be found. It may have been removed from the library.
        </p>
        <Button variant="outline" onClick={onBrowse}>
          <ChevronLeft /> Browse library
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-12">
      {coverUrl ? (
        <div
          aria-hidden
          className="absolute inset-0 scale-110 bg-cover bg-center blur-3xl"
          style={{ backgroundImage: `url(${coverUrl})` }}
        />
      ) : (
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-b from-primary/15 to-background"
        />
      )}
      <div aria-hidden className="absolute inset-0 bg-background/75 backdrop-blur-sm" />

      <div className="relative flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <ArtworkTile
          artwork={artwork}
          download={download}
          upload={upload}
          uploadFromUrl={uploadFromUrl}
          uploading={uploading}
          clear={clear}
          error={error}
          className="aspect-square w-56 shadow-2xl"
          iconClassName="size-8"
        />
        <div className="flex flex-col items-center gap-1">
          <h2 className="text-2xl font-semibold leading-tight tracking-tight">
            {node.title ?? '(untitled)'}
          </h2>
          <p className="text-muted-foreground">
            {node.artist ?? 'Unknown artist'}
            {node.album ? ` — ${node.album}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium uppercase tracking-wide">{node.format}</span>
          <span
            className={cn(
              'rounded-sm px-1.5 py-0.5 text-[10px] uppercase',
              node.isLossless ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            {node.isLossless ? 'Lossless' : 'Lossy'}
          </span>
          <span className="text-muted-foreground">{node.sampleRate / 1000} kHz</span>
        </div>
        <Button variant="outline" onClick={onBrowse}>
          <ChevronLeft /> Browse library
        </Button>
      </div>
    </div>
  );
}
