import type { ID, Int } from 'grats';
import type { Track as DbTrack } from '../db/schema/index.js';
import { signPlaybackUrl } from '../playback/sign.js';
import { Duration } from './duration.js';

/**
 * Container/codec to deliver. `ORIGINAL` streams the source file untouched; `AUTO_HI` and `AUTO_LO` let the server pick a sensible high- or low-bandwidth target; the remaining members pin a specific format.
 *
 * @gqlEnum
 */
export type Format = 'ORIGINAL' | 'AUTO_HI' | 'AUTO_LO' | 'AAC' | 'OGG' | 'WEBM' | 'FLAC';

/**
 * A single audio file in the library.
 *
 * @gqlType
 */
export type Track = {
  /** @gqlField */
  id: ID;
  /** @gqlField */
  title: string | null;
  /** @gqlField */
  trackNumber: Int | null;
  /** @gqlField */
  discNumber: Int | null;
  /** @gqlField */
  artist: string | null;
  /** @gqlField */
  album: string | null;
  /** @gqlField */
  year: string | null;
  /** Container plus codec, lower-cased and space-separated, e.g. `"ogg vorbis"`, `"mp3"`, `"webm opus"`. @gqlField */
  format: string;
  /** @gqlField */
  duration: Duration;
};

/**
 * Signed URL the client should `GET` to stream this track. Re-call with different `quality`/`format` values to switch transcode targets.
 *
 * @gqlField
 */
export function url(
  track: Track,
  /**
   * Target playback quality on an opaque 0–10 scale where higher is better.
   *
   * @gqlAnnotate constraint(min: 0, max: 10)
   */
  quality?: Int | null,
  /** Target container/codec. Defaults to `ORIGINAL` when omitted. */
  format?: Format | null,
): string {
  return signPlaybackUrl(track.id, {
    quality: quality ?? null,
    format: format ?? null,
  });
}

export function deriveFormat(format: string, codec: string): string {
  const f = format.toLowerCase();
  const c = codec.toLowerCase();
  if (f === c) return f;
  if (c.includes(f) || f.includes(c)) return c.length >= f.length ? c : f;
  return `${f} ${c}`;
}

export function toGqlTrack(row: DbTrack): Track {
  return {
    id: row.id,
    title: row.title,
    trackNumber: row.trackNumber,
    discNumber: row.discNumber,
    artist: row.artist,
    album: row.album,
    year: row.year,
    format: deriveFormat(row.format, row.codec),
    duration: new Duration(row.durationSeconds),
  };
}

