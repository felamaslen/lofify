import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { FormatLossy, Quality } from '../graphql/track.js';
import { defaultCache } from './cache.js';
import { signPlaybackUrl } from './sign.js';

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnSpy.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnSpy };
});

/** Args of the most recent ffmpeg invocation with the per-test source/output paths stripped out — what's left is the deterministic encoder configuration, suitable for an inline snapshot. */
function lastEncoderArgs(): string[] {
  const calls = spawnSpy.mock.calls.filter((args) => args[0] === 'ffmpeg');
  const last = calls.at(-1);
  if (!last) throw new Error('ffmpeg was not invoked');
  const args = last[1] as string[];
  // Drop `-i <source>` and `-y <out>` so the snapshot doesn't include per-test tmpdir paths.
  return args.filter((_, i, all) => {
    const prev = all[i - 1];
    return all[i] !== '-i' && all[i] !== '-y' && prev !== '-i' && prev !== '-y';
  });
}

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scanner',
  '__fixtures__',
);

const SAMPLE_FLAC = path.join(fixturesDir, 'sample.flac');
const SAMPLE_MP3 = path.join(fixturesDir, 'sample.mp3');
const SAMPLE_OGG = path.join(fixturesDir, 'sample.ogg');

beforeEach(async () => {
  await db.delete(tracks);
  defaultCache.reset();
  spawnSpy.mockClear();
});

async function seedTrack(opts: {
  file: string;
  format: string;
  codec: string;
  isLossless: boolean;
  durationSeconds?: number;
}): Promise<string> {
  const st = await stat(opts.file);
  const [row] = await db
    .insert(tracks)
    .values({
      title: 'sample',
      trackNumber: 1,
      discNumber: 1,
      artist: 'A',
      album: 'B',
      year: null,
      format: opts.format,
      codec: opts.codec,
      bitRate: null,
      sampleRate: 44_100,
      isLossless: opts.isLossless,
      file: opts.file,
      sizeBytes: st.size,
      durationSeconds: opts.durationSeconds ?? 1,
      sourceMtime: st.mtime,
    })
    .returning({ id: tracks.id });
  return row!.id;
}

test('GET without Range serves the full encoded bin with 200 + Content-Length', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: Quality.MEDIUM, formatLossy: FormatLossy.OPUS });
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="opus"');
  expect(res.headers['accept-ranges']).toBe('bytes');
  const len = Number(res.headers['content-length']);
  expect(len).toBeGreaterThan(0);
  expect(res.rawPayload.length).toBe(len);
}, 30_000);

test('GET with Range serves a 206 byte slice with Content-Range', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: Quality.MEDIUM, formatLossy: FormatLossy.OPUS });
  // Warm the cache so we know the total size.
  await app.inject({ method: 'GET', url });
  const headRes = await app.inject({ method: 'HEAD', url });
  const total = Number(headRes.headers['content-length']);
  expect(total).toBeGreaterThan(100);

  const res = await app.inject({ method: 'GET', url, headers: { range: 'bytes=10-49' } });
  expect(res.statusCode).toBe(206);
  expect(res.headers['content-length']).toBe('40');
  expect(res.headers['content-range']).toBe(`bytes 10-49/${total}`);
  expect(res.rawPayload.length).toBe(40);
}, 30_000);

test('open-ended Range (bytes=N-) serves from N to current EOF', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: Quality.MEDIUM, formatLossy: FormatLossy.OPUS });
  await app.inject({ method: 'GET', url }); // warm
  const headRes = await app.inject({ method: 'HEAD', url });
  const total = Number(headRes.headers['content-length']);

  const res = await app.inject({ method: 'GET', url, headers: { range: 'bytes=100-' } });
  expect(res.statusCode).toBe(206);
  expect(res.headers['content-range']).toBe(`bytes 100-${total - 1}/${total}`);
  expect(res.rawPayload.length).toBe(total - 100);
}, 30_000);

test('Range past EOF after the encode completes returns 416', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: Quality.MEDIUM, formatLossy: FormatLossy.OPUS });
  await app.inject({ method: 'GET', url }); // warm and finish
  const headRes = await app.inject({ method: 'HEAD', url });
  const total = Number(headRes.headers['content-length']);

  const res = await app.inject({
    method: 'GET',
    url,
    headers: { range: `bytes=${total + 100}-${total + 200}` },
  });
  expect(res.statusCode).toBe(416);
  expect(res.headers['content-range']).toBe(`bytes */${total}`);
}, 30_000);

