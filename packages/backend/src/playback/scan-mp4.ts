/**
 * Live-tail scanner for fragmented mp4 produced by ffmpeg with `+frag_keyframe+empty_moov+default_base_moof`. Pure function: each call re-parses from `baseOffset`, which the caller positions at the most recent `moof` (or 0 on the first call). Within a buffer, the first `moof` becomes a pending fragment whose end is finalised when the next `moof` arrives; if `isFinal` is true the trailing fragment is finalised at the file's end.
 *
 * Per-chunk duration is reported as the `nominalChunkDurationSeconds` configured on the factory — this matches the `-frag_duration` ffmpeg is told to write. Small drift between nominal and actual is acceptable; for exact timing we'd need to parse `tfhd`/`trun` boxes, which is deferred.
 */

import type { ChunkRange, ScannedChunk, Scanner,ScanResult } from './scan-types.js';

/** Build a scanner that tags each emitted chunk with `nominalChunkDurationSeconds`. Pass the same value used in ffmpeg's `-frag_duration`. */
export function makeMp4Scanner(nominalChunkDurationSeconds: number): Scanner {
  return {
    scan(buf: Buffer, baseOffset: number, isFinal: boolean): ScanResult {
      const chunks: ScannedChunk[] = [];
      let firstMoofOffset: number | null = null;
      let pendingMoofOffset: number | null = null;
      let pos = 0;
      while (pos + 8 <= buf.length) {
        const size32 = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        let size: number;
        let headerSize = 8;
        if (size32 === 1) {
          if (pos + 16 > buf.length) break;
          const hi = buf.readUInt32BE(pos + 8);
          const lo = buf.readUInt32BE(pos + 12);
          if (hi !== 0) throw new Error('box larger than 4 GiB not supported');
          size = lo;
          headerSize = 16;
        } else if (size32 === 0) {
          throw new Error(
            `size-0 box at offset ${baseOffset + pos} not expected in fragmented mp4`,
          );
        } else {
          size = size32;
        }
        if (size < headerSize) {
          throw new Error(`invalid box size ${size} at offset ${baseOffset + pos}`);
        }
        if (pos + size > buf.length) break;
        if (type === 'moof') {
          const offset = baseOffset + pos;
          if (pendingMoofOffset !== null) {
            chunks.push({
              byte: [pendingMoofOffset, offset],
              durationSeconds: nominalChunkDurationSeconds,
            });
          }
          if (firstMoofOffset === null) firstMoofOffset = offset;
          pendingMoofOffset = offset;
        }
        pos += size;
      }
      const init: ChunkRange | null =
        baseOffset === 0 && firstMoofOffset !== null ? [0, firstMoofOffset] : null;
      let resumeOffset = baseOffset + pos;
      if (pendingMoofOffset !== null) {
        if (isFinal) {
          const fileEnd = baseOffset + pos;
          chunks.push({
            byte: [pendingMoofOffset, fileEnd],
            durationSeconds: nominalChunkDurationSeconds,
          });
          resumeOffset = fileEnd;
        } else {
          // Park the cursor at the start of the in-progress fragment so the next call observes the same moof and can finalise it when a subsequent moof arrives.
          resumeOffset = pendingMoofOffset;
        }
      }
      return { init, chunks, resumeOffset };
    },
  };
}
