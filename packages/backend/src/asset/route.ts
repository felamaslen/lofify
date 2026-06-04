import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';

import { assetDir } from '../disk-cache.js';
import { env } from '../env.js';

/** The supported transforms from the URL's options segment. `v` is the source's version: it makes each revision a distinct URL (the originals are served no-store from stable URLs) and is part of the render cache key. */
const OptionsSchema = z
  .object({
    format: z.literal('avif').optional(),
    size: z
      .literal('500')
      .transform(() => 500 as const)
      .optional(),
    v: z.string().optional(),
  })
  .strict();

type Variant = z.infer<typeof OptionsSchema>;

/** Source MIME → file extension for cached renders that keep the original format. */
const SOURCE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Rendered output never changes behind a URL: the `v` option versions the source, and it is part of both the URL and the render cache key. */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

function badRequest(reply: FastifyReply, error: string) {
  reply.code(400);
  return reply.send({ error });
}

function notFound(reply: FastifyReply) {
  // Transient by nature (the source may exist later) — must never stick in a cache.
  reply.code(404);
  reply.header('Cache-Control', 'no-store');
  return reply.send({ error: 'not found' });
}

/**
 * `GET /asset/:options/:url` — a processed render of another API resource, separating file processing from serving the original. The options segment uses query-string syntax kept in the path (no query-forwarding concerns across CDNs); the rest of the path is the source URL, e.g. `/asset/format=avif&size=500&v=2/https://music.example.com/artwork/<id>`. Only same-origin (`PUBLIC_URL`) sources are allowed and they are resolved internally, so this is not an open proxy. Renders are cached on disk keyed by the options (including the source version `v`) + source URL, so a new revision of a source is a new key.
 *
 * This in-process implementation can be scaled out by putting a dedicated processing proxy in front, e.g. https://github.com/socialtip/asset-proxy — the URL shape is designed to make that a drop-in swap.
 */
export async function registerAssetRoute(app: FastifyInstance): Promise<void> {
  const publicOrigin = new URL(env.PUBLIC_URL).origin;

  app.get('/asset/:options/*', async (req, reply) => {
    // Parse from the raw URL: the source URL's own query string (if any) must stay part of the source, not be eaten as this request's query.
    const raw = req.raw.url ?? '';
    const afterPrefix = raw.slice('/asset/'.length);
    const slash = afterPrefix.indexOf('/');
    if (slash < 0) return notFound(reply);
    const optionsRaw = afterPrefix.slice(0, slash);
    const sourceRaw = decodeURIComponent(afterPrefix.slice(slash + 1));

    const parsed = OptionsSchema.safeParse(Object.fromEntries(new URLSearchParams(optionsRaw)));
    if (!parsed.success) {
      return badRequest(reply, 'unsupported options — use format=avif and/or size=500');
    }
    const variant: Variant = parsed.data;
    if (!variant.format && !variant.size) {
      return badRequest(reply, 'no transform requested');
    }

    let source: URL;
    try {
      source = new URL(sourceRaw);
    } catch {
      return badRequest(reply, 'source must be an absolute URL');
    }
    if (source.origin !== publicOrigin) {
      return badRequest(reply, 'source must be served by this API');
    }

    const canonical = `format=${variant.format ?? 'source'}&size=${variant.size ?? 'source'}&v=${variant.v ?? ''}`;
    const hash = createHash('sha256').update(`${canonical}|${source.href}`).digest('hex');

    try {
      let file = path.join(assetDir(), `${hash}.${variant.format ?? 'bin'}`);
      let contentType = variant.format ? `image/${variant.format}` : null;

      const cached = await findCached(hash);
      if (cached) {
        file = cached.file;
        contentType = cached.contentType;
      } else {
        // Same-origin by construction, so resolve in-process rather than over the network.
        const upstream = await app.inject({
          method: 'GET',
          url: source.pathname + source.search,
        });
        if (upstream.statusCode !== 200) return notFound(reply);
        const sourceType = String(upstream.headers['content-type'] ?? '');
        const extension = variant.format ?? SOURCE_EXTENSIONS[sourceType];
        if (!extension)
          return badRequest(reply, `cannot process ${sourceType || 'unknown'} sources`);

        let pipeline = sharp(upstream.rawPayload);
        if (variant.size) pipeline = pipeline.resize(variant.size, variant.size, { fit: 'cover' });
        if (variant.format) pipeline = pipeline.avif();
        const rendered = await pipeline.toBuffer();

        file = path.join(assetDir(), `${hash}.${extension}`);
        contentType = variant.format ? 'image/avif' : sourceType;
        // Written via a temp file so a concurrent request never streams a half-written render.
        const tmp = `${file}.tmp-${process.pid}`;
        await writeFile(tmp, rendered);
        await rename(tmp, file);
      }

      const { size } = await stat(file);
      reply.header('Content-Type', contentType ?? 'application/octet-stream');
      reply.header('Content-Length', String(size));
      reply.header('Cache-Control', CACHE_IMMUTABLE);
      return reply.send(createReadStream(file));
    } catch {
      return notFound(reply);
    }
  });
}

/** Look up a previously rendered file for `hash`, whatever extension it was stored with. */
async function findCached(hash: string): Promise<{ file: string; contentType: string } | null> {
  for (const [type, extension] of [
    ['image/avif', 'avif'],
    ...Object.entries(SOURCE_EXTENSIONS).map(([t, e]) => [t, e]),
  ] as [string, string][]) {
    const file = path.join(assetDir(), `${hash}.${extension}`);
    const exists = await stat(file).catch(() => null);
    if (exists) return { file, contentType: type };
  }
  return null;
}
