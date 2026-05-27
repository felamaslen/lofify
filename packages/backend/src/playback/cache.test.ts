import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { playbackCacheAccess } from '../db/schema/index.js';
import { Quality } from '../graphql/track.js';
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
  await db.delete(playbackCacheAccess);
  await rm(workDir, { recursive: true, force: true });
});

const FLAC_MTIME = new Date('2026-01-01T00:00:00Z');

function flacReq(): Parameters<Cache['getOrStart']>[0] {
  return {
    trackId: 'track-uuid-001',
    sourceMtime: FLAC_MTIME,
    sourcePath: SAMPLE_FLAC,
    sourceCodec: 'flac',
    target: { format: { container: 'mp4', codec: 'opus' }, quality: Quality.MEDIUM },
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
    target: { format: { container: 'mp4', codec: 'flac' }, quality: Quality.MAX },
  });
  expect(opus.binPath).not.toBe(flac.binPath);
  await opus.waitForEncoded(Number.POSITIVE_INFINITY);
  await flac.waitForEncoded(Number.POSITIVE_INFINITY);
  expect(opus.isDone()).toBe(true);
  expect(flac.isDone()).toBe(true);
}, 30_000);

// Seed a synthetic on-disk entry + access row without running an encoder, so sweep ordering can be
// asserted directly. The dir holds a single file sized to `bytes`; the row carries the recency.
async function seedEntry(dirName: string, bytes: number, lastAccess: Date): Promise<void> {
  const dir = path.join(workDir, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'data.bin'), Buffer.alloc(bytes));
  await db.insert(playbackCacheAccess).values({ entryDir: dirName, sizeBytes: bytes, lastAccess });
}

async function remainingDirs(): Promise<string[]> {
  const rows = await db
    .select({ entryDir: playbackCacheAccess.entryDir })
    .from(playbackCacheAccess);
  return rows.map((r) => r.entryDir).sort();
}

test('sweep is a no-op while total usage is within budget', async () => {
  const budgeted = createCache({ cacheRoot: workDir, chunkDurationSeconds: 0.2, maxBytes: 5000 });
  await seedEntry('a', 500, new Date(1));
  await seedEntry('b', 500, new Date(2));

  const { evicted } = await budgeted.sweep();

  expect(evicted).toEqual([]);
  expect(await remainingDirs()).toEqual(['a', 'b']);
});

test('sweep evicts least-recently-accessed entries first until under budget', async () => {
  const budgeted = createCache({ cacheRoot: workDir, chunkDurationSeconds: 0.2, maxBytes: 1500 });
  await seedEntry('old', 1000, new Date(1));
  await seedEntry('mid', 1000, new Date(2));
  await seedEntry('new', 1000, new Date(3));

  // 3000 bytes over a 1500 budget: drop the two oldest, leaving `new`.
  const { evicted } = await budgeted.sweep();

  expect(evicted).toEqual(['old', 'mid']);
  expect(await remainingDirs()).toEqual(['new']);
  await expect(stat(path.join(workDir, 'old'))).rejects.toThrow();
});

test('sweep targetBytes evicts past the budget to leave headroom', async () => {
  const budgeted = createCache({ cacheRoot: workDir, chunkDurationSeconds: 0.2, maxBytes: 3500 });
  await seedEntry('a', 1000, new Date(1));
  await seedEntry('b', 1000, new Date(2));
  await seedEntry('c', 1000, new Date(3));
  await seedEntry('d', 1000, new Date(4));

  // Over the 3500 budget (4000 total); sweep down to a 2000 target → drop the two oldest.
  const { evicted } = await budgeted.sweep(2000);

  expect(evicted).toEqual(['a', 'b']);
  expect(await remainingDirs()).toEqual(['c', 'd']);
});

test('budget sweep evicts an unprotected entry from disk and the access table', async () => {
  const budgeted = createCache({ cacheRoot: workDir, chunkDurationSeconds: 0.2, maxBytes: 1 });
  const entry = await budgeted.getOrStart(flacReq());
  await entry.waitForEncoded(Number.POSITIVE_INFINITY);
  const dirName = path.basename(path.dirname(entry.binPath));

  // Wait for the post-encode size record to land, so the sweep has a size to weigh.
  let sizeBytes = 0;
  for (let i = 0; i < 100 && sizeBytes === 0; i++) {
    const rows = await db
      .select()
      .from(playbackCacheAccess)
      .where(eq(playbackCacheAccess.entryDir, dirName));
    sizeBytes = rows[0]?.sizeBytes ?? 0;
    if (sizeBytes === 0) await new Promise((r) => setTimeout(r, 50));
  }
  expect(sizeBytes).toBeGreaterThan(0);

  // While the in-memory handle is live the entry is protected; dropping it makes it evictable.
  budgeted.reset();
  const { evicted } = await budgeted.sweep();

  expect(evicted).toContain(dirName);
  await expect(stat(entry.binPath)).rejects.toThrow();
  const after = await db
    .select()
    .from(playbackCacheAccess)
    .where(eq(playbackCacheAccess.entryDir, dirName));
  expect(after).toHaveLength(0);
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
