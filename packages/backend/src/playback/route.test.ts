import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { signPlaybackUrl } from './sign.js';
import { _resetTranscodeCache } from './transcode.js';

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
});

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
  const url = signPlaybackUrl(id, { quality: null, format: 'OGG' });

  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('audio/ogg; codecs=vorbis');
  expect(res.rawPayload.length).toBeGreaterThan(0);
  expect(res.rawPayload.subarray(0, 4).toString('ascii')).toBe('OggS');
}, 30_000);

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
