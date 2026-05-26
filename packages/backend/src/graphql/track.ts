import type { ID, Int } from 'grats';

import type { Track as DbTrack } from '../db/schema/index.js';
import { bakeFileExists, enqueueBake } from '../playback/bake.js';
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
  /** Source codec of the file on disk, lower-cased, e.g. `"flac"`, `"alac"`, `"mp3"`, `"opus"`. @gqlField */
  sourceFormat: string;
  /** Whether the source file is a lossless format (flac, alac, wav, etc.). @gqlField */
  isLossless: boolean;
  /** @gqlField */
  duration: Duration;
  /** Absolute path to the source file on disk. Internal — never exposed to clients. */
  file: string;
  /** mtime of the source file when last scanned. Internal — used by `url()` to derive the flac-cache filename. */
  sourceMtime: Date;
};

/**
 * Signed URL the client should `GET` to stream this track. The container format is selected at request time via the `Accept` header; the signed URL is independent of it, so a single URL can be replayed with different `Accept` values to switch formats without re-querying GraphQL.
 *
 * When the caller doesn't pin a `quality`, the resolver picks one based on the source: lossy or flac sources get a q-less URL (the client can still get flac passthrough by listing `audio/flac` in `Accept`); lossless non-flac sources with a warm flac cache also get a q-less URL; cold lossless non-flac sources get `q:M`, which pins playback to the lossy pipeline while a background bake warms the cache for the next play.
 *
 * @gqlField
 */
export async function url(
  track: Track,
  /** Coarse delivery quality. */
  quality?: Quality | null,
): Promise<string> {
  if (quality != null) {
    return signPlaybackUrl(track.id, {
      quality: quality.toLowerCase() as 'low' | 'medium' | 'high',
    });
  }
  const sourceIsFlac = track.format.toLowerCase() === 'flac';
  if (track.isLossless && !sourceIsFlac) {
    if (!(await bakeFileExists(track.id, track.sourceMtime))) {
      void enqueueBake(track.id, track.file, track.sourceMtime).catch(() => undefined);
      return signPlaybackUrl(track.id, { quality: 'max' });
    }
  }
  return signPlaybackUrl(track.id, { quality: null });
}

export function deriveFormat(format: string, codec: string): string {
  const f = format.toLowerCase();
  const c = codec.toLowerCase();
  if (f === c) return f;
  if (c.includes(f) || f.includes(c)) return c.length >= f.length ? c : f;
  return `${f} ${c}`;
}

/** Collapse the verbose `music-metadata` codec string (e.g. `"mpeg 1 layer 3"`) into a short, human-friendly abbreviation suitable for display (e.g. `"mp3"`). Falls back to the raw input when no rule matches. */
export function abbreviateCodec(raw: string): string {
  const c = raw.toLowerCase().trim();
  if (!c) return c;
  if (/\bmpeg\b.*\blayer\s*3\b/.test(c) || c === 'mp3') return 'mp3';
  if (/\bmpeg\b.*\blayer\s*2\b/.test(c) || c === 'mp2') return 'mp2';
  if (c === 'flac') return 'flac';
  if (c === 'alac' || c.includes('apple lossless')) return 'alac';
  if (c === 'opus') return 'opus';
  if (c.includes('vorbis')) return 'vorbis';
  if (c.includes('aac')) return 'aac';
  if (c.includes('windows media') || c === 'wma') return 'wma';
  if (c.includes("monkey's audio") || c === 'ape') return 'ape';
  if (c.includes('wavpack') || c === 'wv') return 'wv';
  if (c.includes('musepack') || c === 'mpc') return 'mpc';
  if (c === 'tta' || c.includes('true audio')) return 'tta';
  if (c.startsWith('pcm')) return 'pcm';
  if (c.includes('dsd')) return 'dsd';
  return c;
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
    sourceFormat: abbreviateCodec(row.codec),
    isLossless: row.isLossless,
    duration: new Duration(row.durationSeconds),
    file: row.file,
    sourceMtime: row.sourceMtime,
  };
}
