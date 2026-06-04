import { createReadStream } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';

import { db } from '../db/client.js';
import { albumArt } from '../db/schema/index.js';
import { artworkDir } from '../disk-cache.js';
import type { UploadExtension } from './store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONTENT_TYPES: Record<UploadExtension, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Renders never change behind a URL: `Media.url` carries a `v=<updatedAt>` path option, so replaced art is a new URL and every variant of one revision is a distinct path. */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

/** The supported transforms from the URL's options segment. `v` is the cache-buster and carries no meaning. */
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

type Variant = Pick<z.infer<typeof OptionsSchema>, 'format' | 'size'>;

/** Parse an options path segment (`format=avif&size=500` — query-string syntax, kept in the path so CDNs cache variants without any query-forwarding concerns). Returns null for unknown keys or unsupported values. */
function parseOptions(raw: string): Variant | null {
  const result = OptionsSchema.safeParse(Object.fromEntries(new URLSearchParams(raw)));
  return result.success ? result.data : null;
}

/**
 * Produce (or reuse) the rendered variant of `source` at `target`. Freshness is mtime-based: the worker overwrites a re-downloaded image under the same basename, so a derivative older than its source is regenerated. Written via a temp file so a concurrent request never streams a half-encoded image.
 */
async function ensureDerivative(source: string, target: string, variant: Variant): Promise<void> {
  const sourceStat = await stat(source);
  const targetStat = await stat(target).catch(() => null);
  if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs) return;

  let pipeline = sharp(source);
  if (variant.size) pipeline = pipeline.resize(variant.size, variant.size, { fit: 'cover' });
  if (variant.format) pipeline = pipeline.avif();
  const tmp = `${target}.tmp-${process.pid}`;
  await pipeline.toFile(tmp);
  await rename(tmp, target);
}

function notFound(reply: FastifyReply) {
  // A 404 here is transient (a pending download, a not-yet-visible row) — it must never stick in a cache.
  reply.code(404);
  reply.header('Cache-Control', 'no-store');
  return reply.send({ error: 'not found' });
}

/**
 * `GET /artwork/:id` and `GET /artwork/:options/:id` serve an `AlbumArt` row's image — the original, or a variant described by the options segment (e.g. `format=avif&size=500` for a 500px AVIF square). Variants are rendered on first request and cached on disk next to the original. 404 unless the row exists, is SUCCEEDED and has its image on disk.
 */
export async function registerArtworkRoute(app: FastifyInstance): Promise<void> {
  const handler = async (reply: FastifyReply, id: string, rawOptions: string): Promise<void> => {
    if (!UUID_PATTERN.test(id)) return notFound(reply);
    const variant = parseOptions(rawOptions);
    if (variant === null) {
      reply.code(400);
      return reply.send({ error: 'unsupported options — use format=avif and/or size=500' });
    }

    const rows = await db.select().from(albumArt).where(eq(albumArt.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.status !== 'SUCCEEDED' || !row.file) return notFound(reply);

    const extension = path.extname(row.file).slice(1) as UploadExtension;
    const source = path.join(artworkDir(), row.file);
    let file = source;
    let contentType = CONTENT_TYPES[extension];
    try {
      if (variant.format || variant.size) {
        file = path.join(
          artworkDir(),
          `${row.file}${variant.size ? `.${variant.size}` : ''}.${variant.format ?? extension}`,
        );
        contentType = variant.format ? 'image/avif' : contentType;
        await ensureDerivative(source, file, variant);
      }
      const { size } = await stat(file);
      reply.header('Content-Type', contentType);
      reply.header('Content-Length', String(size));
      reply.header('Cache-Control', CACHE_IMMUTABLE);
      return reply.send(createReadStream(file));
    } catch {
      return notFound(reply);
    }
  };

  app.get('/artwork/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return handler(reply, id, '');
  });
  app.get('/artwork/:options/:id', async (req, reply) => {
    const { options, id } = req.params as { options: string; id: string };
    return handler(reply, id, options);
  });
}
