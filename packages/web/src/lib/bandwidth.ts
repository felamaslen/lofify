/**
 * Download-throughput estimation for adaptive bitrate. A sample is one chunk fetch: bytes transferred and the wall-clock time spent receiving the body, *excluding* TTFB. Excluding TTFB matters here beyond the usual: the `/play` route blocks until the requested byte range is fully encoded before sending a byte, so TTFB is often dominated by encode-wait rather than the network; only the first-byte-to-last-byte window reflects line speed.
 *
 * The estimate is two EWMAs with different half-lives (the hls.js approach): the fast one reacts to a sudden drop, the slow one resists transient spikes. The reader takes the lower of the two so we err towards the safer (lower) bandwidth and don't over-commit to a tier the link can't sustain.
 *
 * State is a plain immutable value rather than an object with methods: `addSample` returns the next value, `bytesPerSecond` reads it. The caller holds the current value (a ref in the player).
 */

/** Half-lives in samples — how many recent fetches each average is effectively weighted over. */
const FAST_HALF_LIFE = 3;
const SLOW_HALF_LIFE = 8;
const FAST_ALPHA = 0.5 ** (1 / FAST_HALF_LIFE);
const SLOW_ALPHA = 0.5 ** (1 / SLOW_HALF_LIFE);
/** Minimum samples before `bytesPerSecond` returns a value rather than `null`. */
const MIN_SAMPLES = 2;

/** One EWMA: the raw accumulator and how many samples have landed (for bias correction). */
type Ewma = { accumulator: number; samples: number };

export type BandwidthEstimate = { fast: Ewma; slow: Ewma };

export function emptyBandwidthEstimate(): BandwidthEstimate {
  return { fast: { accumulator: 0, samples: 0 }, slow: { accumulator: 0, samples: 0 } };
}

function sampleEwma(e: Ewma, alpha: number, value: number): Ewma {
  return { accumulator: value * (1 - alpha) + alpha * e.accumulator, samples: e.samples + 1 };
}

/** Bias-corrected average (undoes the cold-start pull towards the initial 0). */
function ewmaValue(e: Ewma, alpha: number): number {
  const zeroFactor = 1 - alpha ** e.samples;
  return zeroFactor === 0 ? 0 : e.accumulator / zeroFactor;
}

/** Fold one sample in: `bytes` received over `transferMs` of body transfer (TTFB already excluded). */
export function addSample(
  estimate: BandwidthEstimate,
  bytes: number,
  transferMs: number,
): BandwidthEstimate {
  if (bytes <= 0) return estimate;
  const bytesPerSecond = (bytes * 1000) / Math.max(transferMs, 1);
  return {
    fast: sampleEwma(estimate.fast, FAST_ALPHA, bytesPerSecond),
    slow: sampleEwma(estimate.slow, SLOW_ALPHA, bytesPerSecond),
  };
}

/** Conservative throughput in bytes/second, or `null` until enough samples have landed. */
export function bytesPerSecond(estimate: BandwidthEstimate): number | null {
  if (estimate.fast.samples < MIN_SAMPLES) return null;
  return Math.min(ewmaValue(estimate.fast, FAST_ALPHA), ewmaValue(estimate.slow, SLOW_ALPHA));
}
