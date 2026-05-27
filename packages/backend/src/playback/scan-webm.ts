/**
 * Live-tail scanner for WebM produced by ffmpeg's webm muxer with `-dash 1` (keyframe-aligned, known-size clusters + a trailing Cues element). Pure function: each call re-parses from `baseOffset`, which the caller positions at the most recent `Cluster` (or 0 on the first call, where it also walks the EBML header + Segment metadata that make up the init segment).
 *
 * The WebM analogue of fmp4's `moof`/`mdat` fragment is the `Cluster`: one self-contained EBML master element that opens with an absolute `Timecode` (in `TimecodeScale` units) and then carries the audio blocks. A cluster's `rawDuration` is the delta to the *next* cluster's `Timecode`, so — exactly like the fmp4 scanner — the most recent cluster is held pending and finalised only when the following one is observed. The trailing cluster has no successor, so its duration is recovered from its own block timecodes (the WebM counterpart of fmp4's `trun` fallback): the last block's relative timecode plus the spacing to the previous one, which is what keeps end-of-track detection accurate instead of overshooting by a whole nominal chunk. `timescale` (ticks per second) is derived from the Segment's `TimecodeScale` (nanoseconds per tick, default 1 ms).
 *
 * The init segment is everything before the first `Cluster` (EBML header, Segment header, SeekHead, Info, Tracks); clients prepend it to the SourceBuffer before any cluster, just as with fmp4's `moov`.
 */

import type { ChunkRange, ScannedChunk, Scanner, ScanResult } from './scan-types.js';

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;

const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

/** Number of bytes in the variable-length integer starting at `buf[pos]`, from the position of its leading set bit. `0` signals an invalid first byte (no marker in the low 8 bits). */
function vintLength(b: number): number {
  let mask = 0x80;
  for (let len = 1; len <= 8; len++) {
    if (b & mask) return len;
    mask >>= 1;
  }
  return 0;
}

/** Read an EBML element ID (marker bits retained, so it matches the `ID_*` constants). IDs are at most 4 bytes. Returns `null` if it doesn't fit or is malformed. */
function readId(buf: Buffer, pos: number): { id: number; length: number } | null {
  if (pos >= buf.length) return null;
  const length = vintLength(buf[pos]!);
  if (length < 1 || length > 4 || pos + length > buf.length) return null;
  return { id: buf.readUIntBE(pos, length), length };
}

/** Read an EBML data-size VINT (marker bits stripped). `unknown` is set for the all-ones streaming sentinel. Returns `null` if it doesn't fit. */
function readSize(
  buf: Buffer,
  pos: number,
): { value: number; unknown: boolean; length: number } | null {
  if (pos >= buf.length) return null;
  const length = vintLength(buf[pos]!);
  if (length < 1 || length > 8 || pos + length > buf.length) return null;
  let value = buf[pos]! & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = buf[pos + i]!;
    if (byte !== 0xff) unknown = false;
    value = value * 256 + byte;
  }
  return { value, unknown, length };
}

/** Read a big-endian unsigned integer of `len` bytes (EBML uint payloads are short). */
function readUint(buf: Buffer, start: number, len: number): number {
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + buf[start + i]!;
  return value;
}

/** Walk a master element's children in `[start, end)`, invoking `onChild` until it returns `true` (stop) or the range is exhausted. Best-effort: stops quietly on a malformed or truncated child. */
function eachChild(
  buf: Buffer,
  start: number,
  end: number,
  onChild: (id: number, contentStart: number, contentEnd: number) => boolean,
): void {
  let pos = start;
  while (pos < end) {
    const idr = readId(buf, pos);
    if (!idr) return;
    const sz = readSize(buf, pos + idr.length);
    if (!sz || sz.unknown) return;
    const contentStart = pos + idr.length + sz.length;
    const contentEnd = contentStart + sz.value;
    if (contentEnd > end) return;
    if (onChild(idr.id, contentStart, contentEnd)) return;
    pos = contentEnd;
  }
}

/** A cluster's `Timecode` (absolute, in TimecodeScale units). Reads children until the timecode or the first block. */
function parseClusterTimecode(buf: Buffer, start: number, end: number): number | null {
  let timecode: number | null = null;
  eachChild(buf, start, end, (id, cs, ce) => {
    if (id === ID_TIMECODE) {
      timecode = readUint(buf, cs, ce - cs);
      return true;
    }
    // Timecode is mandated to precede the blocks; stop once block data begins.
    return id === ID_SIMPLE_BLOCK || id === ID_BLOCK_GROUP;
  });
  return timecode;
}

/** A (Simple)Block's signed timecode, relative to its cluster's Timecode. The block payload opens with a track-number VINT, then a 16-bit big-endian relative timecode. */
function readBlockRelTimecode(
  buf: Buffer,
  blockContentStart: number,
  blockContentEnd: number,
): number | null {
  const track = readSize(buf, blockContentStart);
  if (!track) return null;
  const at = blockContentStart + track.length;
  if (at + 2 > blockContentEnd || at + 2 > buf.length) return null;
  return buf.readInt16BE(at);
}

/**
 * Estimate a trailing cluster's covered duration (in TimecodeScale units) from its block timecodes. The blocks carry no explicit duration, so this takes the last block's relative timecode plus the spacing to the previous block, approximating the final block's own span. Returns `null` when fewer than one block is present (driver then falls back to nominal).
 */
