/**
 * Pure, codec-aware ranking of two copies of the same recording, used to pick the canonical source when deduplicating. No DB or GraphQL imports — a leaf beside `codec.ts` so both the scanner's dedup recompute and resolvers can use it.
 *
 * All ranking inputs are the constants below. The comparator orders best-first: lossless above lossy; lossless by fidelity (resolution we can observe); lossy by a perceptual bitrate normalised across codecs.
 */

import { abbreviateCodec } from './codec.js';

/**
 * Preference order among lossless codecs, best-first. They are all bit-exact, so this is a compatibility/desirability ordering — it only breaks ties once observable fidelity (sample rate, bit depth) is equal, never overriding it.
 */
export const LOSSLESS_PRIORITY = ['flac', 'alac', 'wv', 'ape', 'tta', 'wav', 'pcm', 'dsd'] as const;

/**
 * Tie-break preference among lossy codecs, best-first. Applied only when the perceptual bitrates are equal.
 */
export const LOSSY_SOURCE_ORDER = ['opus', 'aac', 'vorbis', 'mp3', 'wma', 'mpc', 'mp2'] as const;

/**
 * Multiplier turning a codec's nominal bitrate into an MP3-equivalent perceptual bitrate, so bitrates compare meaningfully across lossy codecs (128 kbps Opus ≈ 205 kbps MP3-equivalent). Approximate and tunable; codecs absent here default to 1.
 */
export const LOSSY_BITRATE_EQUIVALENCE: Record<string, number> = {
  opus: 1.6,
  aac: 1.3,
  vorbis: 1.25,
  mp3: 1,
  wma: 0.95,
  mpc: 1.3,
  mp2: 0.7,
};

/** The fields `compareQuality` needs from a track row. */
export type QualityInput = {
  codec: string;
  isLossless: boolean;
  bitRate: number | null;
  bitDepth: number | null;
  sampleRate: number;
  sizeBytes: number;
  durationSeconds: number;
};

/** Position of `token` in `order`, or one past the end (worst) when absent. */
function rankIn(order: readonly string[], token: string): number {
  const i = order.indexOf(token);
  return i === -1 ? order.length : i;
}

/** Perceptual bitrate of a lossy source: its nominal bitrate (falling back to the average derived from size and duration for VBR, where `bitRate` is null) scaled by the codec's efficiency relative to MP3. */
function effectiveLossyBitrate(t: QualityInput): number {
  const nominal = t.bitRate ?? (t.durationSeconds > 0 ? (t.sizeBytes * 8) / t.durationSeconds : 0);
  return nominal * (LOSSY_BITRATE_EQUIVALENCE[abbreviateCodec(t.codec)] ?? 1);
}

/**
 * Order two copies of a recording best-first: a negative result ranks `a` above `b`. Lossless always outranks lossy. Two lossless sources compare by fidelity — sample rate, then bit depth, then bitrate — and only fall back to `LOSSLESS_PRIORITY` (then size) when those are equal, so a higher-resolution master is never discarded for codec preference. Two lossy sources compare by perceptual bitrate (sample rate is a poor signal for lossy), then `LOSSY_SOURCE_ORDER`, then size. Returns 0 only when nothing distinguishes them; callers append a stable tiebreak (e.g. id).
 */
export function compareQuality(a: QualityInput, b: QualityInput): number {
  if (a.isLossless !== b.isLossless) return a.isLossless ? -1 : 1;

  if (a.isLossless) {
    const byFidelity =
      b.sampleRate - a.sampleRate ||
      (b.bitDepth ?? 0) - (a.bitDepth ?? 0) ||
      (b.bitRate ?? 0) - (a.bitRate ?? 0);
    if (byFidelity !== 0) return Math.sign(byFidelity);
    const byCodec =
      rankIn(LOSSLESS_PRIORITY, abbreviateCodec(a.codec)) -
      rankIn(LOSSLESS_PRIORITY, abbreviateCodec(b.codec));
    if (byCodec !== 0) return byCodec;
    return Math.sign(b.sizeBytes - a.sizeBytes);
  }

  const byBitrate = effectiveLossyBitrate(b) - effectiveLossyBitrate(a);
  if (byBitrate !== 0) return Math.sign(byBitrate);
  const byCodec =
    rankIn(LOSSY_SOURCE_ORDER, abbreviateCodec(a.codec)) -
    rankIn(LOSSY_SOURCE_ORDER, abbreviateCodec(b.codec));
  if (byCodec !== 0) return byCodec;
  return Math.sign(b.sizeBytes - a.sizeBytes);
}
