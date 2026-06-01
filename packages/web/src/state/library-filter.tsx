import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

/** The active library filter. At most one of artist/album-scope is set at a time; an album filter also pins its artist (when the album has exactly one) so same-named albums by other artists are excluded. */
export type LibraryFilter = {
  artist: string | null;
  album: string | null;
};

type LibraryFilterContextValue = LibraryFilter & {
  /** Restrict the library to a single artist, clearing any album scope. */
  setArtistFilter: (artist: string) => void;
  /** Restrict the library to a single album, pinned to its artist when known. */
  setAlbumFilter: (album: string, artist: string | null) => void;
  /** Remove the active filter. */
  clear: () => void;
};

const ARTIST_PARAM = 'artist';
const ALBUM_PARAM = 'album';

/** Read the active filter the URL carries, so a refresh or a shared link restores it. */
function readFilterFromUrl(): LibraryFilter {
  if (typeof window === 'undefined') return { artist: null, album: null };
  const params = new URLSearchParams(window.location.search);
  return { artist: params.get(ARTIST_PARAM), album: params.get(ALBUM_PARAM) };
}

/** Mirror the filter into the URL (`replaceState`, merging the existing params the player owns). */
function writeFilterToUrl(filter: LibraryFilter): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (filter.artist) url.searchParams.set(ARTIST_PARAM, filter.artist);
  else url.searchParams.delete(ARTIST_PARAM);
  if (filter.album) url.searchParams.set(ALBUM_PARAM, filter.album);
  else url.searchParams.delete(ALBUM_PARAM);
  window.history.replaceState(window.history.state, '', url);
}

/** The active filter as `Query.tracks` variables, read live from the URL. Lets non-React consumers (the player's next/prev resolution) honour the filter without subscribing to the context. */
export function libraryFilterVars(): {
  filterArtistIn: string[] | null;
  filterAlbumIn: string[] | null;
} {
  const { artist, album } = readFilterFromUrl();
  return {
    filterArtistIn: artist ? [artist] : null,
    filterAlbumIn: album ? [album] : null,
  };
}

const Ctx = createContext<LibraryFilterContextValue | null>(null);

export function LibraryFilterProvider({ children }: { children: ReactNode }) {
  const [filter, setFilterState] = useState<LibraryFilter>(readFilterFromUrl);

  useEffect(() => {
    const onPopState = () => setFilterState(readFilterFromUrl());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const value = useMemo<LibraryFilterContextValue>(() => {
    const update = (next: LibraryFilter) => {
      writeFilterToUrl(next);
      setFilterState(next);
    };
    return {
      ...filter,
      setArtistFilter: (artist) => update({ artist, album: null }),
      setAlbumFilter: (album, artist) => update({ artist, album }),
      clear: () => update({ artist: null, album: null }),
    };
  }, [filter]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibraryFilter() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useLibraryFilter must be inside <LibraryFilterProvider>');
  return ctx;
}
