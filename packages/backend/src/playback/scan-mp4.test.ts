import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Quality } from '../graphql/playback-format.js';
import { type EncodeTarget, spawnEncoder } from './encoder.js';
import { mp4Scanner } from './scan-mp4.js';

// --- synthetic box builders ---------------------------------------------------------------

function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function fullBox(type: string, version: number, fields: Buffer): Buffer {
  return box(type, Buffer.concat([Buffer.from([version, 0, 0, 0]), fields]));
}

/** `moof → traf → tfdt(baseMediaDecodeTime)`. */
function moof(baseMediaDecodeTime: number): Buffer {
  const t = Buffer.alloc(4);
  t.writeUInt32BE(baseMediaDecodeTime, 0);
  return box('moof', box('traf', fullBox('tfdt', 0, t)));
}

/** `moov → trak → mdia → mdhd(timescale)` (v0). */
function moov(timescale: number): Buffer {
  const f = Buffer.alloc(16); // creation(4) modification(4) timescale(4) duration(4)
  f.writeUInt32BE(timescale, 8);
  return box('moov', box('trak', box('mdia', fullBox('mdhd', 0, f))));
}

function bigBox(type: string, payload: Buffer): Buffer {
  // size-1 large-size form: 8-byte header + 8-byte 64-bit size = 16-byte header.
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'ascii');
  header.writeUInt32BE(16 + payload.length, 12);
  return Buffer.concat([header, payload]);
}

const TS = 48000;

// --- synthetic header / tfdt tests --------------------------------------------------------

test('init-only buffer: timescale is read from moov, no chunks yet', () => {
  const buf = Buffer.concat([box('ftyp', Buffer.alloc(16)), moov(TS)]);
  const r = mp4Scanner.scan(buf, 0, false);
  expect(r.init).toBeNull(); // no moof yet → init end unknown
  expect(r.timescale).toBe(TS);
  expect(r.chunks).toEqual([]);
  // No moof yet, so the init range isn't known — rewind to 0 to re-scan from the start once the
  // first fragment lands, rather than advancing past the moov and losing the init forever.
  expect(r.resumeOffset).toBe(0);
});

test('second moof finalises the first fragment with a tfdt-delta rawDuration', () => {
  const ftyp = box('ftyp', Buffer.alloc(16));
  const mv = moov(TS);
  const moof1 = moof(0);
  const mdat1 = box('mdat', Buffer.alloc(100));
  const moof2 = moof(TS / 2); // 0.5 s later
  const mdat2 = box('mdat', Buffer.alloc(80));
  const buf = Buffer.concat([ftyp, mv, moof1, mdat1, moof2, mdat2]);
  const moof1Off = ftyp.length + mv.length;
  const moof2Off = moof1Off + moof1.length + mdat1.length;

  const r = mp4Scanner.scan(buf, 0, false);
  expect(r.init).toEqual([0, moof1Off]);
  expect(r.timescale).toBe(TS);
  expect(r.chunks).toEqual([{ byte: [moof1Off, moof2Off], rawDuration: TS / 2 }]);
  // The second fragment is still pending — cursor parks at its moof.
  expect(r.resumeOffset).toBe(moof2Off);
});

test('several fragments emit a chunk each with their own tfdt deltas', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const mv = moov(TS);
  const f0 = moof(0);
  const d0 = box('mdat', Buffer.alloc(40));
  const f1 = moof(9600); // +0.20 s
  const d1 = box('mdat', Buffer.alloc(40));
  const f2 = moof(19000); // +0.1958 s (uneven, like real flac frames)
  const d2 = box('mdat', Buffer.alloc(40));
  const buf = Buffer.concat([ftyp, mv, f0, d0, f1, d1, f2, d2]);
  const a = ftyp.length + mv.length;
  const b = a + f0.length + d0.length;
  const c = b + f1.length + d1.length;

  const r = mp4Scanner.scan(buf, 0, false);
  expect(r.chunks).toEqual([
    { byte: [a, b], rawDuration: 9600 },
    { byte: [b, c], rawDuration: 19000 - 9600 },
  ]);
});

test('isFinal flushes the trailing fragment with a null rawDuration', () => {
  const f = moof(0);
  const d = box('mdat', Buffer.alloc(40));
  const base = 500;
  const buf = Buffer.concat([f, d]);
  const r = mp4Scanner.scan(buf, base, true);
  expect(r.chunks).toEqual([{ byte: [base, base + buf.length], rawDuration: null }]);
  expect(r.resumeOffset).toBe(base + buf.length);
});

test('truncated trailing box leaves resumeOffset at the pending moof', () => {
  const ftyp = box('ftyp', Buffer.alloc(16));
  const mv = moov(TS);
  const f = moof(0);
  const d = box('mdat', Buffer.alloc(100));
  const truncated = Buffer.alloc(4);
  truncated.writeUInt32BE(28, 0);
  const moofOff = ftyp.length + mv.length;
  const r = mp4Scanner.scan(Buffer.concat([ftyp, mv, f, d, truncated]), 0, false);
  expect(r.init).toEqual([0, moofOff]);
  expect(r.resumeOffset).toBe(moofOff);
});

