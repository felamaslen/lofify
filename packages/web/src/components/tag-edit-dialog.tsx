import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

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
    $album: String
    $trackNumber: Int
    $discNumber: Int
    $year: String
  ) {
    trackUpdate(
      id: $id
      title: $title
      artist: $artist
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
  album: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: string | null;
};

/** Fields editable for a single track. When several tracks are selected we restrict to those shared across an album. */
type Field = 'title' | 'artist' | 'album' | 'trackNumber' | 'discNumber' | 'year';

const SINGLE_FIELDS: { key: Field; label: string; numeric?: boolean }[] = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'trackNumber', label: 'Track', numeric: true },
  { key: 'discNumber', label: 'CD', numeric: true },
  { key: 'year', label: 'Year' },
];
const MULTI_FIELDS: { key: Field; label: string; numeric?: boolean }[] = [
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'discNumber', label: 'CD', numeric: true },
  { key: 'year', label: 'Year' },
];

/** The shared value across all selected tracks, or `null` when they disagree. */
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
  const queryClient = useQueryClient();
  const multi = tracks.length > 1;
  const fields = multi ? MULTI_FIELDS : SINGLE_FIELDS;

  // Synonyms are keyed by artist, so only offer the editor when every selected
  // track shares one non-empty artist.
  const firstArtist = tracks[0]?.artist ?? null;
  const sharedArtist =
    firstArtist && tracks.every((t) => t.artist === firstArtist) ? firstArtist : null;

  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Set<Field>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const { key } of fields) {
      out[key] = multi ? commonValue(tracks, key) : (tracks[0]?.[key] ?? '').toString();
    }
    return out;
  }, [fields, multi, tracks]);

  useEffect(() => {
    if (open) {
      setValues(initial);
      setTouched(new Set());
      setError(null);
    }
  }, [open, initial]);

  const mixed = (key: Field) => multi && commonValue(tracks, key) === '' && !touched.has(key);

  const setField = (key: Field, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setTouched((t) => new Set(t).add(key));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Only fields the user touched are sent; an untouched field is omitted.
      // Clearing a text field stores an empty override that blanks the value;
      // numeric columns can't hold a blank, so a cleared number falls back to
      // the scanned tag.
      const changes: Record<string, string | number | null> = {};
      for (const { key, numeric } of fields) {
        if (multi ? !touched.has(key) : values[key] === initial[key]) continue;
        const raw = values[key]?.trim() ?? '';
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
        // The list reads from these keys; editing artist/album can also shift the
        // counts and the letter index, so refresh all three.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['tracks-window'] }),
          queryClient.invalidateQueries({ queryKey: ['tracks-count'] }),
          queryClient.invalidateQueries({ queryKey: ['artist-index'] }),
        ]);
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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
            void save();
          }}
        >
          {fields.map(({ key, label, numeric }) => (
            <label key={key} className="grid grid-cols-[80px_1fr] items-center gap-3 text-sm">
              <span className="text-muted-foreground">{label}</span>
              <Input
                value={values[key] ?? ''}
                inputMode={numeric ? 'numeric' : undefined}
                placeholder={mixed(key) ? '(multiple values)' : undefined}
                onChange={(e) => setField(key, e.target.value)}
              />
            </label>
          ))}
          {sharedArtist && <ArtistSynonymsEditor artist={sharedArtist} trackId={tracks[0]!.id} />}
          {error && <p className="text-sm text-destructive-foreground">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
