import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Quality } from '../graphql/playback-format.js';
import { type EncodeTarget, spawnEncoder } from './encoder.js';
import { webmScanner } from './scan-webm.js';

// --- synthetic EBML builders --------------------------------------------------------------

/** Encode an EBML data-size VINT, choosing the shortest length that fits (all-ones is reserved). */
function vintSize(value: number): Buffer {
  for (let len = 1; len <= 8; len++) {
    const max = 2 ** (7 * len) - 1;
    if (value < max) {
      const b = Buffer.alloc(len);
      let v = value;
      for (let i = len - 1; i >= 0; i--) {
        b[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      b[0]! |= 0x80 >> (len - 1);
      return b;
    }
  }
  throw new Error('value too large for a VINT');
}

function uintBytes(value: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  b.writeUIntBE(value, 0, len);
  return b;
}

/** An EBML element: ID (its natural byte length) + size VINT + payload. */
function elem(id: number, idLen: number, payload: Buffer): Buffer {
  const idBuf = Buffer.alloc(idLen);
  idBuf.writeUIntBE(id, 0, idLen);
  return Buffer.concat([idBuf, vintSize(payload.length), payload]);
}

const ebmlHeader = (): Buffer => elem(0x1a45dfa3, 4, Buffer.alloc(8));
const timecodeScale = (ns: number): Buffer => elem(0x2ad7b1, 3, uintBytes(ns, 4));
const info = (ns: number): Buffer => elem(0x1549a966, 4, timecodeScale(ns));
const timecode = (t: number): Buffer => elem(0xe7, 1, uintBytes(t, 2));

/** A SimpleBlock for track 1 carrying a signed relative timecode and one byte of (ignored) frame data. */
function simpleBlock(relTimecode: number): Buffer {
  const rel = Buffer.alloc(2);
  rel.writeInt16BE(relTimecode, 0);
  return elem(0xa3, 1, Buffer.concat([vintSize(1), rel, Buffer.from([0x00, 0xaa])]));
}

function cluster(timecodeValue: number, blocks: Buffer[] = []): Buffer {
  return elem(0x1f43b675, 4, Buffer.concat([timecode(timecodeValue), ...blocks]));
}

/** Wrap children in a Segment master with a known size. */
function segment(children: Buffer[]): Buffer {
  return elem(0x18538067, 4, Buffer.concat(children));
}

const DEFAULT_SCALE = 1_000_000; // 1 ms ticks → timescale 1000

test('init-only buffer: timescale from Info, no cluster yet, rewinds to 0', () => {
  const buf = Buffer.concat([ebmlHeader(), segment([info(DEFAULT_SCALE)])]);
  const r = webmScanner.scan(buf, 0, false);
  expect(r.init).toBeNull(); // no cluster yet → init end unknown
  expect(r.timescale).toBe(1000);
  expect(r.chunks).toEqual([]);
  expect(r.resumeOffset).toBe(0);
});

test('second cluster finalises the first with a Timecode-delta rawDuration', () => {
  const header = ebmlHeader();
  const inf = info(DEFAULT_SCALE);
  const c0 = cluster(0, [simpleBlock(0)]);
  const c1 = cluster(500, [simpleBlock(0)]);
  const segPayload = Buffer.concat([inf, c0, c1]);
  const segHeaderLen = 4 + vintSize(segPayload.length).length;
  const buf = Buffer.concat([header, segment([inf, c0, c1])]);
  // First cluster begins after the EBML header + Segment element header + Info.
  const firstCluster = header.length + segHeaderLen + inf.length;
  const secondCluster = firstCluster + c0.length;

  const r = webmScanner.scan(buf, 0, false);
  expect(r.init).toEqual([0, firstCluster]);
  expect(r.timescale).toBe(1000);
  expect(r.chunks).toEqual([{ byte: [firstCluster, secondCluster], rawDuration: 500 }]);
  // The second cluster is still pending — cursor parks at it.
  expect(r.resumeOffset).toBe(secondCluster);
});

test('isFinal recovers the trailing cluster duration from its block timecodes', () => {
  // Blocks at 0, 20, 40 → last + (last - prev) = 40 + 20 = 60.
  const buf = cluster(0, [simpleBlock(0), simpleBlock(20), simpleBlock(40)]);
  const base = 4096;
  const r = webmScanner.scan(buf, base, true);
  expect(r.chunks).toEqual([{ byte: [base, base + buf.length], rawDuration: 60 }]);
  expect(r.resumeOffset).toBe(base + buf.length);
});

test('a two-slice scan yields the same chunks as a single pass (live-tail resumption)', () => {
  const seg = segment([
    info(DEFAULT_SCALE),
    cluster(0, [simpleBlock(0)]),
    cluster(300, [simpleBlock(0)]),
    cluster(600, [simpleBlock(0), simpleBlock(30)]),
  ]);
  const buf = Buffer.concat([ebmlHeader(), seg]);

  const whole = webmScanner.scan(buf, 0, true);
  const sliceAt = Math.floor(buf.length / 2);
  const first = webmScanner.scan(buf.subarray(0, sliceAt), 0, false);
  const second = webmScanner.scan(buf.subarray(first.resumeOffset), first.resumeOffset, true);
  expect([...first.chunks, ...second.chunks].map((c) => c.byte)).toEqual(
    whole.chunks.map((c) => c.byte),
  );
  expect(first.init ?? second.init).toEqual(whole.init);
});

// --- real ffmpeg-encoded fixture ----------------------------------------------------------

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scanner',
  '__fixtures__',
);
const SAMPLE_OGG = path.join(FIXTURES, 'sample.ogg');

describe('real vorbis-in-webm fixture (passthrough copy)', () => {
  let workDir: string;
  let bytes: Buffer;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'scan-webm-fixture-'));
    const out = path.join(workDir, 'webm.bin');
    const target: EncodeTarget = {
      format: { container: 'webm', codec: 'vorbis' },
      quality: Quality.MAX,
    };
    await spawnEncoder({
      source: SAMPLE_OGG,
      target,
      outPath: out,
      chunkDurationSeconds: 5,
      passthrough: true,
    }).done;
    bytes = await readFile(out);
  }, 30_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test('init + contiguous clusters cover the media, excluding the trailing Cues', () => {
    const r = webmScanner.scan(bytes, 0, true);
    expect(r.init).not.toBeNull();
    expect(r.init![0]).toBe(0);
    expect(r.timescale).toBe(1000);
    expect(r.chunks.length).toBeGreaterThanOrEqual(2);
    expect(r.chunks[0]!.byte[0]).toBe(r.init![1]);
    for (let i = 1; i < r.chunks.length; i++) {
      expect(r.chunks[i]!.byte[0]).toBe(r.chunks[i - 1]!.byte[1]);
    }
    // ffmpeg's -dash mode writes a Cues element after the last cluster — it must be left out.
    expect(r.chunks.at(-1)!.byte[1]).toBeLessThan(bytes.length);
  });

  test('summed durations match the ~60 s source (trailing cluster recovered, not nominal)', () => {
    const r = webmScanner.scan(bytes, 0, true);
    const ts = r.timescale!;
    expect(r.chunks.every((c) => c.rawDuration !== null)).toBe(true);
    const cumulative = r.chunks.reduce((a, c) => a + c.rawDuration! / ts, 0);
    expect(cumulative).toBeGreaterThan(59.5);
    expect(cumulative).toBeLessThan(60.5);
  });

  test('two-slice scan reconstructs the same chunks (live-tail resumption)', () => {
    const whole = webmScanner.scan(bytes, 0, true);
    const sliceAt = Math.floor(bytes.length / 2);
    const first = webmScanner.scan(bytes.subarray(0, sliceAt), 0, false);
    const second = webmScanner.scan(bytes.subarray(first.resumeOffset), first.resumeOffset, true);
    expect([...first.chunks, ...second.chunks].map((c) => c.byte)).toEqual(
      whole.chunks.map((c) => c.byte),
    );
    expect(first.init ?? second.init).toEqual(whole.init);
  });
});