test('honours 64-bit size-1 box headers', () => {
  const big = bigBox('moof', box('traf', fullBox('tfdt', 0, Buffer.alloc(4))));
  const mdat = box('mdat', Buffer.alloc(16));
  const r = mp4Scanner.scan(Buffer.concat([big, mdat]), 0, false);
  expect(r.resumeOffset).toBe(0); // pending parked at the single moof
});

test('throws on a structurally invalid box size shorter than its header', () => {
  const malformed = Buffer.alloc(8);
  malformed.writeUInt32BE(4, 0);
  malformed.write('moof', 4, 'ascii');
  expect(() => mp4Scanner.scan(malformed, 0, false)).toThrow(/invalid box size/);
});

test('throws on size-0 boxes (unexpected for fragmented mp4)', () => {
  const sz0 = Buffer.alloc(8);
  sz0.writeUInt32BE(0, 0);
  sz0.write('moof', 4, 'ascii');
  expect(() => mp4Scanner.scan(sz0, 0, false)).toThrow(/size-0 box/);
});

// --- real ffmpeg-encoded fixture (complements the synthetic unit tests) -------------------

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scanner',
  '__fixtures__',
);
const SAMPLE_FLAC = path.join(FIXTURES, 'sample.flac');
// sample.flac is 1.0 s @ 22050 Hz. flac-in-mp4 is the codec whose large frames exposed the
// nominal-vs-real drift; short fragments give us several chunks to walk.
const FRAG_SECONDS = 0.2;

describe('real flac-in-mp4 fixture', () => {
  let workDir: string;
  let bytes: Buffer;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'scan-mp4-fixture-'));
    const out = path.join(workDir, 'flac.bin');
    const target: EncodeTarget = {
      format: { container: 'mp4', codec: 'flac' },
      quality: Quality.MAX,
    };
    await spawnEncoder({
      source: SAMPLE_FLAC,
      target,
      outPath: out,
      chunkDurationSeconds: FRAG_SECONDS,
      passthrough: true,
    }).done;
    bytes = await readFile(out);
  }, 30_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  // Walk top-level boxes to find where the final mdat ends — the chunks should cover up to there,
  // not to EOF, since ffmpeg appends a trailing mfra index box.
  function lastMdatEnd(buf: Buffer): number {
    let pos = 0;
    let end = 0;
    while (pos + 8 <= buf.length) {
      const size = buf.readUInt32BE(pos);
      if (size === 0) break;
      if (buf.toString('ascii', pos + 4, pos + 8) === 'mdat') end = pos + size;
      pos += size;
    }
    return end;
  }

  test('init + contiguous chunks cover the media (excluding the trailing mfra index)', () => {
    const r = mp4Scanner.scan(bytes, 0, true);
    expect(r.init).not.toBeNull();
    expect(r.init![0]).toBe(0);
    expect(r.timescale).toBeGreaterThan(0);
    expect(r.chunks.length).toBeGreaterThanOrEqual(2);
    expect(r.chunks[0]!.byte[0]).toBe(r.init![1]);
    for (let i = 1; i < r.chunks.length; i++) {
      expect(r.chunks[i]!.byte[0]).toBe(r.chunks[i - 1]!.byte[1]);
    }
    // Last chunk ends at the final mdat, and the trailing mfra is left out.
    const mdatEnd = lastMdatEnd(bytes);
    expect(r.chunks.at(-1)!.byte[1]).toBe(mdatEnd);
    expect(mdatEnd).toBeLessThan(bytes.length);
  });

  test('durations come from real tfdt deltas — uneven, not a flat nominal value', () => {
    const r = mp4Scanner.scan(bytes, 0, true);
    const ts = r.timescale!;
    // Every fragment carries a real duration, including the trailing one (recovered from its
    // own trun sample durations rather than left null to fall back to nominal).
    expect(r.chunks.every((c) => c.rawDuration !== null)).toBe(true);

    const seconds = r.chunks.map((c) => c.rawDuration! / ts);
    // Regression guard: the fragment durations are NOT all the nominal 0.2 s — that uniform
    // assumption is exactly the drift that broke seeking on long lossless tracks.
    expect(seconds.every((s) => Math.abs(s - FRAG_SECONDS) < 1e-6)).toBe(false);
    // Summed durations cover the whole 1.0 s source — the trailing fragment's real (short)
    // remainder is included, so the manifest's total matches the audio that actually decodes.
    const cumulative = seconds.reduce((a, b) => a + b, 0);
    expect(cumulative).toBeGreaterThan(0.95);
    expect(cumulative).toBeLessThanOrEqual(1.0 + 1e-6);
  });

  test('two-slice scan yields the same chunks as a single pass (live-tail resumption)', () => {
    const whole = mp4Scanner.scan(bytes, 0, true);
    const sliceAt = Math.floor(bytes.length / 2);
    const first = mp4Scanner.scan(bytes.subarray(0, sliceAt), 0, false);
    const second = mp4Scanner.scan(bytes.subarray(first.resumeOffset), first.resumeOffset, true);
    expect([...first.chunks, ...second.chunks].map((c) => c.byte)).toEqual(
      whole.chunks.map((c) => c.byte),
    );
    expect(first.init ?? second.init).toEqual(whole.init);
    expect(first.timescale ?? second.timescale).toBe(whole.timescale);
  });
});
