import type { ID, Int } from 'grats';

import type { Track as DbTrack } from '../db/schema/index.js';
import { signPlaybackUrl } from '../playback/sign.js';
import { Duration } from './duration.js';

/**
 * Coarse delivery quality the client requests for an encoded stream. `MAX` is server-internal — clients ask for it implicitly by including `audio/flac` in their `Accept` header, not via this enum.
 *
 * @gqlEnum
 */
export type Quality = 'LOW' | 'MEDIUM' | 'HIGH';

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
 * Signed URL the client should `GET` to stream this track. The container format is selected at request time via the `Accept` header; the signed URL is independent of it, so a single URL can be replayed with different `Accept` values to switch formats without re-querying GraphQL.
 *
 * @gqlField
 */
export function url(
  track: Track,
  /** Coarse delivery quality. */
  quality?: Quality | null,
): string {
  return signPlaybackUrl(track.id, {
    quality:
      quality == null
        ? null
        : (quality.toLowerCase() as 'low' | 'medium' | 'high'),
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
