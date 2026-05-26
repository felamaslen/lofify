import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { signPlaybackUrl } from './sign.js';
import { _resetTranscodeCache } from './transcode.js';

const spawnChunkedEncoderMock = vi.hoisted(() => vi.fn());
vi.mock('./ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ffmpeg.js')>();
  return { ...actual, spawnChunkedEncoder: spawnChunkedEncoderMock };
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
  spawnChunkedEncoderMock.mockReset();
});

/** A controllable fake chunked encoder. Captures the outDir + target on first call so tests can write fake init + chunk files into it. */
function fakeEncoder(): {
  waitForStart: () => Promise<string>;
  writeInit: (data: Buffer | string) => Promise<void>;
  writeChunk: (segIndex: number, data: Buffer | string) => Promise<void>;
  finish: () => void;
  fail: (err: Error) => void;
} {
  let outDir: string | null = null;
  let target: { format: { container: 'mp4' | 'mp3' } } | null = null;
  let onStart: ((dir: string) => void) | null = null;
  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  spawnChunkedEncoderMock.mockImplementation(
    (_source: string, t: { format: { container: 'mp4' | 'mp3' } }, dir: string) => {
      outDir = dir;
      target = t;
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
      if (!outDir || !target) throw new Error('encoder has not started');
      if (target.format.container !== 'mp4') throw new Error('init segment only exists for mp4');
      await writeFile(path.join(outDir, 'init.mp4'), data);
    },
    writeChunk: async (segIndex, data) => {
      if (!outDir || !target) throw new Error('encoder has not started');
      const ext = target.format.container === 'mp4' ? 'm4s' : 'mp3';
      // DASH muxer numbers from 1; mp3 segment muxer numbers from 0.
      const idx = target.format.container === 'mp4' ? segIndex + 1 : segIndex;
      const name = `chunk-${String(idx).padStart(5, '0')}.${ext}`;
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
      sourceMtime: st.mtime,
    })
    .returning({ id: tracks.id });
  return row!.id;
}

const ACCEPT_FLAC_MP4 = 'audio/flac, audio/mp4';
const ACCEPT_MP4 = 'audio/mp4';
const ACCEPT_MPEG_MP4 = 'audio/mpeg, audio/mp4';
const ACCEPT_MPEG = 'audio/mpeg';

test('passthrough — flac source served as audio/flac when client accepts it', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null });

  const res = await app.inject({ method: 'GET', url, headers: { accept: ACCEPT_FLAC_MP4 } });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/flac');
  expect(res.headers['accept-ranges']).toBe('bytes');

  const expected = await readFile(SAMPLE_FLAC);
  expect(res.headers['content-length']).toBe(String(expected.length));
  expect(res.rawPayload.equals(expected)).toBe(true);
});

test('passthrough — honours Range with 206 Partial Content', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null });

  const res = await app.inject({
    method: 'GET',
    url,
    headers: { accept: ACCEPT_FLAC_MP4, range: 'bytes=10-49' },
  });
  expect(res.statusCode).toBe(206);
  expect(res.headers['content-length']).toBe('40');

  const expected = (await readFile(SAMPLE_FLAC)).subarray(10, 50);
  const total = (await stat(SAMPLE_FLAC)).size;
  expect(res.headers['content-range']).toBe(`bytes 10-49/${total}`);
  expect(res.rawPayload.equals(expected)).toBe(true);
});

test('transcode — mp4 chunk 0 splices the init segment in front of chunk-00001.m4s', async () => {
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 60,
  });
  // Lossy-target client (no flac in Accept) — server encodes to mp4/opus.
  const url = `${signPlaybackUrl(id, { quality: null })}/0`;

  const pending = app.inject({
    method: 'GET',
    url,
    headers: { accept: ACCEPT_MP4, origin: 'http://localhost:5173' },
  });
  await enc.waitForStart();
  await enc.writeInit('INIT');
  await enc.writeChunk(0, 'C0');

  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="opus"');
  expect(res.headers['x-lofify-segments']).toBe('10');
  expect(res.headers['x-lofify-segment-duration']).toBe('6');
  expect(res.headers['x-lofify-duration']).toBe('60');
  expect(res.headers['x-lofify-ready-chunks']).toBe('1');
  expect(res.headers['access-control-expose-headers']).toContain('X-Lofify-Ready-Chunks');
  expect(res.rawPayload.toString()).toBe('INITC0');
});

