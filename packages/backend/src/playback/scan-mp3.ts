/**
 * Live-tail scanner for an unsegmented mp3 stream — a sequence of MPEG audio frames with no container envelope. Walks frame-by-frame (each frame's header carries its own length), accumulates sample counts, and emits a chunk whenever the accumulator crosses the target window boundary. mp3 has no init segment so `init` is always null. Returns a `Scanner` from a factory so the target window can be configured (default 6 seconds; tests use smaller windows to keep fixtures compact).
 */

import { DEFAULT_CHUNK_DURATION_SECONDS } from '../config.js';
import type { ScannedChunk, Scanner,ScanResult } from './scan-types.js';

const BITRATE_KBPS: Record<string, readonly number[]> = {
  '1-1':  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  '1-2':  [0, 32, 48, 56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  '1-3':  [0, 32, 40, 48,  56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, 0],
  '2-1':  [0, 32, 48, 56,  64,  80,  96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  '2-2':  [0,  8, 16, 24,  32,  40,  48,  56,  64,  80,  96, 112, 128, 144, 160, 0],
  '2-3':  [0,  8, 16, 24,  32,  40,  48,  56,  64,  80,  96, 112, 128, 144, 160, 0],
  '25-1': [0, 32, 48, 56,  64,  80,  96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  '25-2': [0,  8, 16, 24,  32,  40,  48,  56,  64,  80,  96, 112, 128, 144, 160, 0],
  '25-3': [0,  8, 16, 24,  32,  40,  48,  56,  64,  80,  96, 112, 128, 144, 160, 0],
};

const SAMPLE_RATE_HZ: Record<1 | 2 | 25, readonly number[]> = {
  1:  [44100, 48000, 32000, 0],
  2:  [22050, 24000, 16000, 0],
  25: [11025, 12000,  8000, 0],
};

type Decoded = {
  frameLength: number;
  samples: number;
  sampleRateHz: number;
};

function decodeHeader(buf: Buffer, offset: number): Decoded | null {
  if (offset + 4 > buf.length) return null;
  const b0 = buf[offset]!;
  const b1 = buf[offset + 1]!;
  const b2 = buf[offset + 2]!;
  // 11-bit frame sync: 0xFF in b0 plus top 3 bits of b1.
  if (b0 !== 0xff) return null;
  if ((b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0b11;
  const layerBits = (b1 >> 1) & 0b11;
  if (versionBits === 1) return null;
  if (layerBits === 0) return null;
  const version: 1 | 2 | 25 = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer: 1 | 2 | 3 = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const bitrateIdx = (b2 >> 4) & 0b1111;
  const srIdx = (b2 >> 2) & 0b11;
  const padding = (b2 >> 1) & 0b1;
  if (bitrateIdx === 0 || bitrateIdx === 15) return null;
  if (srIdx === 3) return null;
  const bitrateKbps = BITRATE_KBPS[`${version}-${layer}`]?.[bitrateIdx];
  const sampleRateHz = SAMPLE_RATE_HZ[version][srIdx];
  if (!bitrateKbps || !sampleRateHz) return null;
  let samples: number;
  if (layer === 1) samples = 384;
  else if (layer === 2) samples = 1152;
  else samples = version === 1 ? 1152 : 576;
  let frameLength: number;
  if (layer === 1) {
    frameLength = (Math.floor((12 * bitrateKbps * 1000) / sampleRateHz) + padding) * 4;
  } else {
    const coeff = layer === 2 ? 144 : version === 1 ? 144 : 72;
    frameLength = Math.floor((coeff * bitrateKbps * 1000) / sampleRateHz) + padding;
  }
  return { frameLength, samples, sampleRateHz };
}

/** Detect and skip an ID3v2 tag at the start of the file. Only ever runs on the very first scan call (when `baseOffset === 0`); subsequent calls resume past any tag the first call advanced over. */
function skipId3v2(buf: Buffer, baseOffset: number): number {
  if (baseOffset !== 0) return 0;
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  // syncsafe size: 7 useful bits per byte over bytes 6..9.
  const size =
    ((buf[6]! & 0x7f) << 21) |
    ((buf[7]! & 0x7f) << 14) |
    ((buf[8]! & 0x7f) << 7) |
    (buf[9]! & 0x7f);
  return 10 + size;
}

/** Build a scanner that emits chunks when the per-window sample accumulator crosses `targetWindowSeconds * sampleRate`. */
export function makeMp3Scanner(targetWindowSeconds = DEFAULT_CHUNK_DURATION_SECONDS): Scanner {
  return {
    scan(buf: Buffer, baseOffset: number, isFinal: boolean): ScanResult {
      const chunks: ScannedChunk[] = [];
      let pos = skipId3v2(buf, baseOffset);
      let windowStart = baseOffset + pos;
      let accumulatedSamples = 0;
      let lastSampleRate = 0;
      while (pos + 4 <= buf.length) {
        const decoded = decodeHeader(buf, pos);
        if (!decoded) {
          throw new Error(`invalid mp3 frame header at offset ${baseOffset + pos}`);
        }
        if (pos + decoded.frameLength > buf.length) break;
        accumulatedSamples += decoded.samples;
        lastSampleRate = decoded.sampleRateHz;
        pos += decoded.frameLength;
        if (accumulatedSamples >= targetWindowSeconds * lastSampleRate) {
          const frameEnd = baseOffset + pos;
          chunks.push({
            byte: [windowStart, frameEnd],
            durationSeconds: accumulatedSamples / lastSampleRate,
          });
          windowStart = frameEnd;
          accumulatedSamples = 0;
        }
      }
      let resumeOffset = windowStart;
      if (isFinal && accumulatedSamples > 0) {
        const fileEnd = baseOffset + pos;
        chunks.push({
          byte: [windowStart, fileEnd],
          durationSeconds: lastSampleRate > 0 ? accumulatedSamples / lastSampleRate : 0,
        });
        resumeOffset = fileEnd;
      }
      return { init: null, chunks, resumeOffset };
    },
  };
}

