import { compareQuality, type QualityInput } from './quality.js';

function track(p: Partial<QualityInput>): QualityInput {
  return {
    codec: 'flac',
    isLossless: true,
    bitRate: null,
    bitDepth: 16,
    sampleRate: 44_100,
    sizeBytes: 1_000_000,
    durationSeconds: 200,
    ...p,
  };
}

/** True when `a` ranks strictly above `b` (is the better source). */
function ranksAbove(a: QualityInput, b: QualityInput): boolean {
  return compareQuality(a, b) < 0 && compareQuality(b, a) > 0;
}

const flac = (p: Partial<QualityInput> = {}) => track({ codec: 'flac', isLossless: true, ...p });
const lossy = (codec: string, bitRate: number, p: Partial<QualityInput> = {}) =>
  track({ codec, isLossless: false, bitDepth: null, bitRate, ...p });

test('lossless outranks lossy regardless of bitrate', () => {
  expect(ranksAbove(flac({ bitRate: 900_000 }), lossy('mp3', 320_000))).toBe(true);
});

test('lossless ranks by sample rate before bit depth — higher rate need not mean higher bitrate', () => {
  const hiRate = flac({ sampleRate: 96_000, bitDepth: 16, bitRate: 800_000 });
  const hiDepth = flac({ sampleRate: 44_100, bitDepth: 24, bitRate: 1_200_000 });
  expect(ranksAbove(hiRate, hiDepth)).toBe(true);
});

test('lossless falls back to codec preference only on a genuine fidelity tie', () => {
  const f = flac({ sampleRate: 44_100, bitDepth: 16, bitRate: 900_000 });
  const a = flac({ codec: 'alac', sampleRate: 44_100, bitDepth: 16, bitRate: 900_000 });
  expect(ranksAbove(f, a)).toBe(true);
});

test('lossy normalises bitrate across codecs: 128k opus beats 192k mp3', () => {
  expect(ranksAbove(lossy('opus', 128_000), lossy('mp3', 192_000))).toBe(true);
});

test('lossy prefers the higher bitrate within a codec', () => {
  expect(ranksAbove(lossy('mp3', 320_000), lossy('mp3', 96_000))).toBe(true);
});

test('VBR (null bitrate) falls back to size÷duration', () => {
  // ~256 kbps from size/duration, beating a 96k CBR mp3.
  const vbr = lossy('mp3', null as unknown as number, {
    sizeBytes: 6_400_000,
    durationSeconds: 200,
  });
  expect(ranksAbove(vbr, lossy('mp3', 96_000))).toBe(true);
});

test('a shuffled group sorts canonical-first', () => {
  const group: { label: string; t: QualityInput }[] = [
    { label: 'mp3-96', t: lossy('mp3', 96_000) },
    { label: 'flac-44/16', t: flac({ sampleRate: 44_100, bitDepth: 16, bitRate: 900_000 }) },
    { label: 'opus-128', t: lossy('opus', 128_000) },
    { label: 'flac-96/24', t: flac({ sampleRate: 96_000, bitDepth: 24, bitRate: 2_400_000 }) },
    { label: 'mp3-320', t: lossy('mp3', 320_000) },
  ];
  const order = group
    .slice()
    .sort((x, y) => compareQuality(x.t, y.t) || x.label.localeCompare(y.label))
    .map((g) => g.label);
  expect(order).toMatchInlineSnapshot(`
    [
      "flac-96/24",
      "flac-44/16",
      "mp3-320",
      "opus-128",
      "mp3-96",
    ]
  `);
});
