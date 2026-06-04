import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';

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

function notFound(reply: FastifyReply) {
  reply.code(404);
  return reply.send({ error: 'not found' });
}

/**
 * `GET /artwork/:id` serves an `AlbumArt` row's original image. 404 unless the row exists, is SUCCEEDED and has its image on disk. Every response is `no-store`: the URL is stable across art replacements, so it must never be cached — cacheability belongs to the `/asset` route, whose URLs carry a cache-buster.
 */
export async function registerArtworkRoute(app: FastifyInstance): Promise<void> {
  app.get('/artwork/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = req.params as { id: string };
    if (!UUID_PATTERN.test(id)) return notFound(reply);

    const rows = await db.select().from(albumArt).where(eq(albumArt.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.status !== 'SUCCEEDED' || !row.file) return notFound(reply);

    const extension = path.extname(row.file).slice(1) as UploadExtension;
    const file = path.join(artworkDir(), row.file);
    try {
      const { size } = await stat(file);
      reply.header('Content-Type', CONTENT_TYPES[extension]);
      reply.header('Content-Length', String(size));
      return reply.send(createReadStream(file));
    } catch {
      return notFound(reply);
    }
  });
}
