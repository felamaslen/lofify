import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { Quality } from '../graphql/track.js';
import { defaultCache } from './cache.js';
import type { EncodeFormat, EncodeTarget } from './encoder.js';
import { signPlaybackUrl } from './sign.js';

/** Build a resolved `EncodeTarget` to bake into a signed URL. The route decodes this verbatim — format resolution itself is covered by `resolve.test.ts`. */
function target(
  container: EncodeFormat['container'],
  codec: EncodeFormat['codec'],
  quality: Quality,
): EncodeTarget {
  return { format: { container, codec } as EncodeFormat, quality };
}

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
  const url = signPlaybackUrl(id, target('mp4', 'opus', Quality.MEDIUM));
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
  const url = signPlaybackUrl(id, target('mp4', 'opus', Quality.MEDIUM));
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
  const url = signPlaybackUrl(id, target('mp4', 'opus', Quality.MEDIUM));
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
  const url = signPlaybackUrl(id, target('mp4', 'opus', Quality.MEDIUM));
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
  const url = signPlaybackUrl(id, target('mp4', 'opus', Quality.MEDIUM));

  // Wait for the encode to finish first to make the assertion deterministic.
  await app.inject({ method: 'GET', url });
  const res = await app.inject({ method: 'HEAD', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="opus"');
  expect(res.headers['accept-ranges']).toBe('bytes');
  expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
}, 30_000);

test('every response varies on Range so caches do not cross-serve byte slices', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, target('mp4', 'opus', Quality.MEDIUM));
  const full = await app.inject({ method: 'GET', url });
  expect(full.statusCode).toBe(200);
  expect(full.headers['vary']).toBe('Range');

  const slice = await app.inject({ method: 'GET', url, headers: { range: 'bytes=10-49' } });
  expect(slice.statusCode).toBe(206);
  expect(slice.headers['vary']).toBe('Range');

  const head = await app.inject({ method: 'HEAD', url });
  expect(head.headers['vary']).toBe('Range');
}, 30_000);

test('fully-transcoded responses are cacheable, in-progress ones are not', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, target('mp4', 'opus', Quality.MEDIUM));

  // Hold the encoder open: ffmpeg writes the real .bin and exits, but we withhold its `close` event
  // from the encoder so the cache entry never reports `done`. That pins the entry in its
  // in-progress state for as long as we want, making the no-store assertions deterministic.
  const realSpawn = spawnSpy.getMockImplementation() as (
    ...args: unknown[]
  ) => ChildProcessWithoutNullStreams;
  let releaseClose: (() => void) | undefined;
  spawnSpy.mockImplementation((...callArgs: unknown[]) => {
    const child = realSpawn(...callArgs);
    if (callArgs[0] === 'ffmpeg') {
      const realOn = child.on.bind(child);
      const closeReleased = new Promise<void>((res) => {
        releaseClose = res;
      });
      child.on = ((event: string, listener: (...a: unknown[]) => void) =>
        event === 'close'
          ? realOn('close', (...a: unknown[]) => void closeReleased.then(() => listener(...a)))
          : realOn(event, listener)) as typeof child.on;
    }
    return child;
  });

  try {
    const slice = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-49' } });
    expect(slice.statusCode).toBe(206);
    expect(slice.headers['content-range']).toMatch(/\/\*$/); // total still unknown
    expect(slice.headers['cache-control']).toBe('no-store');

    const head = await app.inject({ method: 'HEAD', url });
    expect(head.headers['content-length']).toBeUndefined();
    expect(head.headers['cache-control']).toBe('no-store');
  } finally {
    releaseClose?.(); // let the encode complete
    spawnSpy.mockImplementation(realSpawn);
  }

  // Once the encode is done every response is immutable-cacheable.
  await app.inject({ method: 'GET', url }); // serveFull waits for done
  const full = await app.inject({ method: 'GET', url });
  expect(full.statusCode).toBe(200);
  expect(full.headers['cache-control']).toBe('public, max-age=31536000, immutable');

  const doneSlice = await app.inject({ method: 'GET', url, headers: { range: 'bytes=10-49' } });
  expect(doneSlice.statusCode).toBe(206);
  expect(doneSlice.headers['cache-control']).toBe('public, max-age=31536000, immutable');

  const doneHead = await app.inject({ method: 'HEAD', url });
  expect(doneHead.headers['cache-control']).toBe('public, max-age=31536000, immutable');
}, 30_000);

test('flac target on a flac source delivers flac-in-mp4 (passthrough)', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, target('mp4', 'flac', Quality.MAX));
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="flac"');
}, 30_000);

test('flac target on a lossless-non-flac source re-encodes to flac-in-mp4', async () => {
  const id = await seedTrack({
    // TODO: fix the ape fixture to actually have audio in it
    file: SAMPLE_FLAC,
    format: "monkey's audio",
    codec: 'ape',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, target('mp4', 'flac', Quality.MAX));
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="flac"');
}, 30_000);

test('mp3 target at max from a lossy (non-mp3) source re-encodes at libmp3lame 320k', async () => {
  const id = await seedTrack({
    file: SAMPLE_OGG,
    format: 'ogg',
    codec: 'vorbis',
    isLossless: false,
  });
  const url = signPlaybackUrl(id, target('mp3', 'mp3', Quality.MAX));
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

test('mp3 target from an mp3 source passthrough-copies (no re-encode)', async () => {
  const id = await seedTrack({ file: SAMPLE_MP3, format: 'mp3', codec: 'mp3', isLossless: false });
  const url = signPlaybackUrl(id, target('mp3', 'mp3', Quality.MAX));
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

test('webm/vorbis target on a vorbis source passthrough-copies (no re-encode)', async () => {
  const id = await seedTrack({
    file: SAMPLE_OGG,
    format: 'ogg',
    codec: 'vorbis',
    isLossless: false,
  });
  const url = signPlaybackUrl(id, target('webm', 'vorbis', Quality.MAX));
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/webm; codecs="vorbis"');
  expect(lastEncoderArgs()).toMatchInlineSnapshot(`
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-vn",
      "-c:a",
      "copy",
      "-f",
      "webm",
      "-dash",
      "1",
      "-dash_track_number",
      "1",
      "-cluster_time_limit",
      "6000",
    ]
  `);
}, 30_000);

test('webm/opus target on a vorbis source transcodes with libopus', async () => {
  const id = await seedTrack({
    file: SAMPLE_OGG,
    format: 'ogg',
    codec: 'vorbis',
    isLossless: false,
  });
  const url = signPlaybackUrl(id, target('webm', 'opus', Quality.MAX));
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/webm; codecs="opus"');
  expect(lastEncoderArgs()).toMatchInlineSnapshot(`
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      "256k",
      "-vbr",
      "on",
      "-application",
      "audio",
      "-af",
      "aresample=resampler=soxr:precision=28:dither_method=triangular_hp",
      "-ar",
      "48000",
      "-f",
      "webm",
      "-dash",
      "1",
      "-dash_track_number",
      "1",
      "-cluster_time_limit",
      "6000",
    ]
  `);
}, 30_000);

test('low-quality mp3 target delivers libmp3lame 128k regardless of source codec', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, target('mp3', 'mp3', Quality.LOW));
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
  const payload = id; // no option segments
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
  const url = signPlaybackUrl(
    '00000000-0000-0000-0000-000000000000',
    target('mp4', 'opus', Quality.MEDIUM),
  );
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(404);
});
