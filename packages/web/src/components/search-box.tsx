import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';

import { graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { cn } from '../lib/utils.ts';
import { useLibraryFilter } from '../state/library-filter.tsx';
import { usePlayer } from '../state/player.tsx';
import { Input } from './ui/input.tsx';

const SearchDocument = graphql(`
  query Search($query: String!) {
    search(query: $query) {
      artists {
        edges {
          node {
            name
          }
        }
      }
      albums {
        edges {
          node {
            name
            artists {
              name
            }
          }
        }
      }
      tracks {
        edges {
          node {
            id
            title
            artist
          }
        }
      }
    }
  }
`);

const DEBOUNCE_MS = 200;

/** A flat, keyboard-navigable view over the grouped search response — one entry per selectable row. */
type Item =
  | { kind: 'artist'; label: string; name: string }
  | { kind: 'album'; label: string; name: string; artists: string[] }
  | { kind: 'track'; label: string; sublabel: string | null; id: string };

export function SearchBox() {
  const { play } = usePlayer();
  const { setArtistFilter, setAlbumFilter } = useLibraryFilter();

  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  useEffect(() => {
    const id = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [input]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', query],
    queryFn: ({ signal }) => gqlRequest(SearchDocument, { query }, signal),
    enabled: query.length > 0,
    placeholderData: (prev) => prev,
  });

  const items = useMemo<Item[]>(() => {
    const search = data?.search;
    if (!search) return [];
    return [
      ...search.artists.edges.map(
        (e): Item => ({ kind: 'artist', label: e.node.name, name: e.node.name }),
      ),
      ...search.albums.edges.map(
        (e): Item => ({
          kind: 'album',
          label: e.node.name,
          name: e.node.name,
          artists: e.node.artists.map((a) => a.name),
        }),
      ),
      ...search.tracks.edges.map(
        (e): Item => ({
          kind: 'track',
          label: e.node.title ?? '(untitled)',
          sublabel: e.node.artist,
          id: e.node.id,
        }),
      ),
    ];
  }, [data]);

  useEffect(() => {
    setActive(0);
  }, [items]);

  const showDropdown = open && query.length > 0;

  useEffect(() => {
    if (!showDropdown) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showDropdown]);

  const reset = () => {
    setInput('');
    setQuery('');
    setOpen(false);
  };

  const choose = (item: Item) => {
    switch (item.kind) {
      case 'artist':
        setArtistFilter(item.name);
        break;
      case 'album':
        // Pin the artist only when the album is credited to exactly one, so a
        // multi-artist album (compilation, split) isn't narrowed to one of them.
        setAlbumFilter(item.name, item.artists.length === 1 ? item.artists[0]! : null);
        break;
      case 'track':
        play(item.id);
        break;
    }
    reset();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!showDropdown || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (item) choose(item);
    }
  };

  return (
    <div ref={containerRef} className="relative w-64 max-sm:min-w-0 max-sm:flex-1">
      <Input
        type="search"
        value={input}
        placeholder="Search…"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls={listboxId}
        aria-autocomplete="list"
        className="h-7 text-sm max-sm:h-10 max-sm:text-base"
        onChange={(e) => {
          setInput(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showDropdown && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-96 overflow-y-auto rounded-md border border-border bg-background shadow-lg max-sm:max-h-[60vh]"
        >
          {items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground max-sm:py-3 max-sm:text-base">
              {isFetching ? 'Searching…' : 'No results'}
            </p>
          ) : (
            <Groups items={items} active={active} onHover={setActive} onChoose={choose} />
          )}
        </div>
      )}
    </div>
  );
}

const GROUP_LABELS: Record<Item['kind'], string> = {
  artist: 'Artists',
  album: 'Albums',
  track: 'Tracks',
};

function Groups({
  items,
  active,
  onHover,
  onChoose,
}: {
  items: Item[];
  active: number;
  onHover: (index: number) => void;
  onChoose: (item: Item) => void;
}) {
  return (
    <>
      {items.map((item, index) => {
        const header = items[index - 1]?.kind !== item.kind ? GROUP_LABELS[item.kind] : null;
        return (
          <div key={`${item.kind}-${index}`}>
            {header && (
              <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                {header}
              </p>
            )}
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              // Keep focus on the input so blur doesn't close the dropdown before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onChoose(item)}
              className={cn(
                'flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm max-sm:py-2.5 max-sm:text-base',
                index === active && 'bg-accent/60',
              )}
            >
              <span className="truncate">{item.label}</span>
              {item.kind === 'track' && item.sublabel && (
                <span className="truncate text-xs text-muted-foreground">{item.sublabel}</span>
              )}
              {item.kind === 'album' && item.artists.length > 0 && (
                <span className="truncate text-xs text-muted-foreground">
                  {item.artists.join(', ')}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </>
  );
}
