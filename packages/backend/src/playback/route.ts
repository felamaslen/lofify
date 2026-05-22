import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import parseRange from 'range-parser';
import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import type { Track as DbTrack } from '../db/schema/index.js';
import { parseOptionSegments, type ParsedOptions, type RequestedFormat } from './options.js';
import { verifySignature } from './sign.js';
import {
  getOrStartTranscode,
  subscribe,
  waitForCompletion,
  type TranscodeTarget,
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

type ResolvedTarget = { kind: 'passthrough' } | { kind: 'transcode'; target: TranscodeTarget };

function resolveTarget(track: DbTrack, opts: ParsedOptions): ResolvedTarget {
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

  const range = parseRangeHeader(req.headers.range, total);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', contentType);

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

async function sendTranscode(
  req: FastifyRequest,
  reply: FastifyReply,
  track: DbTrack,
  target: TranscodeTarget,
  cacheKey: string,
): Promise<void> {
  const entry = getOrStartTranscode(cacheKey, track.file, target);
  const contentType = contentTypeFor(target.format, target.codec);
  reply.header('Content-Type', contentType);
  reply.header('Accept-Ranges', 'bytes');

  if (req.headers.range) {
    const full = await waitForCompletion(entry);
    const range = parseRangeHeader(req.headers.range, full.length);
    if (!range) {
      reply.code(200);
      reply.header('Content-Length', String(full.length));
      return reply.send(full);
    }
    const slice = full.subarray(range.start, range.end + 1);
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${full.length}`);
    reply.header('Content-Length', String(slice.length));
    return reply.send(slice);
  }

  reply.code(200);
  reply.hijack();
  const raw = reply.raw;
  raw.setHeader('Content-Type', contentType);
  const sub = subscribe(entry);
  for (const chunk of sub.initial) {
    if (!raw.write(chunk)) await new Promise<void>((r) => raw.once('drain', () => r()));
  }
  while (true) {
    const chunk = await sub.next();
    if (chunk == null) break;
    if (!raw.write(chunk)) await new Promise<void>((r) => raw.once('drain', () => r()));
  }
  const err = sub.error();
  if (err) {
    raw.destroy(err);
    return;
  }
  raw.end();
}

export async function registerPlaybackRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { signature: string; '*': string } }>(
    '/play/:signature/*',
    async (req, reply) => {
      const { signature } = req.params;
      const rest = req.params['*'] ?? '';
      const segments = rest.split('/').filter((s) => s !== '');
      if (segments.length === 0) {
        reply.code(404);
        return reply.send({ error: 'missing track id' });
      }
      const id = segments[segments.length - 1]!;
      const optionSegments = segments.slice(0, -1);
      const payload = segments.join('/');

      if (!verifySignature(payload, signature)) {
        reply.code(403);
        return reply.send({ error: 'invalid signature' });
      }

      const opts = parseOptionSegments(optionSegments);
      if (opts == null) {
        reply.code(400);
        return reply.send({ error: 'invalid options' });
      }

      const rows = await db
        .select()
        .from(tracksTable)
        .where(eq(tracksTable.id, id))
        .limit(1);
      const track = rows[0];
      if (!track) {
        reply.code(404);
        return reply.send({ error: 'unknown track' });
      }

      const resolved = resolveTarget(track, opts);
      if (resolved.kind === 'passthrough') {
        return sendPassthrough(req, reply, track);
      }
      const cacheKey = `${track.id}:${resolved.target.format}:${resolved.target.codec}:${resolved.target.quality ?? 'auto'}`;
      return sendTranscode(req, reply, track, resolved.target, cacheKey);
    },
  );
}
