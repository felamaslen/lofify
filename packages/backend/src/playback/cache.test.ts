import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Cache, createCache } from './cache.js';
import { targetKey } from './encoder.js';

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnSpy.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnSpy };
});

function ffmpegSpawnCalls(): number {
  return spawnSpy.mock.calls.filter((args) => args[0] === 'ffmpeg').length;
}

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scanner',
  '__fixtures__',
);
const SAMPLE_FLAC = path.join(FIXTURES, 'sample.flac');

let workDir: string;
let cache: Cache;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'cache-test-'));
  cache = createCache({ cacheRoot: workDir, chunkDurationSeconds: 0.2 });
  spawnSpy.mockClear();
});

afterEach(async () => {
  cache.reset();
  await rm(workDir, { recursive: true, force: true });
});

const FLAC_MTIME = new Date('2026-01-01T00:00:00Z');

function flacReq(): Parameters<Cache['getOrStart']>[0] {
  return {
    trackId: 'track-uuid-001',
    sourceMtime: FLAC_MTIME,
    sourcePath: SAMPLE_FLAC,
    sourceCodec: 'flac',
    target: { format: { container: 'mp4', codec: 'opus' }, quality: 'medium' },
  };
}

test('cold cache: spawns encoder, .bin and .idx land on disk, isDone goes true', async () => {
  const entry = await cache.getOrStart(flacReq());
  // The .bin path the entry exposes lives under the configured cache root.
  expect(entry.binPath.startsWith(workDir)).toBe(true);
  await entry.waitForEncoded(Number.POSITIVE_INFINITY);
  expect(entry.isDone()).toBe(true);
  expect(entry.error()).toBeNull();
  const st = await stat(entry.binPath);
  expect(st.size).toBeGreaterThan(0);
  const idxPath = entry.binPath.replace(/\.bin$/, '.idx');
  const idx = JSON.parse(await readFile(idxPath, 'utf8')) as { done: boolean; chunks: unknown[] };
  expect(idx.done).toBe(true);
  expect(idx.chunks.length).toBeGreaterThanOrEqual(2);
}, 30_000);

test('concurrent calls for the same key spawn ffmpeg exactly once', async () => {
  const [a, b] = await Promise.all([cache.getOrStart(flacReq()), cache.getOrStart(flacReq())]);
  await Promise.all([
    a.waitForEncoded(Number.POSITIVE_INFINITY),
    b.waitForEncoded(Number.POSITIVE_INFINITY),
  ]);
  expect(ffmpegSpawnCalls()).toBe(1);
  expect(a.isDone()).toBe(true);
  expect(b.isDone()).toBe(true);
}, 30_000);

test('warm-cache hit: second getOrStart after completion does not re-spawn ffmpeg', async () => {
  const first = await cache.getOrStart(flacReq());
  await first.waitForEncoded(Number.POSITIVE_INFINITY);
  expect(ffmpegSpawnCalls()).toBe(1);

  cache.reset(); // drop in-memory handle so the next call has to hit disk.
  spawnSpy.mockClear();

  const second = await cache.getOrStart(flacReq());
  expect(second.isDone()).toBe(true);
  expect(second.error()).toBeNull();
  expect(ffmpegSpawnCalls()).toBe(0);
  expect(second.index.chunks.length).toBeGreaterThanOrEqual(2);
}, 30_000);

test('stale partial .idx (done=false) triggers a fresh re-encode', async () => {
  // Hand-craft a partial idx + .bin on disk, then ensure cache ignores them.
  const dir = path.join(workDir, `track-uuid-002-${FLAC_MTIME.getTime()}`);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const tk = targetKey(flacReq().target);
  await writeFile(path.join(dir, `${tk}.bin`), 'GARBAGE');
  await writeFile(
    path.join(dir, `${tk}.idx`),
    JSON.stringify({
      chunkDurationSeconds: 0.2,
      durationSeconds: 0,
      done: false,
      init: null,
      chunks: [],
    }),
  );

  const req = { ...flacReq(), trackId: 'track-uuid-002' };
  const entry = await cache.getOrStart(req);
  await entry.waitForEncoded(Number.POSITIVE_INFINITY);
  expect(entry.isDone()).toBe(true);
  const bin = await readFile(entry.binPath);
  // 'GARBAGE' would be 7 bytes; a real fmp4 will be much larger.
  expect(bin.length).toBeGreaterThan(100);
}, 30_000);

test('encoder failure (bad source path) surfaces via error() and rejects waitForEncoded', async () => {
  const req = { ...flacReq(), sourcePath: path.join(workDir, 'does-not-exist.flac') };
  const entry = await cache.getOrStart(req);
  await expect(entry.waitForEncoded(Number.POSITIVE_INFINITY)).rejects.toThrow();
  expect(entry.error()).not.toBeNull();
}, 30_000);

test('different targets for the same track land in distinct cache entries', async () => {
  const opus = await cache.getOrStart(flacReq());
  const flac = await cache.getOrStart({
    ...flacReq(),
    target: { format: { container: 'mp4', codec: 'flac' }, quality: 'max' },
  });
  expect(opus.binPath).not.toBe(flac.binPath);
  await opus.waitForEncoded(Number.POSITIVE_INFINITY);
  await flac.waitForEncoded(Number.POSITIVE_INFINITY);
  expect(opus.isDone()).toBe(true);
  expect(flac.isDone()).toBe(true);
}, 30_000);

test('waitForEncoded resolves when the cumulative endSeconds threshold is crossed', async () => {
  const entry = await cache.getOrStart(flacReq());
  await entry.waitForEncoded(0.3);
  const snap = entry.index;
  expect(snap.durationSeconds).toBeGreaterThanOrEqual(0.3);
  await entry.waitForEncoded(Number.POSITIVE_INFINITY);
}, 30_000);

test('listening to update events sees chunks land as the encoder produces them', async () => {
  const entry = await cache.getOrStart(flacReq());
  const observedChunkCounts: number[] = [];
  const onUpdate = (snap: { chunks: unknown[] }): void => {
    observedChunkCounts.push(snap.chunks.length);
  };
  entry.emitter.on('update', onUpdate);
  try {
    await entry.waitForEncoded(Number.POSITIVE_INFINITY);
  } finally {
    entry.emitter.off('update', onUpdate);
  }
  // We expect at least one update event was fired before completion.
  expect(observedChunkCounts.length).toBeGreaterThan(0);
  // Final observed count matches the final idx.
  expect(observedChunkCounts.at(-1)).toBe(entry.index.chunks.length);
});

