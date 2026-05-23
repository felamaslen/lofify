import { stat } from 'node:fs/promises';
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

/** Read audio metadata and file stats for a single track, returning the columns the scanner will write to `Tracks`. */
export async function parseTrack(file: string): Promise<ParsedTrack> {
  return tracer.startActiveSpan('scanner.parseTrack', async (span) => {
    span.setAttribute('scanner.file', file);
    try {
      await assertAudioHeader(file);
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
        album: cleanTag(common.album),
        year: common.year != null ? String(common.year) : null,
        format: container,
        codec: format.codec?.toLowerCase() ?? container,
        bitRate: typeof format.bitrate === 'number' ? Math.round(format.bitrate) : null,
        sampleRate: format.sampleRate ?? 0,
        isLossless: format.lossless ?? false,
        file,
        sizeBytes: st.size,
        durationSeconds: Math.round(format.duration ?? 0),
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
