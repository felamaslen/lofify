import type { ID, Int } from 'grats';

import type { Track as DbTrack } from '../db/schema/index.js';
import { contentTypeFor, deliveryDescription, resolveTarget } from '../playback/resolve.js';
import { signPlaybackUrl } from '../playback/sign.js';
import { abbreviateCodec, deriveFormat } from './codec.js';
import { Duration } from './duration.js';
import { Quality, type TrackFormat } from './playback-format.js';

export { abbreviateCodec, deriveFormat } from './codec.js';
export { Quality, type TrackFormat };

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
  /** Source codec of the file on disk, lower-cased, e.g. `"flac"`, `"alac"`, `"mp3"`, `"opus"`. @gqlField */
  sourceFormat: string;
  /** Whether the source file is a lossless format (flac, alac, wav, etc.). @gqlField */
  isLossless: boolean;
  /** @gqlField */
  duration: Duration;
  /** Absolute path to the source file on disk. Internal — never exposed to clients. */
  file: string;
  /** mtime of the source file when last scanned. Internal — used by `url()` to derive the cache key. */
  sourceMtime: Date;
};

const DEFAULT_FORMAT: TrackFormat = {
  quality: Quality.MAX,
  losslessFormats: ['audio/mp4; codecs="flac"'],
  lossyFormats: ['audio/mp4; codecs="opus"'],
};

/**
 * Signed URL the client should `GET` (with `Range:` headers) to stream this track. The resolver picks the concrete container + codec from `format` (see `TrackFormat`) and bakes it into the URL, so a single URL is reusable for the lifetime of a playback session and the stateless `/play` route needs no capability data.
 *
 * Defaults to a MAX request supporting only flac-in-mp4 and opus-in-mp4 — the universally safe baseline.
 *
 * @gqlField
 */
export function url(track: Track, format?: TrackFormat | null): string {
  const target = resolveTarget(
    { isLossless: track.isLossless, sourceCodec: track.sourceFormat },
    format ?? DEFAULT_FORMAT,
  );
  return signPlaybackUrl(track.id, target);
}

/**
 * How a track will be delivered for a requested `format`: the URL to fetch, the MIME type the bytes carry, whether it's a copy or a transcode, and a short description for the format tooltip. Resolves the same way `url` does, so a client can read everything it needs from one field.
 *
 * @gqlType
 */
export type TrackDelivery = {
  /** Signed URL the client should `GET` (with `Range:` headers) to stream this track. @gqlField */
  url: string;
  /** MIME type the bytes are served as — the value to pass to `MediaSource.addSourceBuffer`. @gqlField */
  mimeType: string;
  /** Whether the source is delivered without re-encoding (a container-only copy). @gqlField */
  isPassthrough: boolean;
  /** Short human-readable summary of the delivery, e.g. "Original Vorbis, copied without re-encoding" or "Transcoded to Opus at 256 kbps". @gqlField */
  description: string;
};

/**
 * Delivery plan for this track at the given `format`. See `TrackDelivery`. Defaults to the same baseline as `url`.
 *
 * @gqlField */
export function delivery(track: Track, format?: TrackFormat | null): TrackDelivery {
  const target = resolveTarget(
    { isLossless: track.isLossless, sourceCodec: track.sourceFormat },
    format ?? DEFAULT_FORMAT,
  );
  const isPassthrough = target.format.codec === track.sourceFormat;
  return {
    url: signPlaybackUrl(track.id, target),
    mimeType: contentTypeFor(target),
    isPassthrough,
    description: deliveryDescription(target, isPassthrough),
  };
}

/**
 * Absolute path to the source file on disk. Primarily a fallback label for tracks that carry no title tag.
 *
 * @gqlField
 */
export function path(track: Track): string {
  return track.file;
}

export function toGqlTrack(row: DbTrack): Track {
  return {
    id: row.id,
    title: row.titleOverride ?? row.title,
    trackNumber: row.trackNumberOverride ?? row.trackNumber,
    discNumber: row.discNumberOverride ?? row.discNumber,
    artist: row.artistOverride ?? row.artist,
    album: row.albumOverride ?? row.album,
    year: row.yearOverride ?? row.year,
    format: deriveFormat(row.format, row.codec),
    sourceFormat: abbreviateCodec(row.codec),
    isLossless: row.isLossless,
    duration: new Duration(row.durationSeconds),
    file: row.file,
    sourceMtime: row.sourceMtime,
  };
}
