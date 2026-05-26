import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Quality } from '../graphql/playback-format.js';
import { type EncodeTarget, spawnEncoder } from './encoder.js';
import { makeMp3Scanner } from './scan-mp3.js';

// --- synthetic frame builders -------------------------------------------------------------

/** Build a single MPEG1 Layer 3 frame at the given bitrate + sample rate. Tail bytes are zero-filled — they aren't decoded by the scanner. */
function frameMpeg1L3(bitrateKbps: number, sampleRateHz: 44100 | 48000 | 32000): Buffer {
  const table = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const bitrateIdx = table.indexOf(bitrateKbps);
  if (bitrateIdx < 1) throw new Error(`unsupported bitrate ${bitrateKbps}`);
  const srIdx = sampleRateHz === 44100 ? 0 : sampleRateHz === 48000 ? 1 : 2;
  const frameLength = Math.floor((144 * bitrateKbps * 1000) / sampleRateHz);
  const b1 = 0b11111011; // sync(11) | version=MPEG1(2) | layer=L3(2) | noCrc(1)
  const b2 = (bitrateIdx << 4) | (srIdx << 2); // bitrateIdx(4) | srIdx(2) | padding=0(1) | private=0(1)
  const buf = Buffer.alloc(frameLength, 0);
  buf[0] = 0xff;
  buf[1] = b1;
  buf[2] = b2;
  buf[3] = 0;
  return buf;
}

// 32 kbps / 44.1 kHz / MPEG1 L3: 104 bytes/frame, 1152 samples/frame.
// 0.1 s target window = ceil(4410 / 1152) = 4 frames per window.
const SCANNER_100MS = makeMp3Scanner(0.1);
const FRAME = (): Buffer => frameMpeg1L3(32, 44100);
const FRAME_BYTES = 104;
const SAMPLES_PER_FRAME = 1152;
const SR = 44100;

test('emits one chunk per completed window with sample-count rawDuration + sample-rate timescale', () => {
  // 9 frames → 2 complete windows of 4 frames + 1 frame in progress.
  const buf = Buffer.concat(Array.from({ length: 9 }, () => FRAME()));
  const r = SCANNER_100MS.scan(buf, 0, false);
  expect(r.init).toBeNull();
  expect(r.timescale).toBe(SR);
  expect(r.chunks).toEqual([
    { byte: [0, FRAME_BYTES * 4], rawDuration: 4 * SAMPLES_PER_FRAME },
    { byte: [FRAME_BYTES * 4, FRAME_BYTES * 8], rawDuration: 4 * SAMPLES_PER_FRAME },
  ]);
  expect(r.resumeOffset).toBe(FRAME_BYTES * 8);
});

test('isFinal=true flushes the trailing in-progress window with its actual sample count', () => {
  // 6 frames → 1 complete window (4 frames) + a trailing window of 2 frames.
  const buf = Buffer.concat(Array.from({ length: 6 }, () => FRAME()));
  const r = SCANNER_100MS.scan(buf, 0, true);
  expect(r.chunks).toEqual([
    { byte: [0, FRAME_BYTES * 4], rawDuration: 4 * SAMPLES_PER_FRAME },
    { byte: [FRAME_BYTES * 4, FRAME_BYTES * 6], rawDuration: 2 * SAMPLES_PER_FRAME },
  ]);
  expect(r.resumeOffset).toBe(FRAME_BYTES * 6);
});

test('isFinal=true with no accumulated samples emits nothing extra', () => {
  // 8 frames = exactly 2 windows; nothing pending.
  const buf = Buffer.concat(Array.from({ length: 8 }, () => FRAME()));
  const r = SCANNER_100MS.scan(buf, 0, true);
  expect(r.chunks).toEqual([
    { byte: [0, FRAME_BYTES * 4], rawDuration: 4 * SAMPLES_PER_FRAME },
    { byte: [FRAME_BYTES * 4, FRAME_BYTES * 8], rawDuration: 4 * SAMPLES_PER_FRAME },
  ]);
  expect(r.resumeOffset).toBe(FRAME_BYTES * 8);
});

test('truncated trailing frame parks resume at the in-progress window start', () => {
  const buf = Buffer.concat([
    ...Array.from({ length: 5 }, () => FRAME()),
    Buffer.from([0xff, 0xfb]),
  ]);
  const r = SCANNER_100MS.scan(buf, 0, false);
  expect(r.chunks).toEqual([{ byte: [0, FRAME_BYTES * 4], rawDuration: 4 * SAMPLES_PER_FRAME }]);
  expect(r.resumeOffset).toBe(FRAME_BYTES * 4);
});

