import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { signPlaybackUrl } from './sign.js';
import { _resetTranscodeCache, type Entry } from './transcode.js';

const runFfmpegMock = vi.hoisted(() => vi.fn());
vi.mock('./ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ffmpeg.js')>();
  return { ...actual, runFfmpeg: runFfmpegMock };
});

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scanner',
  '__fixtures__',
);

const SAMPLE_MP3 = path.join(fixturesDir, 'sample.mp3');
const SAMPLE_FLAC = path.join(fixturesDir, 'sample.flac');

beforeEach(async () => {
  await db.delete(tracks);
  _resetTranscodeCache();
  const actual = await vi.importActual<typeof import('./ffmpeg.js')>('./ffmpeg.js');
  runFfmpegMock.mockReset();
  runFfmpegMock.mockImplementation(actual.runFfmpeg);
});

function createFakeTranscode(): {
  emit: (data: Buffer | string) => void;
  finish: () => void;
  fail: (err: Error) => void;
  waitForStart: () => Promise<void>;
} {
  let entry: Entry | null = null;
  let resolveDone: (() => void) | null = null;
  let rejectDone: ((err: Error) => void) | null = null;
  let onStart: (() => void) | null = null;
  runFfmpegMock.mockImplementation((e: Entry) => {
    entry = e;
    onStart?.();
    return new Promise<void>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
  });
  return {
    emit: (data) => {
      if (!entry) throw new Error('no transcode in flight');
      const chunk = typeof data === 'string' ? Buffer.from(data) : data;
      entry.chunks.push(chunk);
      entry.bytes += chunk.length;
      entry.lastAccess = Date.now();
      entry.emitter.emit('chunk', chunk);
    },
    finish: () => resolveDone?.(),
    fail: (err) => rejectDone?.(err),
    waitForStart: () =>
      new Promise<void>((resolve) => {
        if (entry) resolve();
        else onStart = resolve;
      }),
  };
}

async function seedTrack(opts: {
  id?: string;
  file: string;
  format: string;
  codec: string;
  isLossless: boolean;
}): Promise<string> {
  const st = await stat(opts.file);
  const [row] = await db
    .insert(tracks)
    .values({
      ...(opts.id ? { id: opts.id } : {}),
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
      durationSeconds: 1,
    })
    .returning({ id: tracks.id });
  return row!.id;
}

test('passthrough — serves the full source file', async () => {
  const id = await seedTrack({
    file: SAMPLE_MP3,
    format: 'mp3',
    codec: 'mp3',
    isLossless: false,
  });
  const url = signPlaybackUrl(id, { quality: null, format: null });

  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mpeg');
  expect(res.headers['accept-ranges']).toBe('bytes');

  const expected = await readFile(SAMPLE_MP3);
  expect(res.headers['content-length']).toBe(String(expected.length));
  expect(res.rawPayload.equals(expected)).toBe(true);
});

test('passthrough — honours Range with 206 Partial Content', async () => {
  const id = await seedTrack({
    file: SAMPLE_MP3,
    format: 'mp3',
    codec: 'mp3',
    isLossless: false,
  });
  const url = signPlaybackUrl(id, { quality: null, format: null });

  const res = await app.inject({
    method: 'GET',
    url,
    headers: { range: 'bytes=10-49' },
  });
  expect(res.statusCode).toBe(206);
  expect(res.headers['content-length']).toBe('40');

  const expected = (await readFile(SAMPLE_MP3)).subarray(10, 50);
  const total = (await stat(SAMPLE_MP3)).size;
  expect(res.headers['content-range']).toBe(`bytes 10-49/${total}`);
  expect(res.rawPayload.equals(expected)).toBe(true);
});

test('transcode — streams a converted body', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null, format: 'ogg' });

  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/ogg; codecs=vorbis');
  expect(res.rawPayload.length).toBeGreaterThan(0);
  expect(res.rawPayload.subarray(0, 4).toString('ascii')).toBe('OggS');
}, 30_000);

test('transcode — no range streams the full body as 200', async () => {
  const fake = createFakeTranscode();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null, format: 'ogg' });

  const pending = app.inject({ method: 'GET', url });
  await fake.waitForStart();
  fake.emit('hello');
  fake.emit('world');
  fake.finish();

  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/ogg; codecs=vorbis');
  expect(res.headers['accept-ranges']).toBe('bytes');
  expect(res.headers['content-range']).toBeUndefined();
  expect(res.rawPayload.toString()).toBe('helloworld');
});

