import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type IndexFile, startLiveTail } from './live-tail.js';
import { makeMp3Scanner } from './scan-mp3.js';
import { mp4Scanner } from './scan-mp4.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'live-tail-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function frameMpeg1L3(bitrateKbps: number, sampleRateHz: 44100 | 48000 | 32000): Buffer {
  const table = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const bitrateIdx = table.indexOf(bitrateKbps);
  const srIdx = sampleRateHz === 44100 ? 0 : sampleRateHz === 48000 ? 1 : 2;
  const frameLength = Math.floor((144 * bitrateKbps * 1000) / sampleRateHz);
  const buf = Buffer.alloc(frameLength, 0);
  buf[0] = 0xff;
  buf[1] = 0b11111011;
  buf[2] = (bitrateIdx << 4) | (srIdx << 2);
  buf[3] = 0;
  return buf;
}

async function append(file: string, data: Buffer): Promise<void> {
  let existing: Buffer;
  try {
    existing = await readFile(file);
  } catch {
    existing = Buffer.alloc(0);
  }
  await writeFile(file, Buffer.concat([existing, data]));
}

async function waitForUpdate(
  emitter: import('node:events').EventEmitter,
  predicate: (snap: IndexFile) => boolean,
  timeoutMs = 1000,
): Promise<IndexFile> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.off('update', onUpdate);
      reject(new Error('timeout waiting for update'));
    }, timeoutMs);
    const onUpdate = (snap: IndexFile): void => {
      if (predicate(snap)) {
        clearTimeout(timeout);
        emitter.off('update', onUpdate);
        resolve(snap);
      }
    };
    emitter.on('update', onUpdate);
  });
}

test('mp4: picks up init range and growing chunks; finalise flushes trailing fragment', async () => {
  const binPath = path.join(workDir, 'a.bin');
  const idxPath = path.join(workDir, 'a.idx');
  await writeFile(binPath, Buffer.alloc(0));

  const handle = startLiveTail({
    scanner: mp4Scanner,
    binPath,
    idxPath,
    chunkDurationSeconds: 6,
    pollIntervalMs: 10,
  });

  const ftyp = box('ftyp', Buffer.alloc(16));
  const moov = box('moov', Buffer.alloc(40));
  const moof1 = box('moof', Buffer.alloc(20));
  const mdat1 = box('mdat', Buffer.alloc(100));
  const moof2 = box('moof', Buffer.alloc(20));
  const mdat2 = box('mdat', Buffer.alloc(80));
  const moof1Off = ftyp.length + moov.length;
  const moof2Off = moof1Off + moof1.length + mdat1.length;
  const finalEnd = moof2Off + moof2.length + mdat2.length;

  // Step 1: init + first fragment lands. init range observable, no completed chunks yet.
  await append(binPath, Buffer.concat([ftyp, moov, moof1, mdat1]));
  let snap = await waitForUpdate(handle.emitter, (s) => s.init !== null);
  expect(snap.init).toEqual([0, moof1Off]);
  expect(snap.chunks).toEqual([]);
  expect(snap.durationSeconds).toBe(0);

  // Step 2: second moof arrives. First chunk is now finalised.
  await append(binPath, Buffer.concat([moof2, mdat2]));
  snap = await waitForUpdate(handle.emitter, (s) => s.chunks.length >= 1);
  expect(snap.chunks).toEqual([{ byte: [moof1Off, moof2Off], endSeconds: 6 }]);
  expect(snap.durationSeconds).toBe(6);
  expect(snap.done).toBe(false);

  // Step 3: finalise flushes the trailing fragment using fileSize.
  await handle.finalise();
  expect(handle.index.chunks).toEqual([
    { byte: [moof1Off, moof2Off], endSeconds: 6 },
    { byte: [moof2Off, finalEnd], endSeconds: 12 },
  ]);
  expect(handle.index.done).toBe(true);
  expect(handle.index.durationSeconds).toBe(12);

  // .idx is persisted with the final state.
  const persisted = JSON.parse(await readFile(idxPath, 'utf8')) as IndexFile;
  expect(persisted.done).toBe(true);
  expect(persisted.init).toEqual([0, moof1Off]);
  expect(persisted.chunks).toHaveLength(2);
  expect(persisted.chunkDurationSeconds).toBe(6);
});

