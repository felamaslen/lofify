import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import parseRange from 'range-parser';

import { db } from '../db/client.js';
import type { Track as DbTrack } from '../db/schema/index.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { type ParsedOptions, parseOptionSegments } from './options.js';
import { verifySignature } from './sign.js';
import {
  chunkLayout,
  getOrStartTranscodeJob,
  jobCacheKey,
  readChunkFile,
  SEGMENT_DURATION_SECONDS,
  type TranscodeJob,
  type TranscodeTarget,
  waitForChunks,
} from './transcode.js';

/** Delivery-format identifiers used during Accept-header negotiation. */
export type DeliveryFormat = 'flac' | 'mpeg' | 'webm';

const ACCEPT_MAP: Record<string, DeliveryFormat> = {
  'audio/flac': 'flac',
  'audio/mpeg': 'mpeg',
  'audio/webm': 'webm',
};

// Order in which a wildcard (audio/* or */*) expands. flac comes first so plain
// `<audio src=url>` playback (which sends Accept: */*) gets passthrough on
// lossless sources.
const WILDCARD_EXPANSION: readonly DeliveryFormat[] = ['flac', 'webm', 'mpeg'];

/**
 * Parse an Accept header into an ordered, de-duped list of supported delivery formats.
 *
 * Returns `null` if any media type is outside the supported set, or if the header is empty/missing. Standard wildcards expand to all three supported formats — that's what bare `<audio>` elements send when they fetch the playback URL directly, and rejecting them would force every consumer to inject a header.
 */
export function parseAcceptHeader(header: string | undefined | null): DeliveryFormat[] | null {
  if (!header) return null;
  const parts = header.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const seen = new Set<DeliveryFormat>();
  const out: DeliveryFormat[] = [];
  const push = (fmt: DeliveryFormat): void => {
    if (!seen.has(fmt)) {
      seen.add(fmt);
      out.push(fmt);
    }
  };
  for (const part of parts) {
    // Strip any media-type parameters (e.g. `;q=0.9`) — we don't honour quality weighting; ordering is enough.
    const mime = part.split(';')[0]!.trim().toLowerCase();
    if (mime === '*/*' || mime === 'audio/*') {
      for (const fmt of WILDCARD_EXPANSION) push(fmt);
      continue;
    }
    const fmt = ACCEPT_MAP[mime];
    if (!fmt) return null;
    push(fmt);
  }
  return out;
}

export function contentTypeFor(format: DeliveryFormat): string {
  switch (format) {
    case 'flac':
      return 'audio/flac';
    case 'mpeg':
      return 'audio/mpeg';
    case 'webm':
      return 'audio/webm; codecs=opus';
  }
}

export type ResolvedTarget =
  | { kind: 'passthrough'; contentType: string }
  | { kind: 'transcode'; target: TranscodeTarget; contentType: string };

/**
 * Pick a delivery target given the source track, signed options, and the client's accepted formats.
 *
 * Rules:
 * - If `flac` is in the accept list and the source is flac → passthrough.
 * - If `flac` is in the accept list and the source is lossy → encode at max quality to the first non-flac accept entry.
 * - If `flac` is not in the accept list → encode at the requested quality (default `1`) to the first accept entry.
 */
export function resolveTarget(track: DbTrack, opts: ParsedOptions, accepts: DeliveryFormat[]): ResolvedTarget {
  const sourceIsFlac = track.format.toLowerCase() === 'flac';
  if (accepts.includes('flac')) {
    if (sourceIsFlac) return { kind: 'passthrough', contentType: contentTypeFor('flac') };
    const fallback = accepts.find((a) => a !== 'flac');
    // Caller validates `accepts` (flac alone is rejected upstream) so a fallback always exists here.
    if (!fallback) throw new Error('unreachable: flac without fallback');
    return {
      kind: 'transcode',
      target: encodeTarget(fallback, 'max'),
      contentType: contentTypeFor(fallback),
    };
  }
  const fmt = accepts[0]!;
  const q = opts.quality ?? 'medium';
  return { kind: 'transcode', target: encodeTarget(fmt, q), contentType: contentTypeFor(fmt) };
}

