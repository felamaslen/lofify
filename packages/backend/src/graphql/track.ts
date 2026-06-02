import { and, asc, eq, ne } from 'drizzle-orm';
import type { ID, Int } from 'grats';

import { db } from '../db/client.js';
import { type Track as DbTrack, tracks as tracksTable } from '../db/schema/index.js';
import {
  contentTypeFor,
  deliveryDescription,
  isMultiLossy,
  isPassthrough,
  resolveTarget,
  tierBitratesKbps,
} from '../playback/resolve.js';
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
  /** Codec quality option of the source, e.g. `"CBR"`/`"VBR"` for MP3 or `"LC"`/`"HE-AAC"` for AAC. Null when the codec reports none. @gqlField */
  codecProfile: string | null;
  /** Whether the source file is a lossless format (flac, alac, wav, etc.). @gqlField */
  isLossless: boolean;
  /** Nominal source bitrate in kbps, or null for variable-bitrate sources that report none. @gqlField */
  bitrateKbps: Int | null;
  /** Source sample rate in Hz. @gqlField */
  sampleRate: Int;
  /** Source bit depth in bits per sample, or null for lossy sources that have none. @gqlField */
  bitDepth: Int | null;
  /** Source channel count (e.g. 2 for stereo), or null when unknown. @gqlField */
  channels: Int | null;
  /** When the scanner last read this file from disk, ISO-8601. @gqlField */
  scannedAt: string;
  /** When this track was last modified, ISO-8601, or null when that falls on the same date as `scannedAt` (i.e. it has not changed since the scan). @gqlField */
  updatedAt: string | null;
  /** @gqlField */
  duration: Duration;
  /** Absolute path to the source file on disk. Internal — never exposed to clients. */
  file: string;
  /** mtime of the source file when last scanned. Internal — used by `url()` to derive the cache key. */
  sourceMtime: Date;
  /** Id of the canonical track of this row's duplicate group, or null when it has no duplicate. Internal — resolves `duplicates`. */
  dedupGroupId: string | null;
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
  /** Whether a lossy source is being re-encoded to a lossy output, stacking a second generation of compression loss. False for lossless sources, lossless output, or a verbatim copy. @gqlField */
  isMultiLossy: boolean;
  /** Short human-readable summary of the delivery, e.g. "Original Vorbis, copied without re-encoding" or "Transcoded to Opus at 256 kbps". @gqlField */
  description: string;
  /** Expected bitrate of each adaptive quality tier (MIN–HIGH) for this track, given the lossy codec the ladder transcodes to, so the client can size each tier against measured bandwidth and jump straight to the highest it can sustain. @gqlField */
  tiers: DeliveryTier[];
};

/**
 * The expected bitrate of one adaptive quality tier for a track.
 *
 * @gqlType
 */
export type DeliveryTier = {
  /** @gqlField */
  quality: Quality;
  /** Nominal transcode bitrate in kbps. @gqlField */
  bitrateKbps: Int;
};

/**
 * Delivery plan for this track at the given `format`. See `TrackDelivery`. Defaults to the same baseline as `url`.
 *
 * @gqlField */
export function delivery(track: Track, format?: TrackFormat | null): TrackDelivery {
  const source = { isLossless: track.isLossless, sourceCodec: track.sourceFormat };
  const target = resolveTarget(source, format ?? DEFAULT_FORMAT);
  const passthrough = isPassthrough(target, track.sourceFormat);
  return {
    url: signPlaybackUrl(track.id, target),
    mimeType: contentTypeFor(target),
    isPassthrough: passthrough,
    isMultiLossy: isMultiLossy(source, target, passthrough),
    description: deliveryDescription(target, passthrough),
    tiers: tierBitratesKbps(format ?? DEFAULT_FORMAT),
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

/**
 * Other copies of this recording in the library — tracks sharing the same effective title, artist and album — best-quality first. Empty when this track has no duplicate.
 *
 * @gqlField
 */
export async function duplicates(track: Track): Promise<Track[]> {
  if (track.dedupGroupId == null) return [];
  const rows = await db
    .select()
    .from(tracksTable)
    .where(
      and(eq(tracksTable.trackIdDeduplicated, track.dedupGroupId), ne(tracksTable.id, track.id)),
    )
    .orderBy(asc(tracksTable.priority));
  return rows.map(toGqlTrack);
}

/** Whether two timestamps fall on the same calendar date (UTC). */
function sameDate(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/** Resolve a text override against its scanned tag: an empty-string override means the user explicitly blanked the field (effective value `null`), a null override falls back to the scanned tag. */
function applyOverride(override: string | null, scanned: string | null): string | null {
  if (override === '') return null;
  return override ?? scanned;
}

export function toGqlTrack(row: DbTrack): Track {
  return {
    id: row.id,
    title: applyOverride(row.titleOverride, row.title),
    trackNumber: row.trackNumberOverride ?? row.trackNumber,
    discNumber: row.discNumberOverride ?? row.discNumber,
    artist: applyOverride(row.artistOverride, row.artist),
    album: applyOverride(row.albumOverride, row.album),
    year: applyOverride(row.yearOverride, row.year),
    format: deriveFormat(row.format, row.codec),
    sourceFormat: abbreviateCodec(row.codec),
    codecProfile: row.codecProfile,
    isLossless: row.isLossless,
    bitrateKbps: row.bitRate != null ? Math.round(row.bitRate / 1000) : null,
    sampleRate: row.sampleRate,
    bitDepth: row.bitDepth,
    channels: row.channels,
    scannedAt: row.scannedAt.toISOString(),
    updatedAt: sameDate(row.updatedAt, row.scannedAt) ? null : row.updatedAt.toISOString(),
    duration: new Duration(row.durationSeconds),
    file: row.file,
    sourceMtime: row.sourceMtime,
    dedupGroupId: row.trackIdDeduplicated,
  };
}