test('mp3: emits chunks as window thresholds are crossed and finalise flushes the partial', async () => {
  const binPath = path.join(workDir, 'b.bin');
  const idxPath = path.join(workDir, 'b.idx');
  await writeFile(binPath, Buffer.alloc(0));

  const handle = startLiveTail({
    scanner: makeMp3Scanner(0.1),
    binPath,
    idxPath,
    chunkDurationSeconds: 0.1,
    pollIntervalMs: 10,
  });

  const frameBytes = 104;
  const frame = (): Buffer => frameMpeg1L3(32, 44100);
  const fourFrameDuration = (4 * 1152) / 44100;

  // 4 frames complete a 100 ms window.
  await append(binPath, Buffer.concat(Array.from({ length: 4 }, () => frame())));
  let snap = await waitForUpdate(handle.emitter, (s) => s.chunks.length >= 1);
  expect(snap.chunks).toEqual([{ byte: [0, frameBytes * 4], endSeconds: fourFrameDuration }]);
  expect(snap.init).toBeNull();

  // 4 more frames complete the next window.
  await append(binPath, Buffer.concat(Array.from({ length: 4 }, () => frame())));
  snap = await waitForUpdate(handle.emitter, (s) => s.chunks.length >= 2);
  expect(snap.chunks[1]).toEqual({
    byte: [frameBytes * 4, frameBytes * 8],
    endSeconds: fourFrameDuration * 2,
  });

  // 2 trailing frames + finalise flushes them as a final partial window.
  await append(binPath, Buffer.concat([frame(), frame()]));
  await handle.finalise();
  expect(handle.index.chunks).toHaveLength(3);
  expect(handle.index.chunks[2]).toEqual({
    byte: [frameBytes * 8, frameBytes * 10],
    endSeconds: fourFrameDuration * 2 + (2 * 1152) / 44100,
  });
  expect(handle.index.done).toBe(true);
});

test('stop() halts the loop without finalising', async () => {
  const binPath = path.join(workDir, 'c.bin');
  const idxPath = path.join(workDir, 'c.idx');
  const moof = box('moof', Buffer.alloc(20));
  const mdat = box('mdat', Buffer.alloc(100));
  await writeFile(binPath, Buffer.concat([moof, mdat]));

  const handle = startLiveTail({
    scanner: mp4Scanner,
    binPath,
    idxPath,
    chunkDurationSeconds: 6,
    pollIntervalMs: 10,
  });
  // Wait a couple of poll intervals for the loop to observe the bytes.
  await new Promise((r) => setTimeout(r, 50));
  await handle.stop();
  expect(handle.index.done).toBe(false);
  // The pending fragment was observed but not finalised.
  expect(handle.index.chunks).toEqual([]);
});

test('persists .idx after every meaningful update (so a crash mid-encode leaves a usable cache)', async () => {
  const binPath = path.join(workDir, 'd.bin');
  const idxPath = path.join(workDir, 'd.idx');
  await writeFile(binPath, Buffer.alloc(0));

  const handle = startLiveTail({
    scanner: mp4Scanner,
    binPath,
    idxPath,
    chunkDurationSeconds: 6,
    pollIntervalMs: 10,
  });

  const ftyp = box('ftyp', Buffer.alloc(8));
  const moof1 = box('moof', Buffer.alloc(20));
  const moof2 = box('moof', Buffer.alloc(20));
  await append(binPath, Buffer.concat([ftyp, moof1, moof2]));
  await waitForUpdate(handle.emitter, (s) => s.chunks.length >= 1);

  const onDisk = JSON.parse(await readFile(idxPath, 'utf8')) as IndexFile;
  expect(onDisk.init).toEqual([0, ftyp.length]);
  expect(onDisk.chunks).toEqual([
    { byte: [ftyp.length, ftyp.length + moof1.length], endSeconds: 6 },
  ]);
  expect(onDisk.done).toBe(false);

  await handle.stop();
});