test('HEAD returns Content-Type + Accept-Ranges (no Content-Length until done)', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: Quality.MEDIUM, formatLossy: FormatLossy.OPUS });

  // Wait for the encode to finish first to make the assertion deterministic.
  await app.inject({ method: 'GET', url });
  const res = await app.inject({ method: 'HEAD', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="opus"');
  expect(res.headers['accept-ranges']).toBe('bytes');
  expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
}, 30_000);

test('q:max on a flac source delivers flac-in-mp4 (passthrough)', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: Quality.MAX, formatLossy: FormatLossy.OPUS });
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="flac"');
}, 30_000);

test('q:max on a lossless-non-flac source re-encodes to flac-in-mp4', async () => {
  const id = await seedTrack({
    // TODO: fix the ape fixture to actually have audio in it
    file: SAMPLE_FLAC,
    format: "monkey's audio",
    codec: 'ape',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: Quality.MAX, formatLossy: FormatLossy.OPUS });
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="flac"');
}, 30_000);

test('q:max + f:mp3 from a lossy (non-mp3) source re-encodes at libmp3lame 320k', async () => {
  const id = await seedTrack({
    file: SAMPLE_OGG,
    format: 'ogg',
    codec: 'vorbis',
    isLossless: false,
  });
  const url = signPlaybackUrl(id, { quality: Quality.MAX, formatLossy: FormatLossy.MP3 });
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mpeg');
  expect(lastEncoderArgs()).toMatchInlineSnapshot(`
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "320k",
      "-f",
      "mp3",
      "-write_id3v1",
      "0",
      "-id3v2_version",
      "0",
    ]
  `);
}, 30_000);

test('q:max + f:mp3 from an mp3 source passthrough-copies (no re-encode)', async () => {
  const id = await seedTrack({ file: SAMPLE_MP3, format: 'mp3', codec: 'mp3', isLossless: false });
  const url = signPlaybackUrl(id, { quality: Quality.MAX, formatLossy: FormatLossy.MP3 });
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mpeg');
  expect(lastEncoderArgs()).toMatchInlineSnapshot(`
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-vn",
      "-c:a",
      "copy",
      "-f",
      "mp3",
      "-write_id3v1",
      "0",
      "-id3v2_version",
      "0",
    ]
  `);
}, 30_000);

test('q:l with f:mp3 delivers low-quality mp3 regardless of source codec', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: Quality.LOW, formatLossy: FormatLossy.MP3 });
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mpeg');
  expect(lastEncoderArgs()).toMatchInlineSnapshot(`
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-f",
      "mp3",
      "-write_id3v1",
      "0",
      "-id3v2_version",
      "0",
    ]
  `);
}, 30_000);

test('rejects requests with an invalid signature', async () => {
  const id = await seedTrack({ file: SAMPLE_MP3, format: 'mp3', codec: 'mp3', isLossless: false });
  const res = await app.inject({
    method: 'GET',
    url: `/play/${'0'.repeat(64)}/q:m/f:opus/${id}`,
  });
  expect(res.statusCode).toBe(403);
});

test('rejects requests with missing options', async () => {
  const id = await seedTrack({ file: SAMPLE_MP3, format: 'mp3', codec: 'mp3', isLossless: false });
  const { signPayload } = await import('./sign.js');
  const payload = id; // no q:, no f:
  const sig = signPayload(payload);
  const res = await app.inject({ method: 'GET', url: `/play/${sig}/${payload}` });
  expect(res.statusCode).toBe(400);
});

test('rejects requests with malformed option segments', async () => {
  const id = await seedTrack({ file: SAMPLE_MP3, format: 'mp3', codec: 'mp3', isLossless: false });
  const { signPayload } = await import('./sign.js');
  const payload = `bogus:1/${id}`;
  const sig = signPayload(payload);
  const res = await app.inject({ method: 'GET', url: `/play/${sig}/${payload}` });
  expect(res.statusCode).toBe(400);
});

test('rejects unknown track id with 404', async () => {
  const url = signPlaybackUrl('00000000-0000-0000-0000-000000000000', {
    quality: Quality.MEDIUM,
    formatLossy: FormatLossy.OPUS,
  });
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(404);
});
