import '../test/image-snapshot.js';

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { albumArt } from '../db/schema/index.js';

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

/** Deterministic 800×600 test card — four coloured quadrants, so the square crop and resize are unmistakable in image snapshots. */
async function testCard(): Promise<Buffer> {
  const width = 800;
  const height = 600;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const left = x < width / 2;
      const top = y < height / 2;
      const [r, g, b] = top
        ? left
          ? [200, 30, 30]
          : [30, 160, 60]
        : left
          ? [30, 60, 200]
          : [230, 200, 40];
      raw[i] = r!;
      raw[i + 1] = g!;
      raw[i + 2] = b!;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

test('GET /artwork/:id serves the row image immutably, 404s for unresolved rows', async () => {
  const row = await seedArt();

  // A PENDING row never serves, and the 404 must not stick in caches.
  const notReady = await app.inject({ method: 'GET', url: `/artwork/${row.id}` });
  expect(notReady.statusCode).toBe(404);
  expect(notReady.headers['cache-control']).toBe('no-store');

  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const file = await storeImage(bytes, 'jpg');
  await db.update(albumArt).set({ status: 'SUCCEEDED', file });

  const hit = await app.inject({ method: 'GET', url: `/artwork/${row.id}` });
  expect(hit.statusCode).toBe(200);
  expect(hit.headers['content-type']).toBe('image/jpeg');
  expect(hit.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(hit.rawPayload).toEqual(bytes);

  // The cache-buster options segment changes nothing about the response.
  const busted = await app.inject({ method: 'GET', url: `/artwork/v=12345/${row.id}` });
  expect(busted.statusCode).toBe(200);
  expect(busted.rawPayload).toEqual(bytes);

  const miss = await app.inject({
    method: 'GET',
    url: '/artwork/01934567-89ab-7cde-8123-000000000000',
  });
  expect(miss.statusCode).toBe(404);

  const invalid = await app.inject({ method: 'GET', url: '/artwork/not-an-id' });
  expect(invalid.statusCode).toBe(404);
});

test('GET /artwork validates the options segment', async () => {
  const file = await storeImage(await testCard(), 'png');
  const row = await seedArt({ status: 'SUCCEEDED', file });

  const badFormat = await app.inject({ method: 'GET', url: `/artwork/format=webp/${row.id}` });
  expect(badFormat.statusCode).toBe(400);
  const badSize = await app.inject({ method: 'GET', url: `/artwork/size=400/${row.id}` });
  expect(badSize.statusCode).toBe(400);
  const badKey = await app.inject({ method: 'GET', url: `/artwork/rotate=90/${row.id}` });
  expect(badKey.statusCode).toBe(400);
});

test('GET /artwork/:id serves the original media (image snapshot)', async () => {
  const file = await storeImage(await testCard(), 'png');
  const row = await seedArt({ status: 'SUCCEEDED', file });

  const res = await app.inject({ method: 'GET', url: `/artwork/${row.id}` });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('image/png');
  // Original dimensions, untouched — in particular not the 500px square.
  const meta = await sharp(res.rawPayload).metadata();
  expect([meta.width, meta.height]).toEqual([800, 600]);
  expect(res.rawPayload).toMatchImageSnapshot({
    customSnapshotIdentifier: 'artwork-original',
  });
});

test('GET /artwork renders the avif 500px square (image snapshot)', async () => {
  const file = await storeImage(await testCard(), 'png');
  const row = await seedArt({ status: 'SUCCEEDED', file });

  const res = await app.inject({
    method: 'GET',
    url: `/artwork/format=avif&size=500/${row.id}`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('image/avif');
  expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  const meta = await sharp(res.rawPayload).metadata();
  expect([meta.width, meta.height]).toEqual([500, 500]);
  // The matcher diffs PNGs, so decode the AVIF; the threshold absorbs minor encoder drift across libvips builds.
  const png = await sharp(res.rawPayload).png().toBuffer();
  expect(png).toMatchImageSnapshot({
    customSnapshotIdentifier: 'artwork-avif-square',
    failureThreshold: 1,
    failureThresholdType: 'percent',
  });
});

test('GET /artwork keeps avif at the original dimensions without a size option', async () => {
  const file = await storeImage(await testCard(), 'png');
  const row = await seedArt({ status: 'SUCCEEDED', file });

  const res = await app.inject({ method: 'GET', url: `/artwork/format=avif/${row.id}` });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('image/avif');
  const meta = await sharp(res.rawPayload).metadata();
  expect([meta.width, meta.height]).toEqual([800, 600]);
});
