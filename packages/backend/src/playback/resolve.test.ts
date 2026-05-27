import { Quality } from '../graphql/playback-format.js';
import type { EncodeFormat } from './encoder.js';
import { ResolveError, type ResolveSource, resolveTarget } from './resolve.js';

const FLAC = 'audio/mp4; codecs="flac"';
const OPUS_MP4 = 'audio/mp4; codecs="opus"';
const OPUS_WEBM = 'audio/webm; codecs="opus"';
const VORBIS_WEBM = 'audio/webm; codecs="vorbis"';
const MP3 = 'audio/mpeg';

const lossless = (codec: string): ResolveSource => ({ isLossless: true, sourceCodec: codec });
const lossy = (codec: string): ResolveSource => ({ isLossless: false, sourceCodec: codec });

function fmt(t: { format: EncodeFormat }): string {
  return `${t.format.container}/${t.format.codec}`;
}

// --- below MAX: always transcode to the first producible lossy entry -----------------------

test('below MAX transcodes to the first transcodable lossy format', () => {
  const t = resolveTarget(lossy('vorbis'), {
    quality: Quality.MEDIUM,
    lossyFormats: [OPUS_WEBM, OPUS_MP4, MP3],
  });
  expect(fmt(t)).toBe('webm/opus');
  expect(t.quality).toBe(Quality.MEDIUM);
});

test('below MAX skips copy-only Vorbis and picks the first codec it can encode', () => {
  const t = resolveTarget(lossy('vorbis'), {
    quality: Quality.LOW,
    lossyFormats: [VORBIS_WEBM, MP3],
  });
  expect(fmt(t)).toBe('mp3/mp3');
});

test('below MAX with no encodable lossy format throws', () => {
  expect(() =>
    resolveTarget(lossy('vorbis'), { quality: Quality.LOW, lossyFormats: [VORBIS_WEBM] }),
  ).toThrow(ResolveError);
});

test('empty lossyFormats always throws', () => {
  expect(() => resolveTarget(lossy('mp3'), { quality: Quality.MAX, lossyFormats: [] })).toThrow(
    ResolveError,
  );
});

// --- MAX, lossless source ------------------------------------------------------------------

test('MAX lossless source uses the first supported lossless format', () => {
  const t = resolveTarget(lossless('flac'), {
    quality: Quality.MAX,
    losslessFormats: [FLAC],
    lossyFormats: [OPUS_MP4],
  });
  expect(fmt(t)).toBe('mp4/flac');
});

test('MAX lossless source falls back to lossy when no lossless format is supported', () => {
  const t = resolveTarget(lossless('alac'), {
    quality: Quality.MAX,
    losslessFormats: [],
    lossyFormats: [OPUS_MP4],
  });
  expect(fmt(t)).toBe('mp4/opus');
});

// --- MAX, lossy source: copy when the codec matches, else transcode ------------------------

test('MAX Vorbis source copies into webm/vorbis when supported', () => {
  const t = resolveTarget(lossy('vorbis'), {
    quality: Quality.MAX,
    lossyFormats: [OPUS_MP4, VORBIS_WEBM, MP3],
  });
  expect(fmt(t)).toBe('webm/vorbis');
});

test('MAX Vorbis source on an mp4-only (Safari) client transcodes to opus', () => {
  const t = resolveTarget(lossy('vorbis'), { quality: Quality.MAX, lossyFormats: [OPUS_MP4, MP3] });
  expect(fmt(t)).toBe('mp4/opus');
});

test('MAX Opus source copies into the first matching container by preference', () => {
  const t = resolveTarget(lossy('opus'), {
    quality: Quality.MAX,
    lossyFormats: [OPUS_WEBM, OPUS_MP4],
  });
  expect(fmt(t)).toBe('webm/opus');
});

test('MAX mp3 source copies into audio/mpeg (codec match without a codecs= param)', () => {
  const t = resolveTarget(lossy('mp3'), { quality: Quality.MAX, lossyFormats: [OPUS_MP4, MP3] });
  expect(fmt(t)).toBe('mp3/mp3');
});

test('unproducible MIME types are ignored', () => {
  const t = resolveTarget(lossy('vorbis'), {
    quality: Quality.MAX,
    lossyFormats: ['audio/aac', 'audio/ogg; codecs="vorbis"', OPUS_MP4],
  });
  expect(fmt(t)).toBe('mp4/opus');
});
