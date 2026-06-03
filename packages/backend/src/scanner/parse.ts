import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { fileTypeFromFile } from 'file-type';
import { parseFile } from 'music-metadata';

import type { NewTrack } from '../db/schema/index.js';
import { AUDIO_EXTENSIONS } from './audio-extensions.js';

export type ParsedTrack = Omit<NewTrack, 'id' | 'createdAt' | 'updatedAt' | 'scannedAt'>;

const tracer = trace.getTracer('lofify.scanner');
const AUDIO_EXT_SET = new Set<string>(AUDIO_EXTENSIONS);

/** Strip NUL bytes (which Postgres text columns reject) and surrounding whitespace from a tag value, collapsing empties to null. Some FLAC tags in the wild include trailing U+0000 padding. */
function cleanTag(value: string | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.replaceAll('\u0000', '').trim();
  return cleaned === '' ? null : cleaned;
}

/** Sniff `file`'s magic bytes via `file-type` and throw when the detected container isn't one we accept. Gating against `AUDIO_EXTENSIONS` keeps us from upserting a non-audio file just because its extension matched the walker's glob. */
async function assertAudioHeader(file: string): Promise<void> {
  const type = await fileTypeFromFile(file);
  if (!type || !AUDIO_EXT_SET.has(type.ext)) {
    throw new Error(`unrecognised audio header for ${path.basename(file)}`);
  }
}

/** Monkey's Audio switched to a descriptor-prefixed header at version 3.98 (`nVersion` 3980). Files below that use the legacy fixed header, which `music-metadata` cannot read — it assumes the descriptor and returns garbage format values. */
const APE_DESCRIPTOR_VERSION = 3980;

/** Decode the format of a legacy (pre-3.98) Monkey's Audio file straight from its fixed header, returning `null` for non-APE files or descriptor-era APE files that `music-metadata` handles correctly. Tags are not read: legacy `.ape` files rarely carry an APEv2 footer, and the affected files in practice have none. */
async function parseLegacyApeFormat(
  file: string,
): Promise<Pick<ParsedTrack, 'sampleRate' | 'durationSeconds'> | null> {
  const fh = await open(file);
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await fh.read(header, 0, 32, 0);
    if (bytesRead < 32 || header.toString('ascii', 0, 4) !== 'MAC ') return null;
    const version = header.readUInt16LE(4);
    if (version >= APE_DESCRIPTOR_VERSION) return null;

    const compressionLevel = header.readUInt16LE(6);
    const sampleRate = header.readUInt32LE(12);
    const totalFrames = header.readUInt32LE(24);
    const finalFrameBlocks = header.readUInt32LE(28);

    const blocksPerFrame =
      version >= 3950
        ? 73728 * 4
        : version >= 3900 || (version >= 3800 && compressionLevel >= 4000)
          ? 73728
          : 9216;
    const totalBlocks = totalFrames > 0 ? (totalFrames - 1) * blocksPerFrame + finalFrameBlocks : 0;

    return {
      sampleRate,
      durationSeconds: sampleRate > 0 ? Math.round(totalBlocks / sampleRate) : 0,
    };
  } finally {
    await fh.close();
  }
}

/** Re-read just the album-artist tag from a file on disk. Backfills rows scanned before the `albumArtist` column existed without waiting for a forced rescan. */
export async function readAlbumArtistTag(file: string): Promise<string | null> {
  const metadata = await parseFile(file, { skipCovers: true });
  return cleanTag(metadata.common.albumartist);
}

/** Read audio metadata and file stats for a single track, returning the columns the scanner will write to `Tracks`. */
export async function parseTrack(file: string): Promise<ParsedTrack> {
  return tracer.startActiveSpan('scanner.parseTrack', async (span) => {
    span.setAttribute('scanner.file', file);
    try {
      await assertAudioHeader(file);

      if (path.extname(file).slice(1).toLowerCase() === 'ape') {
        const legacy = await parseLegacyApeFormat(file);
        if (legacy) {
          const st = await stat(file);
          return {
            title: null,
            trackNumber: null,
            discNumber: null,
            artist: null,
            albumArtist: null,
            album: null,
            year: null,
            format: 'ape',
            codec: 'ape',
            bitRate:
              legacy.durationSeconds > 0
                ? Math.round((st.size * 8) / legacy.durationSeconds)
                : null,
            sampleRate: legacy.sampleRate,
            isLossless: true,
            file,
            sizeBytes: st.size,
            durationSeconds: legacy.durationSeconds,
            sourceMtime: st.mtime,
          };
        }
      }

      const [metadata, st] = await Promise.all([
        parseFile(file, { skipCovers: true, duration: true }),
        stat(file),
      ]);
      const { common, format } = metadata;

      const container =
        format.container?.toLowerCase() ?? path.extname(file).slice(1).toLowerCase();

      return {
        title: cleanTag(common.title),
        trackNumber: common.track?.no ?? null,
        discNumber: common.disk?.no ?? null,
        artist: cleanTag(common.artist),
        albumArtist: cleanTag(common.albumartist),
        album: cleanTag(common.album),
        year: common.year != null ? String(common.year) : null,
        format: container,
        codec: format.codec?.toLowerCase() ?? container,
        codecProfile: cleanTag(format.codecProfile),
        bitRate: typeof format.bitrate === 'number' ? Math.round(format.bitrate) : null,
        sampleRate: format.sampleRate ?? 0,
        bitDepth: format.bitsPerSample ?? null,
        channels: format.numberOfChannels ?? null,
        isLossless: format.lossless ?? false,
        file,
        sizeBytes: st.size,
        durationSeconds: Math.round(format.duration ?? 0),
        sourceMtime: st.mtime,
      };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