function encodeTarget(fmt: DeliveryFormat, quality: 'low' | 'medium' | 'high' | 'max'): TranscodeTarget {
  if (fmt === 'flac') throw new Error('flac is passthrough-only');
  return fmt === 'webm'
    ? { format: { container: 'webm', codec: 'opus' }, quality }
    : { format: { container: 'mp3', codec: 'mp3' }, quality };
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
  contentType: string,
): Promise<void> {
  const st = await stat(track.file);
  const total = st.size;

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

function chunkFileName(target: TranscodeTarget, segIndex: number): string {
  const { ext } = chunkLayout(target);
  // The webm DASH muxer numbers media segments from 1; the mp3 segment muxer numbers from 0. Normalise both to the 0-indexed external API by adjusting here.
  const onDiskIndex = target.format.container === 'webm' ? segIndex + 1 : segIndex;
  return `chunk-${String(onDiskIndex).padStart(5, '0')}.${ext}`;
}

async function sendTranscodeChunk(
  req: FastifyRequest,
  reply: FastifyReply,
  track: DbTrack,
  target: TranscodeTarget,
  contentType: string,
  segRaw: string | null,
): Promise<void> {
  const segCount = Math.max(1, Math.ceil(track.durationSeconds / SEGMENT_DURATION_SECONDS));
  const { init: initName } = chunkLayout(target);

  const setMetaHeaders = (job: TranscodeJob | null): void => {
    reply.header('Content-Type', contentType);
    reply.header('X-Lofify-Segments', String(segCount));
    reply.header('X-Lofify-Segment-Duration', String(SEGMENT_DURATION_SECONDS));
    reply.header('X-Lofify-Duration', String(track.durationSeconds));
    reply.header('X-Lofify-Ready-Chunks', String(job?.readyChunks ?? 0));
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
  // For webm, on-disk index = segIndex + 1; for mp3 the indexes match. `waitForChunks` counts files irrespective of numbering, so the lower bound is the same.
  await waitForChunks(job, segIndex + 1);
  if (job.error) {
    reply.code(500);
    return reply.send({ error: job.error.message });
  }
  if (segIndex >= job.readyChunks) {
    reply.code(404);
    return reply.send({ error: 'chunk past end-of-track' });
  }

  let buf: Buffer;
  try {
    const chunk = await readChunkFile(job, chunkFileName(target, segIndex));
    if (initName && segIndex === 0) {
      // The first chunk must be preceded by the init segment so the SourceBuffer learns the codec parameters; mp3 doesn't have one (every frame is self-describing).
      const init = await readChunkFile(job, initName);
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

    const acceptHeader = req.headers.accept;
    const accepts = parseAcceptHeader(typeof acceptHeader === 'string' ? acceptHeader : undefined);
    if (!accepts) {
      reply.code(406);
      return reply.send({ error: 'missing or unsupported Accept header' });
    }
    if (accepts.includes('flac') && accepts.length === 1) {
      reply.code(406);
      return reply.send({ error: 'audio/flac must be paired with at least one fallback format' });
    }

    const rows = await db.select().from(tracksTable).where(eq(tracksTable.id, id)).limit(1);
    const track = rows[0];
    if (!track) {
      reply.code(404);
      return reply.send({ error: 'unknown track' });
    }

    const resolved = resolveTarget(track, opts, accepts);
    if (resolved.kind === 'passthrough') {
      return sendPassthrough(req, reply, track, resolved.contentType);
    }
    return sendTranscodeChunk(req, reply, track, resolved.target, resolved.contentType, segRaw);
  };

  app.get('/play/:signature/*', handler);
}