test('resuming from a non-zero baseOffset emits file-absolute ranges', () => {
  const base = 5000;
  const buf = Buffer.concat(Array.from({ length: 4 }, () => FRAME()));
  const r = SCANNER_100MS.scan(buf, base, false);
  expect(r.chunks).toEqual([
    { byte: [base, base + FRAME_BYTES * 4], rawDuration: 4 * SAMPLES_PER_FRAME },
  ]);
  expect(r.resumeOffset).toBe(base + FRAME_BYTES * 4);
});

test('skips an ID3v2 tag at the start of the file', () => {
  // ID3v2 header: "ID3" + 2-byte version + 1-byte flags + 4-byte syncsafe size (= 40 → 40 payload bytes).
  const tag = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x28]),
    Buffer.alloc(40, 0),
  ]);
  const buf = Buffer.concat([tag, Buffer.concat(Array.from({ length: 4 }, () => FRAME()))]);
  const r = SCANNER_100MS.scan(buf, 0, false);
  expect(r.chunks).toEqual([
    { byte: [tag.length, tag.length + FRAME_BYTES * 4], rawDuration: 4 * SAMPLES_PER_FRAME },
  ]);
  expect(r.resumeOffset).toBe(tag.length + FRAME_BYTES * 4);
});

test('throws on invalid frame header bytes (defensively — ffmpeg should never emit them)', () => {
  const garbage = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]);
  expect(() => SCANNER_100MS.scan(garbage, 0, false)).toThrow(/invalid mp3 frame header/);
});

test('init field is always null', () => {
  const r = SCANNER_100MS.scan(Buffer.concat([FRAME(), FRAME(), FRAME(), FRAME()]), 0, false);
  expect(r.init).toBeNull();
});

// --- real ffmpeg-encoded fixture (complements the synthetic unit tests) -------------------

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scanner',
  '__fixtures__',
);
const SAMPLE_FLAC = path.join(FIXTURES, 'sample.flac');

describe('real mp3 fixture', () => {
  let workDir: string;
  let bytes: Buffer;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'scan-mp3-fixture-'));
    const out = path.join(workDir, 'mp3.bin');
    const target: EncodeTarget = {
      format: { container: 'mp3', codec: 'mp3' },
      quality: Quality.MEDIUM,
    };
    await spawnEncoder({
      source: SAMPLE_FLAC,
      target,
      outPath: out,
      chunkDurationSeconds: 0.2,
    }).done;
    bytes = await readFile(out);
  }, 30_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test('no init, contiguous chunks cover the file, timescale is the sample rate', () => {
    const r = makeMp3Scanner(0.2).scan(bytes, 0, true);
    expect(r.init).toBeNull();
    expect(r.timescale).toBeGreaterThan(0);
    expect(r.chunks.length).toBeGreaterThanOrEqual(2);
    expect(r.chunks[0]!.byte[0]).toBe(0);
    for (let i = 1; i < r.chunks.length; i++) {
      expect(r.chunks[i]!.byte[0]).toBe(r.chunks[i - 1]!.byte[1]);
    }
    expect(r.chunks.at(-1)!.byte[1]).toBe(bytes.length);
  });

  test('cumulative sample count over the sample rate matches the ~1 s source', () => {
    const r = makeMp3Scanner(0.2).scan(bytes, 0, true);
    const ts = r.timescale!;
    const totalSamples = r.chunks.reduce((acc, c) => acc + (c.rawDuration ?? 0), 0);
    const seconds = totalSamples / ts;
    expect(seconds).toBeGreaterThan(0.9);
    expect(seconds).toBeLessThan(1.2);
  });

  test('two-slice scan yields the same chunks as a single pass (live-tail resumption)', () => {
    const whole = makeMp3Scanner(0.2).scan(bytes, 0, true);
    const sliceAt = Math.floor(bytes.length / 2);
    const first = makeMp3Scanner(0.2).scan(bytes.subarray(0, sliceAt), 0, false);
    const second = makeMp3Scanner(0.2).scan(
      bytes.subarray(first.resumeOffset),
      first.resumeOffset,
      true,
    );
    expect([...first.chunks, ...second.chunks].map((c) => c.byte)).toEqual(
      whole.chunks.map((c) => c.byte),
    );
  });
});
