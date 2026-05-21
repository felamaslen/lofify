import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseStream } from 'music-metadata';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { NewTrack } from '../db/schema/index.js';

export type ParsedTrack = Omit<NewTrack, 'id' | 'createdAt' | 'updatedAt' | 'scannedAt'>;

const tracer = trace.getTracer('lofify.scanner');

/** Read audio metadata and file stats for a single track, returning the columns the scanner will write to `Tracks`. */
export async function parseTrack(file: string): Promise<ParsedTrack> {
  return tracer.startActiveSpan('scanner.parseTrack', async (span) => {
    span.setAttribute('scanner.file', file);
    try {
      const [metadata, st] = await Promise.all([parseContent(file), stat(file)]);
      const { common, format } = metadata;

      const container =
        format.container?.toLowerCase() ?? path.extname(file).slice(1).toLowerCase();

      return {
        title: common.title ?? null,
        trackNumber: common.track?.no ?? null,
        discNumber: common.disk?.no ?? null,
        artist: common.artist ?? null,
        album: common.album ?? null,
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

async function parseContent(file: string) {
  const pass = new PassThrough();
  const [metadata] = await Promise.all([
    parseStream(pass),
    pipeline(createReadStream(file), pass),
  ]);
  return metadata;
}
