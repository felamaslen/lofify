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

/** Seed a SUCCEEDED artwork row backed by a real file, returning its public URL — the source the asset route processes. */
async function seedArtworkUrl(bytes: Buffer): Promise<string> {
  const artworkDir = path.join(process.env.DISK_CACHE_DIR!, 'artwork');
  await mkdir(artworkDir, { recursive: true });
  const file = `${randomUUID()}.png`;
  await writeFile(path.join(artworkDir, file), bytes);
  const [row] = await db
    .insert(albumArt)
    .values({ albumArtist: 'Album Artist', album: 'The Album', status: 'SUCCEEDED', file })
    .returning();
  return `http://lofify.test/artwork/${row!.id}`;
}

test('GET /asset renders the avif 500px square of a same-origin source (image snapshot)', async () => {
  const source = await seedArtworkUrl(await testCard());

  // Mirrors the production URL shape, with the source's version riding the options as the cache-buster.
  const res = await app.inject({
    method: 'GET',
    url: `/asset/format=avif&size=500&v=1/${source}`,
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

test('GET /asset keeps the original dimensions without a size option, and the format without a format option', async () => {
  const source = await seedArtworkUrl(await testCard());

  const avifOnly = await app.inject({ method: 'GET', url: `/asset/format=avif/${source}` });
  expect(avifOnly.statusCode).toBe(200);
  expect(avifOnly.headers['content-type']).toBe('image/avif');
  const avifMeta = await sharp(avifOnly.rawPayload).metadata();
  expect([avifMeta.width, avifMeta.height]).toEqual([800, 600]);

  const sizeOnly = await app.inject({ method: 'GET', url: `/asset/size=500/${source}` });
  expect(sizeOnly.statusCode).toBe(200);
  expect(sizeOnly.headers['content-type']).toBe('image/png');
  const sizeMeta = await sharp(sizeOnly.rawPayload).metadata();
  expect([sizeMeta.width, sizeMeta.height]).toEqual([500, 500]);
});

test('GET /asset validates its options and source', async () => {
  const source = await seedArtworkUrl(await testCard());

  const badFormat = await app.inject({ method: 'GET', url: `/asset/format=webp/${source}` });
  expect(badFormat.statusCode).toBe(400);
  const badSize = await app.inject({ method: 'GET', url: `/asset/size=400/${source}` });
  expect(badSize.statusCode).toBe(400);
  const noTransform = await app.inject({ method: 'GET', url: `/asset/v=1/${source}` });
  expect(noTransform.statusCode).toBe(400);

  const crossOrigin = await app.inject({
    method: 'GET',
    url: '/asset/format=avif/https://example.com/cat.png',
  });
  expect(crossOrigin.statusCode).toBe(400);

  const notAUrl = await app.inject({ method: 'GET', url: '/asset/format=avif/not-a-url' });
  expect(notAUrl.statusCode).toBe(400);
});

test('GET /asset 404s without caching when the source does not resolve', async () => {
  const missing = await app.inject({
    method: 'GET',
    url: '/asset/format=avif/http://lofify.test/artwork/01934567-89ab-7cde-8123-000000000000',
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.headers['cache-control']).toBe('no-store');
});

test('a new source version is a new render, and old versions stay cached', async () => {
  const source = await seedArtworkUrl(await testCard());
  const renderUrl = (v: number) => `/asset/size=500&v=${v}/${source}`;

  const first = await app.inject({ method: 'GET', url: renderUrl(1) });
  expect(first.statusCode).toBe(200);

  // Replace the image behind the (stable, no-store) original URL.
  const replacement = await sharp({
    create: { width: 600, height: 600, channels: 3, background: '#06c' },
  })
    .png()
    .toBuffer();
  const row = (await db.select().from(albumArt))[0]!;
  const artworkDir = path.join(process.env.DISK_CACHE_DIR!, 'artwork');
  await writeFile(path.join(artworkDir, row.file!), replacement);

  // The old version serves its cached render; the bumped version renders the new image.
  const cached = await app.inject({ method: 'GET', url: renderUrl(1) });
  expect(cached.rawPayload).toEqual(first.rawPayload);
  const fresh = await app.inject({ method: 'GET', url: renderUrl(2) });
  expect(fresh.statusCode).toBe(200);
  expect(fresh.rawPayload).not.toEqual(first.rawPayload);
});