test('transcode — mp4 chunk N>0 serves only chunk-(N+1).m4s', async () => {
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 60,
  });
  const url = `${signPlaybackUrl(id, { quality: null })}/3`;

  const pending = app.inject({ method: 'GET', url, headers: { accept: ACCEPT_MP4 } });
  await enc.waitForStart();
  await enc.writeInit('INIT');
  for (let i = 0; i <= 3; i++) await enc.writeChunk(i, `C${i}`);

  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(res.rawPayload.toString()).toBe('C3');
});

test('transcode — mp3 chunk has no init splice; chunk-00000.mp3 is served verbatim', async () => {
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_MP3,
    format: 'mp3',
    codec: 'mp3',
    isLossless: false,
    durationSeconds: 60,
  });
  // Accept lists audio/mpeg first → server picks mp3 as the encode target.
  const url = `${signPlaybackUrl(id, { quality: 'medium' })}/0`;

  const pending = app.inject({ method: 'GET', url, headers: { accept: ACCEPT_MPEG_MP4 } });
  await enc.waitForStart();
  await enc.writeChunk(0, 'MP3-0');

  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mpeg');
  expect(res.rawPayload.toString()).toBe('MP3-0');
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
  const url = `${signPlaybackUrl(id, { quality: null })}/2`;

  const pending = app.inject({ method: 'GET', url, headers: { accept: ACCEPT_MP4 } });
  await enc.waitForStart();
  await enc.writeInit('INIT');
  await enc.writeChunk(0, 'C0');
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
  fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 12,
  });
  const url = `${signPlaybackUrl(id, { quality: null })}/5`;

  const res = await app.inject({ method: 'GET', url, headers: { accept: ACCEPT_MP4 } });
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
  const url = signPlaybackUrl(id, { quality: null });

  const res = await app.inject({
    method: 'HEAD',
    url,
    headers: { accept: ACCEPT_MP4, origin: 'http://localhost:5173' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="opus"');
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
  const url = `${signPlaybackUrl(id, { quality: null })}/0`;

  const first = app.inject({ method: 'GET', url, headers: { accept: ACCEPT_MP4 } });
  await enc.waitForStart();
  await enc.writeInit('INIT');
  await enc.writeChunk(0, 'C0');
  await first;
  await app.inject({ method: 'GET', url, headers: { accept: ACCEPT_MP4 } });

  expect(spawnChunkedEncoderMock).toHaveBeenCalledTimes(1);
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
    headers: { accept: ACCEPT_MP4 },
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
  const res = await app.inject({
    method: 'GET',
    url: `/play/${sig}/${payload}`,
    headers: { accept: ACCEPT_MP4 },
  });
  expect(res.statusCode).toBe(400);
});

test('rejects requests with no Accept header (406)', async () => {
  const id = await seedTrack({
    file: SAMPLE_MP3,
    format: 'mp3',
    codec: 'mp3',
    isLossless: false,
  });
  const url = signPlaybackUrl(id, { quality: null });
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(406);
});

test('rejects requests with an unsupported Accept value (406)', async () => {
  const id = await seedTrack({
    file: SAMPLE_MP3,
    format: 'mp3',
    codec: 'mp3',
    isLossless: false,
  });
  const url = signPlaybackUrl(id, { quality: null });
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { accept: 'audio/ogg' },
  });
  expect(res.statusCode).toBe(406);
});

test('rejects audio/flac with no fallback (406)', async () => {
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
  });
  const url = signPlaybackUrl(id, { quality: null });
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { accept: 'audio/flac' },
  });
  expect(res.statusCode).toBe(406);
});

test('lossy source with audio/flac+audio/mp4 Accept → encodes mp4 at max quality', async () => {
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_MP3,
    format: 'mp3',
    codec: 'mp3',
    isLossless: false,
    durationSeconds: 60,
  });
  const url = `${signPlaybackUrl(id, { quality: null })}/0`;

  const pending = app.inject({ method: 'GET', url, headers: { accept: ACCEPT_FLAC_MP4 } });
  await enc.waitForStart();
  await enc.writeInit('INIT');
  await enc.writeChunk(0, 'C0');

  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mp4; codecs="opus"');
});

test('rejects Accept=audio/mpeg only when source is non-mp3 lossy with no other fallback (still encodes mp3)', async () => {
  // The route does not refuse audio/mpeg alone — it's a valid first-format request, server encodes mp3.
  const enc = fakeEncoder();
  const id = await seedTrack({
    file: SAMPLE_FLAC,
    format: 'flac',
    codec: 'flac',
    isLossless: true,
    durationSeconds: 60,
  });
  const url = `${signPlaybackUrl(id, { quality: 'low' })}/0`;
  const pending = app.inject({ method: 'GET', url, headers: { accept: ACCEPT_MPEG } });
  await enc.waitForStart();
  await enc.writeChunk(0, 'MP3-0');
  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/mpeg');
});
