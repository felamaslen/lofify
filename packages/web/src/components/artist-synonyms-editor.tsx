import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';

import { graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

const ArtistSynonymsDocument = graphql(`
  query ArtistSynonyms($id: ID!) {
    track(id: $id) {
      artistSynonyms
    }
  }
`);

const SynonymCreateDocument = graphql(`
  mutation SynonymCreate($artist: String!, $synonym: String!) {
    artistSynonymCreate(artist: $artist, synonym: $synonym) {
      synonym
    }
  }
`);

const SynonymUpdateDocument = graphql(`
  mutation SynonymUpdate($artist: String!, $synonym: String!, $newSynonym: String!) {
    artistSynonymUpdate(artist: $artist, synonym: $synonym, newSynonym: $newSynonym) {
      synonym
    }
  }
`);

const SynonymDeleteDocument = graphql(`
  mutation SynonymDelete($artist: String!, $synonym: String!) {
    artistSynonymDelete(artist: $artist, synonym: $synonym) {
      _
    }
  }
`);

/** Add/rename/remove the alternative names search should resolve to `artist`. Mutations apply immediately (independently of the tag form's Save) and refetch the list. `trackId` is any track by this artist — `Track.artistSynonyms` is the read path. */
export function ArtistSynonymsEditor({ artist, trackId }: { artist: string; trackId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['artistSynonyms', artist],
    queryFn: ({ signal }) => gqlRequest(ArtistSynonymsDocument, { id: trackId }, signal),
  });
  const synonyms = data?.track?.artistSynonyms ?? [];

  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['artistSynonyms', artist] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const add = () => {
    const synonym = adding.trim();
    if (!synonym) return;
    void run(async () => {
      await gqlRequest(SynonymCreateDocument, { artist, synonym });
      setAdding('');
    });
  };

  const rename = (synonym: string, next: string) => {
    const newSynonym = next.trim();
    if (!newSynonym || newSynonym === synonym) return;
    void run(() => gqlRequest(SynonymUpdateDocument, { artist, synonym, newSynonym }));
  };

  const remove = (synonym: string) => {
    void run(() => gqlRequest(SynonymDeleteDocument, { artist, synonym }));
  };

  const onAddKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLInputElement>, synonym: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.currentTarget.value = synonym;
      e.currentTarget.blur();
    }
  };

  return (
    <div className="grid gap-2 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">
        Synonyms for <span className="text-foreground">{artist}</span> — alternative names that
        surface this artist in search.
      </p>
      <div className="grid gap-1">
        {synonyms.map((synonym) => (
          <div key={synonym} className="flex items-center gap-2">
            <Input
              defaultValue={synonym}
              className="h-8"
              onKeyDown={(e) => onRowKeyDown(e, synonym)}
              onBlur={(e) => rename(synonym, e.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              title="Remove synonym"
              onClick={() => remove(synonym)}
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={adding}
          placeholder="Add a synonym…"
          className="h-8"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={onAddKeyDown}
        />
        <Button type="button" variant="secondary" className="h-8 shrink-0" onClick={add}>
          Add
        </Button>
      </div>
      {error && <p className="text-sm text-destructive-foreground">{error}</p>}
    </div>
  );
}
