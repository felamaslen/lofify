import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { signPlaybackUrl } from './sign.js';
import { _resetTranscodeCache } from './transcode.js';

const spawnDashEncoderMock = vi.hoisted(() => vi.fn());
vi.mock('./ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ffmpeg.js')>();
  return { ...actual, spawnDashEncoder: spawnDashEncoderMock };
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
  spawnDashEncoderMock.mockReset();
});

/** A controllable fake DASH encoder. Captures the outDir on first call so tests can write fake init + chunk files into it, and exposes hooks to resolve/reject the job. */
function fakeEncoder(): {
  waitForStart: () => Promise<string>;
  writeInit: (data: Buffer | string) => Promise<void>;
  writeChunk: (segIndex: number, data: Buffer | string) => Promise<void>;
  finish: () => void;
  fail: (err: Error) => void;
} {
  let outDir: string | null = null;
  let onStart: ((dir: string) => void) | null = null;
  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  spawnDashEncoderMock.mockImplementation(
    (_source: string, _target: unknown, dir: string) => {
      outDir = dir;
      onStart?.(dir);
      return {
        done: new Promise<void>((res, rej) => {
          resolveDone = res;
          rejectDone = rej;
        }),
        kill: () => undefined,
      };
    },
  );
  return {
    waitForStart: () =>
      new Promise<string>((resolve) => {
        if (outDir) resolve(outDir);
        else onStart = resolve;
      }),
    writeInit: async (data) => {
      if (!outDir) throw new Error('encoder has not started');
      await writeFile(path.join(outDir, 'init.webm'), data);
    },
    writeChunk: async (segIndex, data) => {
      if (!outDir) throw new Error('encoder has not started');
      const name = `chunk-${String(segIndex + 1).padStart(5, '0')}.webm`;
      await writeFile(path.join(outDir, name), data);
    },
    finish: () => resolveDone(),
    fail: (err) => rejectDone(err),
  };
}

async function seedTrack(opts: {
  id?: string;
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
      durationSeconds: opts.durationSeconds ?? 1,
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

test('transcode — chunk 0 splices the init segment in front of chunk 1 on disk', async () => {
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 60,
  });
  const url = `${signPlaybackUrl(id, { quality: null, format: 'webm' })}/0`;

  const pending = app.inject({
    method: 'GET',
    url,
    headers: { origin: 'http://localhost:5173' },
  });
  await enc.waitForStart();
  await enc.writeInit('INIT');
  await enc.writeChunk(0, 'C0');

  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/webm; codecs=opus');
  expect(res.headers['x-lofify-segments']).toBe('10');
  expect(res.headers['x-lofify-segment-duration']).toBe('6');
  expect(res.headers['x-lofify-duration']).toBe('60');
  expect(res.headers['x-lofify-ready-chunks']).toBe('1');
  expect(res.headers['access-control-expose-headers']).toContain('X-Lofify-Ready-Chunks');
  expect(res.rawPayload.toString()).toBe('INITC0');
});

test('transcode — chunk N>0 serves only chunk-(N+1).webm', async () => {
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 60,
  });
  const url = `${signPlaybackUrl(id, { quality: null, format: 'webm' })}/3`;

  const pending = app.inject({ method: 'GET', url });
  await enc.waitForStart();
  await enc.writeInit('INIT');
  for (let i = 0; i <= 3; i++) await enc.writeChunk(i, `C${i}`);

  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(res.rawPayload.toString()).toBe('C3');
});

test('transcode — request for not-yet-encoded chunk waits for the watcher', async () => {
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 60,
  });
  const url = `${signPlaybackUrl(id, { quality: null, format: 'webm' })}/2`;

  const pending = app.inject({ method: 'GET', url });
  await enc.waitForStart();
  await enc.writeInit('INIT');
  await enc.writeChunk(0, 'C0');
  // Inject hasn't resolved yet — chunks 1 and 2 are still missing.
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 350));
  expect(settled).toBe(false);

  await enc.writeChunk(1, 'C1');
  await enc.writeChunk(2, 'C2');

  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(res.rawPayload.toString()).toBe('C2');
  expect(res.headers['x-lofify-ready-chunks']).toBe('3');
});

test('transcode — chunk past expected track length returns 404', async () => {
  fakeEncoder(); // ffmpeg is invoked but the test never produces files
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 12, // 2 chunks → valid indices 0, 1
  });
  const url = `${signPlaybackUrl(id, { quality: null, format: 'webm' })}/5`;

  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(404);
});

test('transcode — HEAD probe returns metadata headers without waiting for chunks', async () => {
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 60,
  });
  const url = signPlaybackUrl(id, { quality: null, format: 'webm' });

  const res = await app.inject({
    method: 'HEAD',
    url,
    headers: { origin: 'http://localhost:5173' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/webm; codecs=opus');
  expect(res.headers['x-lofify-segments']).toBe('10');
  expect(res.headers['x-lofify-segment-duration']).toBe('6');
  expect(res.headers['x-lofify-duration']).toBe('60');
  expect(res.headers['x-lofify-ready-chunks']).toBe('0');
  expect(res.headers['access-control-expose-headers']).toContain('X-Lofify-Ready-Chunks');

  await enc.waitForStart();
});

test('transcode — second request for same chunk hits cache (no second ffmpeg spawn)', async () => {
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 60,
  });
  const url = `${signPlaybackUrl(id, { quality: null, format: 'webm' })}/0`;

  const first = app.inject({ method: 'GET', url });
  await enc.waitForStart();
  await enc.writeInit('INIT');
  await enc.writeChunk(0, 'C0');
  await first;
  await app.inject({ method: 'GET', url });

  expect(spawnDashEncoderMock).toHaveBeenCalledTimes(1);
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
  const { signPayload } = await import('./sign.js');
  const payload = `bogus:1/${id}`;
  const sig = signPayload(payload);
  const res = await app.inject({ method: 'GET', url: `/play/${sig}/${payload}` });
  expect(res.statusCode).toBe(400);
});

