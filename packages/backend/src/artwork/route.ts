import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { artworkDir } from '../disk-cache.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Downloaded images never change — a new download is a new row, hence a new URL. */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * `GET /artwork/<albumArtId>` serves the downloaded image for an `AlbumArt` row straight from disk. The worker writes exactly `<id>.jpg`, so no DB lookup is needed; an id with no file (unknown, pending or failed) is a 404. The uuid check also guards the path join against traversal.
 */
export async function registerArtworkRoute(app: FastifyInstance): Promise<void> {
  app.get('/artwork/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_PATTERN.test(id)) {
      reply.code(404);
      return reply.send({ error: 'not found' });
    }
    const file = path.join(artworkDir(), `${id}.jpg`);
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      reply.code(404);
      return reply.send({ error: 'not found' });
    }
    reply.header('Content-Type', 'image/jpeg');
    reply.header('Content-Length', String(size));
    reply.header('Cache-Control', CACHE_IMMUTABLE);
    return reply.send(createReadStream(file));
  });
}
