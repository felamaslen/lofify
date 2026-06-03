import { Info } from 'lucide-react';

import { type FragmentOf, graphql, readFragment } from '../lib/gql.ts';
import { cn } from '../lib/utils.ts';
import { ArtworkTile, useTrackArtwork } from './track-artwork.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx';

export const TrackInfoDocument = graphql(`
  fragment TrackInfo on Track {
    id
    format
    sourceFormat
    codecProfile
    isLossless
    bitrateKbps
    sampleRate
    bitDepth
    channels
    scannedAt
    updatedAt
    duplicates {
      sourceFormat
      bitrateKbps
      isLossless
    }
  }
`);

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
}

/** Cover preview at the top of the popover. Fetched on open rather than carried by the list fragment, so the artwork resolver isn't fanned out to every visible row; the query key is shared with the playback bar's. */
function PopoverArtwork({ trackId }: { trackId: string }) {
  const { artwork, loading, download, downloadError } = useTrackArtwork(trackId, undefined, {
    fetchOnMount: true,
  });
  return (
    <ArtworkTile
      artwork={artwork}
      loading={loading}
      download={download}
      downloadError={downloadError}
      className="aspect-square w-full"
      iconClassName="size-6"
    />
  );
}

/** A source's codec plus its quality detail, e.g. "FLAC · 44.1 kHz · 16-bit" or "MP3 · 192 kbps · CBR". */
function sourceLabel(s: {
  sourceFormat: string;
  codecProfile?: string | null;
  bitrateKbps: number | null;
  sampleRate?: number;
  bitDepth?: number | null;
  channels?: number | null;
}): string {
  const parts: string[] = [s.sourceFormat.toUpperCase()];
  if (s.bitrateKbps != null) parts.push(`${s.bitrateKbps} kbps`);
  if (s.codecProfile) parts.push(s.codecProfile);
  if (s.sampleRate) parts.push(`${s.sampleRate / 1000} kHz`);
  if (s.bitDepth != null) parts.push(`${s.bitDepth}-bit`);
  if (s.channels != null) parts.push(`${s.channels} ch`);
  return parts.join(' · ');
}

export function TrackInfoButton({ track }: { track: FragmentOf<typeof TrackInfoDocument> }) {
  const t = readFragment(TrackInfoDocument, track);
  // The row owns click/double-click (select/play); keep them from firing when interacting with the info control.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Track info"
          onClick={stop}
          onMouseDown={stop}
          onDoubleClick={stop}
          className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" onClick={stop} onDoubleClick={stop} className="text-xs">
        <div className="grid gap-2">
          <PopoverArtwork trackId={t.id} />
          <div className="flex items-center gap-2">
            <span className="font-medium uppercase tracking-wide">{t.format}</span>
            <span
              className={cn(
                'rounded-sm px-1 py-0.5 text-[10px] uppercase',
                t.isLossless ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              {t.isLossless ? 'Lossless' : 'Lossy'}
            </span>
          </div>
          <div className="text-muted-foreground">{sourceLabel(t)}</div>

          {t.duplicates.length > 0 && (
            <div className="grid gap-1 border-t border-border pt-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                Duplicate sources
              </span>
              {t.duplicates.map((d, i) => (
                <span key={`${d.sourceFormat}-${i}`} className="text-muted-foreground">
                  {sourceLabel(d)}
                </span>
              ))}
            </div>
          )}

          <div className="grid gap-0.5 border-t border-border pt-2 text-muted-foreground/80">
            <span>Scanned {formatDate(t.scannedAt)}</span>
            {t.updatedAt && <span>Updated {formatDate(t.updatedAt)}</span>}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
