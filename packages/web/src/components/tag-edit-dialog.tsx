import { useForm } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { graphql } from '../lib/gql.ts';
import { gqlRequest } from '../lib/gql-request.ts';
import { ArtistSynonymsEditor } from './artist-synonyms-editor.tsx';
import { Button } from './ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.tsx';
import { Input } from './ui/input.tsx';

const TrackUpdateDocument = graphql(`
  mutation TrackUpdate(
    $id: ID!
    $title: String
    $artist: String
    $albumArtist: String
    $album: String
    $trackNumber: Int
    $discNumber: Int
    $year: String
  ) {
    trackUpdate(
      id: $id
      title: $title
      artist: $artist
      albumArtist: $albumArtist
      album: $album
      trackNumber: $trackNumber
      discNumber: $discNumber
      year: $year
    ) {
      id
    }
  }
`);

export type EditableTrack = {
  id: string;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: string | null;
};

/** Fields editable for a single track. When several tracks are selected we restrict to those shared across an album. */
type Field = 'title' | 'artist' | 'albumArtist' | 'album' | 'trackNumber' | 'discNumber' | 'year';

const SINGLE_FIELDS: { key: Field; label: string; numeric?: boolean }[] = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'albumArtist', label: 'Album artist' },
  { key: 'album', label: 'Album' },
  { key: 'trackNumber', label: 'Track', numeric: true },
  { key: 'discNumber', label: 'CD', numeric: true },
  { key: 'year', label: 'Year' },
];
const MULTI_FIELDS: { key: Field; label: string; numeric?: boolean }[] = [
  { key: 'artist', label: 'Artist' },
  { key: 'albumArtist', label: 'Album artist' },
  { key: 'album', label: 'Album' },
  { key: 'discNumber', label: 'CD', numeric: true },
  { key: 'year', label: 'Year' },
];

/** The shared value across all selected tracks, or `''` when they disagree. */
function commonValue(tracks: EditableTrack[], key: Field): string {
  const first = tracks[0]?.[key];
  const allSame = tracks.every((t) => t[key] === first);
  return allSame && first != null ? String(first) : '';
}

export function TagEditDialog({
  tracks,
  open,
  onOpenChange,
}: {
  tracks: EditableTrack[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* The dialog only mounts its content while open, so the form below initialises fresh from the current selection on every open — no reset bookkeeping. */}
        <TagEditForm tracks={tracks} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function TagEditForm({
  tracks,
  onOpenChange,
}: {
  tracks: EditableTrack[];
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const multi = tracks.length > 1;
  const fields = multi ? MULTI_FIELDS : SINGLE_FIELDS;

  // Synonyms are keyed by artist, so only offer the editor when every selected
  // track shares one non-empty artist.
  const firstArtist = tracks[0]?.artist ?? null;
  const sharedArtist =
    firstArtist && tracks.every((t) => t.artist === firstArtist) ? firstArtist : null;

  const [error, setError] = useState<string | null>(null);

  const initial = {} as Record<Field, string>;
  for (const { key } of SINGLE_FIELDS) {
    initial[key] = multi ? commonValue(tracks, key) : (tracks[0]?.[key] ?? '').toString();
  }

  const form = useForm({
    defaultValues: initial,
    onSubmit: async ({ value, formApi }) => {
      setError(null);
      try {
        // Only fields the user touched are sent; an untouched field is omitted.
        // Clearing a text field stores an empty override that blanks the value;
        // numeric columns can't hold a blank, so a cleared number falls back to
        // the scanned tag.
        const changes: Record<string, string | number | null> = {};
        for (const { key, numeric } of fields) {
          const touched = formApi.getFieldMeta(key)?.isTouched ?? false;
          if (multi ? !touched : value[key] === initial[key]) continue;
          const raw = value[key]?.trim() ?? '';
          if (raw === '') {
            changes[key] = numeric ? null : '';
          } else if (numeric) {
            const n = Number.parseInt(raw, 10);
            if (Number.isNaN(n)) continue;
            changes[key] = n;
          } else {
            changes[key] = raw;
          }
        }

        if (Object.keys(changes).length > 0) {
          await Promise.all(
            tracks.map((t) => gqlRequest(TrackUpdateDocument, { id: t.id, ...changes })),
          );
          // A tag edit can touch anything that renders track data — the list windows
          // and counts, the letter index, search, the playing track's metadata —
          // so invalidate everything rather than maintain a key list that rots.
          // Edits are rare enough that the blanket refetch is cheap.
          await queryClient.invalidateQueries();
        }
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit tags</DialogTitle>
        <DialogDescription>
          {multi
            ? `Editing ${tracks.length} tracks. Blank fields are left unchanged.`
            : 'Clearing a field blanks it; numbers fall back to the tag read from the file.'}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        {fields.map(({ key, label, numeric }) => (
          <form.Field key={key} name={key}>
            {(field) => (
              <label className="grid grid-cols-[96px_1fr] items-center gap-3 text-sm">
                <span className="text-muted-foreground">{label}</span>
                <Input
                  value={field.state.value}
                  inputMode={numeric ? 'numeric' : undefined}
                  placeholder={
                    multi && commonValue(tracks, key) === '' && !field.state.meta.isTouched
                      ? '(multiple values)'
                      : undefined
                  }
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              </label>
            )}
          </form.Field>
        ))}
        {sharedArtist && <ArtistSynonymsEditor artist={sharedArtist} trackId={tracks[0]!.id} />}
        {error && <p className="text-sm text-destructive-foreground">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Saving…' : 'Save'}
              </Button>
            )}
          </form.Subscribe>
        </DialogFooter>
      </form>
    </>
  );
}
