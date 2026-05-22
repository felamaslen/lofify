import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import parseRange from 'range-parser';

import { db } from '../db/client.js';
import type { Track as DbTrack } from '../db/schema/index.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { type ParsedOptions, parseOptionSegments, type RequestedFormat } from './options.js';
import { verifySignature } from './sign.js';
import {
  getOrStartTranscodeJob,
  jobCacheKey,
  readChunkFile,
  SEGMENT_DURATION_SECONDS,
  type TranscodeJob,
  type TranscodeTarget,
  waitForChunks,
} from './transcode.js';

export function contentTypeFor(format: string, codec: string): string {
  const f = format.toLowerCase();
  const c = codec.toLowerCase();
  switch (f) {
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'aac':
    case 'adts':
      return 'audio/aac';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'ogg':
      return c ? `audio/ogg; codecs=${c}` : 'audio/ogg';
    case 'webm':
      return c ? `audio/webm; codecs=${c}` : 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

export type ResolvedTarget =
  | { kind: 'passthrough' }
  | { kind: 'transcode'; target: TranscodeTarget };

export function resolveTarget(track: DbTrack, opts: ParsedOptions): ResolvedTarget {
  const sourceFormat = track.format.toLowerCase();
  const sourceCodec = track.codec.toLowerCase();
  const requested: RequestedFormat = opts.format ?? 'original';

  let target: TranscodeTarget;
  switch (requested) {
    case 'original':
      if (opts.quality == null) return { kind: 'passthrough' };
      target = {
        format:
          sourceFormat === 'flac'
            ? 'flac'
            : sourceFormat === 'webm'
              ? 'webm'
              : sourceFormat === 'aac'
                ? 'aac'
                : 'ogg',
        codec: sourceCodec,
        quality: opts.quality,
      };
      break;
    case 'auto_hi':
      if (!track.isLossless) {
        target = { format: 'webm', codec: 'opus', quality: opts.quality };
        break;
      }
      if (sourceFormat === 'flac' && opts.quality == null) return { kind: 'passthrough' };
      target = { format: 'flac', codec: 'flac', quality: opts.quality };
      break;
    case 'auto_lo':
      if (sourceFormat === 'webm' && sourceCodec === 'opus' && opts.quality == null) {
        return { kind: 'passthrough' };
      }
      target = { format: 'webm', codec: 'opus', quality: opts.quality };
      break;
    case 'flac':
      if (sourceFormat === 'flac' && opts.quality == null) return { kind: 'passthrough' };
      target = { format: 'flac', codec: 'flac', quality: opts.quality };
      break;
    case 'ogg':
      if (sourceFormat === 'ogg' && opts.quality == null) return { kind: 'passthrough' };
      target = { format: 'ogg', codec: 'vorbis', quality: opts.quality };
      break;
    case 'webm':
      if (sourceFormat === 'webm' && opts.quality == null) return { kind: 'passthrough' };
      target = { format: 'webm', codec: 'opus', quality: opts.quality };
      break;
    case 'aac':
      if ((sourceFormat === 'aac' || sourceFormat === 'm4a') && opts.quality == null) {
        return { kind: 'passthrough' };
      }
      target = { format: 'aac', codec: 'aac', quality: opts.quality };
      break;
  }
  return { kind: 'transcode', target };
}

function parseRangeHeader(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const ranges = parseRange(size, header, { combine: true });
  if (!Array.isArray(ranges) || ranges.type !== 'bytes' || ranges.length === 0) return null;
  const { start, end } = ranges[0]!;
  return { start, end };
}

async function sendPassthrough(
  req: FastifyRequest,
  reply: FastifyReply,
  track: DbTrack,
): Promise<void> {
  const st = await stat(track.file);
  const total = st.size;
  const contentType = contentTypeFor(track.format, track.codec);

  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', contentType);

  if (req.method === 'HEAD') {
    reply.code(200);
    reply.header('Content-Length', String(total));
    return reply.send();
  }

  const range = parseRangeHeader(req.headers.range, total);

  if (range) {
    const length = range.end - range.start + 1;
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
    reply.header('Content-Length', String(length));
    return reply.send(createReadStream(track.file, { start: range.start, end: range.end }));
  }
  reply.code(200);
  reply.header('Content-Length', String(total));
  return reply.send(createReadStream(track.file));
}

function parseSegIndex(value: string | null): number | null {
  if (value == null) return 0;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function chunkFileName(segIndex: number): string {
  // ffmpeg's DASH muxer numbers media segments from 1 with %05d padding (see `-media_seg_name chunk-$Number%05d$.webm` in ffmpeg.ts).
  return `chunk-${String(segIndex + 1).padStart(5, '0')}.webm`;
}

async function sendTranscodeChunk(
  req: FastifyRequest,
  reply: FastifyReply,
  track: DbTrack,
  target: TranscodeTarget,
  segRaw: string | null,
): Promise<void> {
  const segCount = Math.max(1, Math.ceil(track.durationSeconds / SEGMENT_DURATION_SECONDS));
  const contentType = contentTypeFor(target.format, target.codec);

  const setMetaHeaders = (job: TranscodeJob | null): void => {
    reply.header('Content-Type', contentType);
    reply.header('X-Lofify-Segments', String(segCount));
    reply.header('X-Lofify-Segment-Duration', String(SEGMENT_DURATION_SECONDS));
    reply.header('X-Lofify-Duration', String(track.durationSeconds));
    reply.header('X-Lofify-Ready-Chunks', String(job?.readyChunks ?? 0));
    // Cross-origin XHR/fetch can only read these via `Response.headers.get()` if they're listed here. `@fastify/cors` doesn't add them by default.
    reply.header(
      'Access-Control-Expose-Headers',
      'X-Lofify-Segments, X-Lofify-Segment-Duration, X-Lofify-Duration, X-Lofify-Ready-Chunks',
    );
  };

  if (req.method === 'HEAD') {
    const job = await getOrStartTranscodeJob(jobCacheKey(track.id, target), track.file, target);
    setMetaHeaders(job);
    reply.code(200);
    return reply.send();
  }

  const segIndex = parseSegIndex(segRaw);
  if (segIndex == null) {
    reply.code(400);
    return reply.send({ error: 'invalid seg' });
  }
  if (segIndex >= segCount) {
    reply.code(404);
    return reply.send({ error: 'seg out of range' });
  }

  const job = await getOrStartTranscodeJob(jobCacheKey(track.id, target), track.file, target);
  // Wait until the requested chunk has been written. `segIndex + 1` because chunks are 1-indexed on disk.
  await waitForChunks(job, segIndex + 1);
  if (job.error) {
    reply.code(500);
    return reply.send({ error: job.error.message });
  }
  if (segIndex >= job.readyChunks) {
    // ffmpeg finished but never produced this chunk — track shorter than expected.
    reply.code(404);
    return reply.send({ error: 'chunk past end-of-track' });
  }

  let buf: Buffer;
  try {
    const chunk = await readChunkFile(job, chunkFileName(segIndex));
    if (segIndex === 0) {
      // The first chunk must be preceded by the init segment so the SourceBuffer learns the codec parameters; we splice them server-side instead of inventing a separate `/init` endpoint.
      const init = await readChunkFile(job, 'init.webm');
      buf = Buffer.concat([init, chunk]);
    } else {
      buf = chunk;
    }
  } catch (err) {
    reply.code(500);
    return reply.send({ error: err instanceof Error ? err.message : 'chunk read failed' });
  }

  setMetaHeaders(job);
  reply.code(200);
  reply.header('Content-Length', String(buf.length));
  reply.header('Cache-Control', 'private, max-age=3600');
  return reply.send(buf);
}

export async function registerPlaybackRoute(app: FastifyInstance): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = req.params as { signature: string; '*': string };
    const { signature } = params;
    const rest = params['*'] ?? '';
    const segments = rest.split('/').filter((s) => s !== '');
    if (segments.length === 0) {
      reply.code(404);
      return reply.send({ error: 'missing track id' });
    }

    // The trailing path component is the chunk index when it's purely digits — all track ids are UUIDs, so this is unambiguous. Without a trailing number, the request targets chunk 0 (or doesn't specify, e.g. HEAD).
    const last = segments[segments.length - 1]!;
    const segRaw = /^\d+$/.test(last) && segments.length >= 2 ? last : null;
    const idSegments = segRaw == null ? segments : segments.slice(0, -1);
    const id = idSegments[idSegments.length - 1]!;
    const optionSegments = idSegments.slice(0, -1);
    const payload = idSegments.join('/');

    if (!verifySignature(payload, signature)) {
      reply.code(403);
      return reply.send({ error: 'invalid signature' });
    }

    const opts = parseOptionSegments(optionSegments);
    if (opts == null) {
      reply.code(400);
      return reply.send({ error: 'invalid options' });
    }

    const rows = await db.select().from(tracksTable).where(eq(tracksTable.id, id)).limit(1);
    const track = rows[0];
    if (!track) {
      reply.code(404);
      return reply.send({ error: 'unknown track' });
    }

    const resolved = resolveTarget(track, opts);
    if (resolved.kind === 'passthrough') {
      return sendPassthrough(req, reply, track);
    }
    return sendTranscodeChunk(req, reply, track, resolved.target, segRaw);
  };

  app.get('/play/:signature/*', handler);
}
