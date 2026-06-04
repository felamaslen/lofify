import '../test/image-snapshot.js';

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { albumArt } from '../db/schema/index.js';
import { testCard } from '../test/test-card.js';

beforeEach(async () => {
  await db.delete(albumArt);
});

// Mirrors the production layout: images are stored by basename under <DISK_CACHE_DIR>/artwork.
const artworkDir = path.join(process.env.DISK_CACHE_DIR!, 'artwork');

async function storeImage(bytes: Buffer, extension: string): Promise<string> {
  const file = `${randomUUID()}.${extension}`;
  await mkdir(artworkDir, { recursive: true });
  await writeFile(path.join(artworkDir, file), bytes);
  return file;
}

async function seedArt(values: Partial<typeof albumArt.$inferInsert> = {}) {
  const [row] = await db
    .insert(albumArt)
    .values({ albumArtist: 'Album Artist', album: 'The Album', ...values })
    .returning();
  return row!;
}

test('GET /artwork/:id serves the row image no-store, 404s for unresolved rows', async () => {
  const row = await seedArt();

  // A PENDING row never serves.
  const notReady = await app.inject({ method: 'GET', url: `/artwork/${row.id}` });
  expect(notReady.statusCode).toBe(404);
  expect(notReady.headers['cache-control']).toBe('no-store');

  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const file = await storeImage(bytes, 'jpg');
  await db.update(albumArt).set({ status: 'SUCCEEDED', file });

  // The URL is stable across replacements, so the original must never be cached; cacheable URLs are /asset's job.
  const hit = await app.inject({ method: 'GET', url: `/artwork/${row.id}` });
  expect(hit.statusCode).toBe(200);
  expect(hit.headers['content-type']).toBe('image/jpeg');
  expect(hit.headers['cache-control']).toBe('no-store');
  expect(hit.rawPayload).toEqual(bytes);

  const miss = await app.inject({
    method: 'GET',
    url: '/artwork/01934567-89ab-7cde-8123-000000000000',
  });
  expect(miss.statusCode).toBe(404);

  const invalid = await app.inject({ method: 'GET', url: '/artwork/not-an-id' });
  expect(invalid.statusCode).toBe(404);
});

test('GET /artwork/:id serves the original media (image snapshot)', async () => {
  const file = await storeImage(await testCard(), 'png');
  const row = await seedArt({ status: 'SUCCEEDED', file });

  const res = await app.inject({ method: 'GET', url: `/artwork/${row.id}` });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('image/png');
  // Original dimensions, untouched — in particular not the 500px preview square.
  const meta = await sharp(res.rawPayload).metadata();
  expect([meta.width, meta.height]).toEqual([800, 600]);
  expect(res.rawPayload).toMatchImageSnapshot({
    customSnapshotIdentifier: 'artwork-original',
  });
});