function parseTrailingClusterDuration(buf: Buffer, start: number, end: number): number | null {
  let last: number | null = null;
  let prev: number | null = null;
  eachChild(buf, start, end, (id, cs, ce) => {
    let rel: number | null = null;
    if (id === ID_SIMPLE_BLOCK) {
      rel = readBlockRelTimecode(buf, cs, ce);
    } else if (id === ID_BLOCK_GROUP) {
      eachChild(buf, cs, ce, (cid, ccs, cce) => {
        if (cid === ID_BLOCK) {
          rel = readBlockRelTimecode(buf, ccs, cce);
          return true;
        }
        return false;
      });
    }
    if (rel !== null) {
      prev = last;
      last = rel;
    }
    return false;
  });
  if (last === null) return null;
  // Add the inter-block spacing so the final block's own duration is counted, not just its start.
  return prev !== null ? last + (last - prev) : last;
}

/** Nanoseconds-per-tick from a Segment `Info` element's `TimecodeScale`, defaulting to the WebM default when absent. */
function parseTimecodeScale(buf: Buffer, start: number, end: number): number {
  let scale = DEFAULT_TIMECODE_SCALE_NS;
  eachChild(buf, start, end, (id, cs, ce) => {
    if (id === ID_TIMECODE_SCALE) {
      scale = readUint(buf, cs, ce - cs);
      return true;
    }
    return false;
  });
  return scale;
}

function scan(buf: Buffer, baseOffset: number, isFinal: boolean): ScanResult {
  const chunks: ScannedChunk[] = [];
  let firstClusterOffset: number | null = null;
  let pendingOffset: number | null = null;
  let pendingTimecode: number | null = null;
  let pendingEnd: number | null = null;
  // Buffer-relative content range of the pending cluster, for recovering the trailing cluster's duration from its blocks.
  let pendingContentStart: number | null = null;
  let pendingContentEnd: number | null = null;
  let timecodeScaleNs: number | null = null;
  let pos = 0;

  while (pos < buf.length) {
    const idr = readId(buf, pos);
    if (!idr) break;
    const sz = readSize(buf, pos + idr.length);
    if (!sz) break;
    const headerLen = idr.length + sz.length;
    const contentStart = pos + headerLen;

    if (baseOffset === 0 && idr.id === ID_SEGMENT) {
      // Descend into the Segment master; its children (metadata, then clusters) are walked inline.
      pos = contentStart;
      continue;
    }
    if (idr.id === ID_CLUSTER) {
      const offset = baseOffset + pos;
      // The Timecode sits at the cluster's head, so it's readable even when the body is still streaming in.
      const timecode = parseClusterTimecode(buf, contentStart, contentStart + sz.value);
      if (pendingOffset !== null) {
        const rawDuration =
          timecode !== null && pendingTimecode !== null ? timecode - pendingTimecode : null;
        chunks.push({ byte: [pendingOffset, offset], rawDuration });
      }
      if (firstClusterOffset === null) firstClusterOffset = offset;
      pendingOffset = offset;
      pendingTimecode = timecode;
      pendingContentStart = contentStart;
      pendingContentEnd = contentStart + sz.value;
      // Need the whole cluster present to advance to the next; otherwise leave it pending and re-read.
      if (sz.unknown || contentStart + sz.value > buf.length) break;
      pendingEnd = baseOffset + contentStart + sz.value;
      pos = contentStart + sz.value;
      continue;
    }
    // Init metadata (baseOffset 0) or a trailing Cues/Void after the last cluster: skip by size.
    if (baseOffset === 0 && idr.id === ID_INFO) {
      if (contentStart + sz.value > buf.length) break;
      timecodeScaleNs = parseTimecodeScale(buf, contentStart, contentStart + sz.value);
    }
    if (sz.unknown || contentStart + sz.value > buf.length) break;
    pos = contentStart + sz.value;
  }

  const init: ChunkRange | null =
    baseOffset === 0 && firstClusterOffset !== null ? [0, firstClusterOffset] : null;
  const timescale =
    baseOffset === 0 ? 1_000_000_000 / (timecodeScaleNs ?? DEFAULT_TIMECODE_SCALE_NS) : null;

  let resumeOffset = baseOffset + pos;
  if (pendingOffset !== null) {
    if (isFinal) {
      const end = pendingEnd ?? baseOffset + pos;
      // Trailing cluster has no successor to delta against; recover its duration from its own block
      // timecodes (null only if no block is parseable, then the driver falls back to nominal).
      const rawDuration =
        pendingContentStart !== null && pendingContentEnd !== null
          ? parseTrailingClusterDuration(
              buf,
              pendingContentStart,
              Math.min(pendingContentEnd, buf.length),
            )
          : null;
      chunks.push({ byte: [pendingOffset, end], rawDuration });
    } else {
      // Park at the in-progress cluster so the next call re-observes it and finalises it once the following cluster lands.
      resumeOffset = pendingOffset;
    }
  } else if (baseOffset === 0 && !isFinal) {
    // Read the init region but no cluster yet — the init range is still unknown, and `init` is only
    // emitted on a `baseOffset === 0` scan, so rewind to 0 rather than advance past the metadata and
    // lose the init segment permanently.
    resumeOffset = 0;
  }
  return { init, timescale, chunks, resumeOffset };
}

export const webmScanner: Scanner = { scan };
