/**
 * Range-based playback route. The client GETs `/play/<signature>/<options...>/<id>` with a `Range: bytes=…` header (issued from chunk byte ranges it learns from the `trackManifest` GraphQL subscription); the server resolves the encode target from `<options>`, ensures the cache entry is started, waits until the underlying `.bin` covers the requested range, and streams those bytes back as a `206 Partial Content`.
 *
 * Non-range requests are supported as a convenience for ad-hoc clients (curl, audio elements that don't speak MSE): the server waits for the whole encode to finish, then serves the full `.bin` with `200 OK` + `Content-Length`.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { abbreviateCodec } from '../graphql/codec.js';
import type { CacheEntry } from './cache.js';
import { defaultCache } from './cache.js';
import { parseOptionSegments } from './options.js';
import { contentTypeFor } from './resolve.js';
import { verifySignature } from './sign.js';

// A still-encoding entry's bytes (and its total length) keep growing, so its responses must never
// be cached — a stored partial would be replayed as if complete. Once the encode is done the `.bin`
// is final; the signed URL is deterministic over `(options, id)` with no expiry, so the bytes for a
// given URL are stable and safe to cache aggressively.
const CACHE_WHILE_ENCODING = 'no-store';
const CACHE_WHEN_DONE = 'public, max-age=31536000, immutable';

/** Parse a Range header. Supports `bytes=START-END` and `bytes=START-` (open-ended). Returns `null` for malformed or suffix-byte (`bytes=-N`) forms, which clients shouldn't be sending against incomplete media. */
function parseRangeHeader(
  header: string | undefined,
): { start: number; end: number | null } | null {
  if (!header || !header.startsWith('bytes=')) return null;
  const spec = header.slice(6).split(',')[0]?.trim();
  if (!spec) return null;
  const m = /^(\d+)-(\d*)$/.exec(spec);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? null : Number(m[2]);
  if (end !== null && end < start) return null;
  return { start, end };
}

/** Wait until the cache entry's `.bin` has reached at least `atLeast` bytes, or the encoder has finished (in which case the returned size may be smaller — caller's job to detect range-past-EOF). Rejects if the encoder errored. */
async function waitForBinSize(entry: CacheEntry, atLeast: number): Promise<number> {
  const check = async (): Promise<number | null> => {
    const err = entry.error();
    if (err) throw err;
    const st = await stat(entry.binPath).catch(() => null);
    if (st && st.size >= atLeast) return st.size;
    if (entry.isDone()) return st?.size ?? 0;
    return null;
  };
  const initial = await check();
  if (initial !== null) return initial;
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      entry.emitter.off('update', onWake);
      entry.emitter.off('error', onError);
    };
    const onWake = (): void => {
      check().then(
        (size) => {
          if (size !== null) {
            cleanup();
            resolve(size);
          }
        },
        (err: unknown) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    entry.emitter.on('update', onWake);
    entry.emitter.on('error', onError);
  });
}

async function serveRange(
  req: FastifyRequest,
  reply: FastifyReply,
  entry: CacheEntry,
  contentType: string,
  range: { start: number; end: number | null },
): Promise<void> {
  // For an open-ended range we just need the next byte after `start`; for a closed range we need bytes through `end` inclusive.
  const minNeeded = range.end !== null ? range.end + 1 : range.start + 1;
  let size: number;
  try {
    size = await waitForBinSize(entry, minNeeded);
  } catch (err) {
    reply.code(500);
    reply.header('Cache-Control', CACHE_WHILE_ENCODING);
    return reply.send({ error: err instanceof Error ? err.message : 'encoder error' });
  }
  if (range.start >= size) {
    reply.code(416);
    reply.header('Cache-Control', CACHE_WHILE_ENCODING);
    if (entry.isDone()) reply.header('Content-Range', `bytes */${size}`);
    return reply.send({ error: 'range not satisfiable' });
  }
  const done = entry.isDone();
  const end = Math.min(range.end ?? size - 1, size - 1);
  reply.code(206);
  reply.header('Content-Type', contentType);
  reply.header('Content-Range', `bytes ${range.start}-${end}/${done ? size : '*'}`);
  reply.header('Content-Length', String(end - range.start + 1));
  reply.header('Cache-Control', done ? CACHE_WHEN_DONE : CACHE_WHILE_ENCODING);
  return reply.send(createReadStream(entry.binPath, { start: range.start, end }));
}

async function serveFull(
  _req: FastifyRequest,
  reply: FastifyReply,
  entry: CacheEntry,
  contentType: string,
): Promise<void> {
  try {
    await entry.waitForEncoded(Number.POSITIVE_INFINITY);
  } catch (err) {
    reply.code(500);
    return reply.send({ error: err instanceof Error ? err.message : 'encoder error' });
  }
  const st = await stat(entry.binPath);
  reply.code(200);
  reply.header('Content-Type', contentType);
  reply.header('Content-Length', String(st.size));
  // serveFull only returns after the encode finishes, so the bytes are final and cacheable.
  reply.header('Cache-Control', CACHE_WHEN_DONE);
  return reply.send(createReadStream(entry.binPath));
}

export async function registerPlaybackRoute(app: FastifyInstance): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = req.params as { signature: string; '*': string };
    const rest = params['*'] ?? '';
    const segments = rest.split('/').filter((s) => s !== '');
    if (segments.length === 0) {
      reply.code(404);
      return reply.send({ error: 'missing track id' });
    }
    const id = segments[segments.length - 1]!;
    const optionSegments = segments.slice(0, -1);
    const payload = segments.join('/');

    if (!verifySignature(payload, params.signature)) {
      reply.code(403);
      return reply.send({ error: 'invalid signature' });
    }
    const target = parseOptionSegments(optionSegments);
    if (target == null) {
      reply.code(400);
      return reply.send({ error: 'invalid options' });
    }

    const rows = await db.select().from(tracksTable).where(eq(tracksTable.id, id)).limit(1);
    const track = rows[0];
    if (!track) {
      reply.code(404);
      return reply.send({ error: 'unknown track' });
    }

    const entry = await defaultCache.getOrStart({
      trackId: track.id,
      sourceMtime: track.sourceMtime,
      sourcePath: track.file,
      sourceCodec: abbreviateCodec(track.codec),
      target,
    });

    const contentType = contentTypeFor(target);
    reply.header('Accept-Ranges', 'bytes');
    // The resolved quality of these bytes. Lets the player report the tier actually playing at the
    // playhead (which lags the requested tier during an on-the-fly switch, as the buffer drains).
    reply.header('X-Quality', target.quality);
    // One signed URL serves different bodies per `Range` (distinct byte slices, or the full `.bin`
    // when no Range is sent), so a cache keyed only on the URL must not reuse a stored slice for a
    // different range. Everything else that selects the representation is in the path, not headers.
    reply.header('Vary', 'Range');

    if (req.method === 'HEAD') {
      reply.code(200);
      reply.header('Content-Type', contentType);
      if (entry.isDone()) {
        const st = await stat(entry.binPath);
        reply.header('Content-Length', String(st.size));
        reply.header('Cache-Control', CACHE_WHEN_DONE);
      } else {
        reply.header('Cache-Control', CACHE_WHILE_ENCODING);
      }
      return reply.send();
    }

    const range = parseRangeHeader(req.headers.range as string | undefined);
    if (range) {
      return serveRange(req, reply, entry, contentType, range);
    }
    return serveFull(req, reply, entry, contentType);
  };

  app.route({ method: ['GET', 'HEAD'], url: '/play/:signature/*', handler });
}
