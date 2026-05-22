import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import parseRange from 'range-parser';

import { db } from '../db/client.js';
import type { Track as DbTrack } from '../db/schema/index.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { env } from '../env.js';
import { type ParsedOptions, parseOptionSegments, type RequestedFormat } from './options.js';
import { verifySignature } from './sign.js';
import {
  type Entry,
  getOrStartTranscode,
  subscribe,
  type TranscodeTarget,
  waitForBytes,
} from './transcode.js';

/** For an open-ended range like `bytes=N-` against an in-progress transcode, we don't know the final byte until ffmpeg finishes — so we serve the slice we already have, then close. The browser will request the next slice. This is the floor on how much we wait to buffer before responding, to keep per-seek request count modest. */
const MIN_OPEN_RANGE_BYTES = 256 * 1024;

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

export type ResolvedTarget = { kind: 'passthrough' } | { kind: 'transcode'; target: TranscodeTarget };

export function transcodeCacheKey(trackId: string, target: TranscodeTarget): string {
  return `${trackId}:${target.format}:${target.codec}:${target.quality ?? 'auto'}`;
}

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

/** Parse a `bytes=N-` or `bytes=N-M` header without needing to know the total resource size. Returns `end: null` for open-ended ranges (`bytes=N-`) so the caller can distinguish "client wants until EOF" from "client wants exactly up to M" — that distinction matters for transcoded responses, where we don't know the final size yet. We use this instead of `range-parser` because that library needs the total size up front to resolve `bytes=N-` into `{ start, end: total-1 }`, which loses the open/closed signal and forces a fake size in this code path. Multi-range, suffix ranges (`bytes=-N`), and non-bytes units are unsupported and return `null`. */
function parseSimpleRange(header: string): { start: number; end: number | null } | null {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? null : Number(m[2]);
  if (end !== null && end < start) return null;
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

/** Copy headers added via `reply.header()` (e.g. by the CORS plugin) onto the raw response. Without this, hijacking drops anything plugins set on the Fastify reply, since `reply.send()` is what normally flushes them. */
function flushReplyHeadersToRaw(reply: FastifyReply, raw: ServerResponse): void {
  const headers = reply.getHeaders();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    raw.setHeader(name, value as string | number | readonly string[]);
  }
}

async function streamEntryToRaw(
  raw: ServerResponse,
  entry: Entry,
  startByte: number,
  maxBytes: number | null,
): Promise<void> {
  let closed = false;
  const onClose = (): void => {
    closed = true;
  };
  raw.on('close', onClose);

  const writeChunk = async (chunk: Buffer): Promise<void> => {
    if (closed) return;
    if (!raw.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          raw.off('drain', done);
          raw.off('close', done);
          resolve();
        };
        raw.once('drain', done);
        raw.once('close', done);
      });
    }
    // TESTING ONLY — simulate a slow client link. Delay the next write by the
    // wall-clock cost of `chunk.length` at the configured bitrate so callers
    // see effective throughput at or below `PLAYBACK_MAX_BITRATE`.
    if (env.PLAYBACK_MAX_BITRATE > 0 && !closed) {
      const delayMs = (chunk.length * 8 * 1000) / env.PLAYBACK_MAX_BITRATE;
      await new Promise<void>((resolve) => {
        const onCloseDuringDelay = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          raw.off('close', onCloseDuringDelay);
          resolve();
        }, delayMs);
        raw.once('close', onCloseDuringDelay);
      });
    }
  };

  let remaining = maxBytes;
  const trim = (chunk: Buffer): Buffer => {
    if (remaining == null) return chunk;
    return chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  };

  try {
    const sub = subscribe(entry, startByte);
    for (const chunk of sub.initial) {
      if (closed || remaining === 0) break;
      const slice = trim(chunk);
      await writeChunk(slice);
      if (remaining != null) remaining -= slice.length;
    }
    while (!closed && remaining !== 0) {
      const chunk = await Promise.race<Buffer | null>([
        sub.next(),
        new Promise<null>((resolve) => raw.once('close', () => resolve(null))),
      ]);
      if (closed || chunk == null) break;
      const slice = trim(chunk);
      await writeChunk(slice);
      if (remaining != null) remaining -= slice.length;
    }
    if (closed) return;
    const err = sub.error();
    if (err) {
      raw.destroy(err);
      return;
    }
    raw.end();
  } finally {
    raw.off('close', onClose);
  }
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

  const rangeHeader = req.headers.range;
  const range = rangeHeader ? parseSimpleRange(rangeHeader) : null;

  if (range) {
    const wantBytes =
      range.end !== null ? range.end + 1 : range.start + MIN_OPEN_RANGE_BYTES;
    await waitForBytes(entry, wantBytes);

    if (entry.error) {
      reply.code(500);
      return reply.send({ error: entry.error.message });
    }
    if (range.start >= entry.bytes) {
      reply.code(416);
      if (entry.done) reply.header('Content-Range', `bytes */${entry.bytes}`);
      return reply.send();
    }

    const last =
      range.end !== null ? Math.min(range.end, entry.bytes - 1) : entry.bytes - 1;
    const total = entry.done ? String(entry.bytes) : '*';
    const byteLength = last - range.start + 1;

    reply.code(206);
    reply.hijack();
    const raw = reply.raw;
    flushReplyHeadersToRaw(reply, raw);
    raw.statusCode = 206;
    raw.setHeader('Content-Type', contentType);
    raw.setHeader('Accept-Ranges', 'bytes');
    raw.setHeader('Content-Range', `bytes ${range.start}-${last}/${total}`);
    raw.setHeader('Content-Length', String(byteLength));
    await streamEntryToRaw(raw, entry, range.start, byteLength);
    return;
  }

  reply.code(200);
  reply.hijack();
  const raw = reply.raw;
  flushReplyHeadersToRaw(reply, raw);
  raw.setHeader('Content-Type', contentType);
  raw.setHeader('Accept-Ranges', 'bytes');
  await streamEntryToRaw(raw, entry, 0, null);
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
      return sendTranscode(req, reply, track, resolved.target, transcodeCacheKey(track.id, resolved.target));
    },
  );
}
