import { makeMp3Scanner } from './scan-mp3.js';

/** Build a single MPEG1 Layer 3 frame at the given bitrate + sample rate. Tail bytes are zero-filled — they aren't decoded by the scanner. */
function frameMpeg1L3(bitrateKbps: number, sampleRateHz: 44100 | 48000 | 32000): Buffer {
  const table = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const bitrateIdx = table.indexOf(bitrateKbps);
  if (bitrateIdx < 1) throw new Error(`unsupported bitrate ${bitrateKbps}`);
  const srIdx = sampleRateHz === 44100 ? 0 : sampleRateHz === 48000 ? 1 : 2;
  const frameLength = Math.floor((144 * bitrateKbps * 1000) / sampleRateHz);
  // sync(11) | version=MPEG1(2) | layer=L3(2) | noCrc(1)
  const b1 = 0b11111011;
  // bitrateIdx(4) | srIdx(2) | padding=0(1) | private=0(1)
  const b2 = (bitrateIdx << 4) | (srIdx << 2);
  // stereo / no extension / not copyrighted / original / no emphasis
  const b3 = 0;
  const buf = Buffer.alloc(frameLength, 0);
  buf[0] = 0xff;
  buf[1] = b1;
  buf[2] = b2;
  buf[3] = b3;
  return buf;
}

// At 32 kbps / 44.1 kHz / MPEG1 L3: 144 * 32000 / 44100 = 104 bytes/frame, 1152 samples/frame.
// Frames-per-window at a target of 0.1 s = ceil(4410 / 1152) = 4 frames; per-window byte size = 416.
const SCANNER_100MS = makeMp3Scanner(0.1);
const FRAME = (): Buffer => frameMpeg1L3(32, 44100);
const FRAME_BYTES = 104;
const SAMPLES_PER_FRAME = 1152;
const SR = 44100;
const FOUR_FRAME_SECS = (4 * SAMPLES_PER_FRAME) / SR;

test('emits one chunk per completed window and parks resume at the in-progress window start', () => {
  // 9 frames → 2 complete windows of 4 frames + 1 frame in progress.
  const frames = Array.from({ length: 9 }, () => FRAME());
  const buf = Buffer.concat(frames);
  const r = SCANNER_100MS.scan(buf, 0, false);
  expect(r.init).toBeNull();
  expect(r.chunks).toEqual([
    { byte: [0, FRAME_BYTES * 4], durationSeconds: FOUR_FRAME_SECS },
    { byte: [FRAME_BYTES * 4, FRAME_BYTES * 8], durationSeconds: FOUR_FRAME_SECS },
  ]);
  expect(r.resumeOffset).toBe(FRAME_BYTES * 8);
});

test('isFinal=true flushes the trailing in-progress window with actual sample-derived duration', () => {
  // 6 frames → 1 complete window (4 frames) + a trailing window of 2 frames.
  const frames = Array.from({ length: 6 }, () => FRAME());
  const buf = Buffer.concat(frames);
  const r = SCANNER_100MS.scan(buf, 0, true);
  expect(r.chunks).toEqual([
    { byte: [0, FRAME_BYTES * 4], durationSeconds: FOUR_FRAME_SECS },
    {
      byte: [FRAME_BYTES * 4, FRAME_BYTES * 6],
      durationSeconds: (2 * SAMPLES_PER_FRAME) / SR,
    },
  ]);
  expect(r.resumeOffset).toBe(FRAME_BYTES * 6);
});

test('isFinal=true with no accumulated samples emits nothing extra', () => {
  // 8 frames = exactly 2 windows; nothing pending.
  const buf = Buffer.concat(Array.from({ length: 8 }, () => FRAME()));
  const r = SCANNER_100MS.scan(buf, 0, true);
  expect(r.chunks).toEqual([
    { byte: [0, FRAME_BYTES * 4], durationSeconds: FOUR_FRAME_SECS },
    { byte: [FRAME_BYTES * 4, FRAME_BYTES * 8], durationSeconds: FOUR_FRAME_SECS },
  ]);
  expect(r.resumeOffset).toBe(FRAME_BYTES * 8);
});

test('truncated trailing frame parks resume at the in-progress window start', () => {
  // 5 frames + 2 bytes of a 6th — incomplete.
  const buf = Buffer.concat([
    ...Array.from({ length: 5 }, () => FRAME()),
    Buffer.from([0xff, 0xfb]),
  ]);
  const r = SCANNER_100MS.scan(buf, 0, false);
  expect(r.chunks).toEqual([
    { byte: [0, FRAME_BYTES * 4], durationSeconds: FOUR_FRAME_SECS },
  ]);
  expect(r.resumeOffset).toBe(FRAME_BYTES * 4);
});

test('resuming from a non-zero baseOffset emits file-absolute ranges', () => {
  const base = 5000;
  const buf = Buffer.concat(Array.from({ length: 4 }, () => FRAME()));
  const r = SCANNER_100MS.scan(buf, base, false);
  expect(r.chunks).toEqual([
    { byte: [base, base + FRAME_BYTES * 4], durationSeconds: FOUR_FRAME_SECS },
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
  const frames = Buffer.concat(Array.from({ length: 4 }, () => FRAME()));
  const buf = Buffer.concat([tag, frames]);
  const r = SCANNER_100MS.scan(buf, 0, false);
  expect(r.chunks).toEqual([
    { byte: [tag.length, tag.length + FRAME_BYTES * 4], durationSeconds: FOUR_FRAME_SECS },
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

test('default 6-second window: confirm threshold logic and per-chunk duration', () => {
  // Default scanner. 6 s × 44100 = 264600 samples. 1152 samples/frame → ceil(264600/1152) = 230 frames per window.
  // Actual emitted duration per window: 230 × 1152 / 44100 ≈ 6.008 s.
  const scanner = makeMp3Scanner();
  const frames = Array.from({ length: 460 }, () => FRAME());
  const buf = Buffer.concat(frames);
  const r = scanner.scan(buf, 0, false);
  const winDuration = (230 * SAMPLES_PER_FRAME) / SR;
  expect(r.chunks).toEqual([
    { byte: [0, FRAME_BYTES * 230], durationSeconds: winDuration },
    { byte: [FRAME_BYTES * 230, FRAME_BYTES * 460], durationSeconds: winDuration },
  ]);
});