test('transcode — Range: bytes=0- returns 206 with full known range once done', async () => {
  const fake = createFakeTranscode();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null, format: 'ogg' });

  const pending = app.inject({ method: 'GET', url, headers: { range: 'bytes=0-' } });
  await fake.waitForStart();
  const body = Buffer.alloc(1000, 0x42);
  fake.emit(body);
  fake.finish();

  const res = await pending;
  expect(res.statusCode).toBe(206);
  expect(res.headers['content-type']).toBe('audio/ogg; codecs=vorbis');
  expect(res.headers['accept-ranges']).toBe('bytes');
  expect(res.headers['content-range']).toBe('bytes 0-999/1000');
  expect(res.headers['content-length']).toBe('1000');
  expect(res.rawPayload.equals(body)).toBe(true);
});

test('transcode — Range: bytes=0- mid-transcode returns 206 with unknown total', async () => {
  const fake = createFakeTranscode();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null, format: 'ogg' });

  const pending = app.inject({ method: 'GET', url, headers: { range: 'bytes=0-' } });
  await fake.waitForStart();

  const body = Buffer.alloc(256 * 1024, 0x37);
  fake.emit(body);

  const res = await pending;
  expect(res.statusCode).toBe(206);
  expect(res.headers['content-range']).toBe(`bytes 0-${body.length - 1}/*`);
  expect(res.headers['content-length']).toBe(String(body.length));
  expect(res.rawPayload.equals(body)).toBe(true);

  fake.finish();
});

test('transcode — seek into already-transcoded area serves 206 immediately', async () => {
  const fake = createFakeTranscode();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null, format: 'ogg' });

  const initial = app.inject({ method: 'GET', url });
  await fake.waitForStart();

  const body = Buffer.alloc(1000);
  for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
  fake.emit(body);

  const seek = await app.inject({
    method: 'GET',
    url,
    headers: { range: 'bytes=500-700' },
  });
  expect(seek.statusCode).toBe(206);
  expect(seek.headers['content-range']).toBe('bytes 500-700/*');
  expect(seek.headers['content-length']).toBe('201');
  expect(seek.rawPayload.equals(body.subarray(500, 701))).toBe(true);

  fake.finish();
  await initial;
});

test('transcode — seek into not-yet-transcoded area waits for the bytes', async () => {
  const fake = createFakeTranscode();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null, format: 'ogg' });

  const initial = app.inject({ method: 'GET', url });
  await fake.waitForStart();

  const head = Buffer.alloc(100, 0xaa);
  fake.emit(head);

  const seek = app.inject({
    method: 'GET',
    url,
    headers: { range: 'bytes=500-700' },
  });
  let settled = false;
  void seek.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(settled).toBe(false);

  const tail = Buffer.alloc(700, 0xbb);
  fake.emit(tail);

  const res = await seek;
  expect(res.statusCode).toBe(206);
  expect(res.headers['content-range']).toBe('bytes 500-700/*');
  expect(res.headers['content-length']).toBe('201');
  const full = Buffer.concat([head, tail]);
  expect(res.rawPayload.equals(full.subarray(500, 701))).toBe(true);

  fake.finish();
  await initial;
});

test('transcode — range starting past EOF returns 416', async () => {
  const fake = createFakeTranscode();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null, format: 'ogg' });

  const initial = app.inject({ method: 'GET', url });
  await fake.waitForStart();
  fake.emit(Buffer.alloc(100, 0xaa));
  fake.finish();
  await initial;

  const res = await app.inject({
    method: 'GET',
    url,
    headers: { range: 'bytes=500-700' },
  });
  expect(res.statusCode).toBe(416);
  expect(res.headers['content-range']).toBe('bytes */100');
});

test('rejects requests with an invalid signature', async () => {
  const id = await seedTrack({
    file: SAMPLE_MP3,
    format: 'mp3',
    codec: 'mp3',
    isLossless: false,
  });

  const res = await app.inject({
    method: 'GET',
    url: `/play/${'0'.repeat(64)}/${id}`,
  });
  expect(res.statusCode).toBe(403);
});

test('rejects requests with malformed options', async () => {
  const id = await seedTrack({
    file: SAMPLE_MP3,
    format: 'mp3',
    codec: 'mp3',
    isLossless: false,
  });
  // Build a payload with an unknown option key, signed correctly so we
  // pass signature verification and trip the options parser instead.
  const { signPayload } = await import('./sign.js');
  const payload = `bogus:1/${id}`;
  const sig = signPayload(payload);
  const res = await app.inject({ method: 'GET', url: `/play/${sig}/${payload}` });
  expect(res.statusCode).toBe(400);
});
