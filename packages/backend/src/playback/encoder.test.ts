import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Quality } from '../graphql/track.js';
import { type EncodeTarget,spawnEncoder, targetKey } from './encoder.js';
import { makeMp3Scanner } from './scan-mp3.js';
import { mp4Scanner } from './scan-mp4.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scanner', '__fixtures__');
const SAMPLE_FLAC = path.join(FIXTURES, 'sample.flac');
const SAMPLE_MP3 = path.join(FIXTURES, 'sample.mp3');

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'encoder-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test('opus-in-mp4 from flac source: writes a single fragmented mp4 the mp4 scanner can walk', async () => {
  const out = path.join(workDir, 'opus.bin');
  const target: EncodeTarget = { format: { container: 'mp4', codec: 'opus' }, quality: Quality.MEDIUM };
  const handle = spawnEncoder({
    source: SAMPLE_FLAC,
    target,
    outPath: out,
    chunkDurationSeconds: 0.2,
  });
  await handle.done;
  const bytes = await readFile(out);
  expect(bytes.length).toBeGreaterThan(0);
  const r = mp4Scanner.scan(bytes, 0, true);
  expect(r.init).not.toBeNull();
  expect(r.init![0]).toBe(0);
  expect(r.init![1]).toBeGreaterThan(0);
  expect(r.chunks.length).toBeGreaterThanOrEqual(2);
}, 30_000);

test('flac-in-mp4 passthrough from flac source: yields a copy-muxed fmp4', async () => {
  const out = path.join(workDir, 'flac.bin');
  const target: EncodeTarget = { format: { container: 'mp4', codec: 'flac' }, quality: Quality.MAX };
  const handle = spawnEncoder({
    source: SAMPLE_FLAC,
    target,
    outPath: out,
    chunkDurationSeconds: 0.2,
    passthrough: true,
  });
  await handle.done;
  const bytes = await readFile(out);
  expect(bytes.length).toBeGreaterThan(0);
  const r = mp4Scanner.scan(bytes, 0, true);
  expect(r.init).not.toBeNull();
  // Flac source ≈ 1 s; at 0.2 s/frag we should get several fragments.
  expect(r.chunks.length).toBeGreaterThanOrEqual(2);
}, 30_000);

test('mp3 from flac source: writes a frame stream the mp3 scanner can walk', async () => {
  const out = path.join(workDir, 'mp3.bin');
  const target: EncodeTarget = { format: { container: 'mp3', codec: 'mp3' }, quality: Quality.MEDIUM };
  const handle = spawnEncoder({
    source: SAMPLE_FLAC,
    target,
    outPath: out,
    chunkDurationSeconds: 0.2,
  });
  await handle.done;
  const bytes = await readFile(out);
  expect(bytes.length).toBeGreaterThan(0);
  const r = makeMp3Scanner(0.2).scan(bytes, 0, true);
  expect(r.init).toBeNull();
  expect(r.chunks.length).toBeGreaterThanOrEqual(2);
  // Cumulative duration should match the source (roughly — last frame may overshoot).
  const totalSamples = r.chunks.reduce((acc, c) => acc + (c.rawDuration ?? 0), 0);
  const total = totalSamples / r.timescale!;
  expect(total).toBeGreaterThanOrEqual(0.9);
  expect(total).toBeLessThanOrEqual(1.2);
}, 30_000);

test('mp3 passthrough from mp3 source: copy-muxes without re-encoding', async () => {
  const out = path.join(workDir, 'mp3-copy.bin');
  const target: EncodeTarget = { format: { container: 'mp3', codec: 'mp3' }, quality: Quality.MEDIUM };
  const handle = spawnEncoder({
    source: SAMPLE_MP3,
    target,
    outPath: out,
    chunkDurationSeconds: 0.2,
    passthrough: true,
  });
  await handle.done;
  const bytes = await readFile(out);
  expect(bytes.length).toBeGreaterThan(0);
  const r = makeMp3Scanner(0.2).scan(bytes, 0, true);
  expect(r.chunks.length).toBeGreaterThanOrEqual(2);
}, 30_000);

test('kill() terminates the encoder and resolves done without throwing', async () => {
  const out = path.join(workDir, 'killed.bin');
  const handle = spawnEncoder({
    source: SAMPLE_FLAC,
    target: { format: { container: 'mp4', codec: 'opus' }, quality: Quality.MEDIUM },
    outPath: out,
    chunkDurationSeconds: 0.2,
  });
  handle.kill();
  await expect(handle.done).resolves.toBeUndefined();
}, 30_000);

test('targetKey() produces a stable filesystem-safe key per (codec, quality)', () => {
  expect(
    targetKey({ format: { container: 'mp4', codec: 'opus' }, quality: Quality.HIGH }),
  ).toBe('f-opus_q-high');
  expect(
    targetKey({ format: { container: 'mp4', codec: 'flac' }, quality: Quality.MAX }),
  ).toBe('f-flac_q-max');
  expect(
    targetKey({ format: { container: 'mp3', codec: 'mp3' }, quality: Quality.LOW }),
  ).toBe('f-mp3_q-low');
});
