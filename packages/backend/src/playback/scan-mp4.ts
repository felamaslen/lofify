/**
 * Live-tail scanner for fragmented mp4 produced by ffmpeg with `+frag_keyframe+empty_moov+default_base_moof`. Pure function: each call re-parses from `baseOffset`, which the caller positions at the most recent `moof` (or 0 on the first call). Within a buffer, the first `moof` begins a pending fragment whose byte end is finalised when the next `moof` arrives; if `isFinal` is true the trailing fragment is finalised at the file's end.
 *
 * Per-chunk duration comes from the real media timeline, not a nominal constant: the timescale is read from the init segment's `mdhd`, and each fragment's `tfdt` (track-fragment base-media-decode-time) gives its start. A fragment's `rawDuration` is `tfdt[next] - tfdt[this]`. ffmpeg's `-frag_duration` only cuts on frame boundaries, so fragments overshoot the nominal duration (notably for FLAC's large frames); reading the true `tfdt` keeps the manifest's time axis aligned with the bytes, which is what seeking relies on. The trailing fragment has no next `tfdt`, so its duration is recovered from its own `trun` sample durations (the last fragment is usually a short remainder, far below nominal — getting this right is what lets the player detect end-of-track); `rawDuration` is `null` only when no `trun`/`tfhd` timing can be parsed, and the driver then falls back to the nominal duration.
 */

import type { ChunkRange, ScannedChunk, Scanner,ScanResult } from './scan-types.js';

type BoxHeader = { type: string; size: number; headerSize: number };

/** Read a box header at `pos`. Returns `null` if the 8-byte (or 16-byte large-size) header doesn't fit in `buf`. Throws on structurally invalid sizes. */
function readBoxHeader(buf: Buffer, pos: number): BoxHeader | null {
  if (pos + 8 > buf.length) return null;
  const size32 = buf.readUInt32BE(pos);
  const type = buf.toString('ascii', pos + 4, pos + 8);
  if (size32 === 1) {
    if (pos + 16 > buf.length) return null;
    const hi = buf.readUInt32BE(pos + 8);
    const lo = buf.readUInt32BE(pos + 12);
    if (hi !== 0) throw new Error('box larger than 4 GiB not supported');
    if (lo < 16) throw new Error(`invalid box size ${lo} at offset ${pos}`);
    return { type, size: lo, headerSize: 16 };
  }
  if (size32 === 0) {
    throw new Error(`size-0 box at offset ${pos} not expected in fragmented mp4`);
  }
  if (size32 < 8) throw new Error(`invalid box size ${size32} at offset ${pos}`);
  return { type, size: size32, headerSize: 8 };
}

/** Find a direct child box of `type` within `[start, end)`. Returns the child's payload range, or `null`. Tolerant of malformed bytes (returns `null` rather than throwing) — nested-box parsing is best-effort: a fragment we can't descend into just yields no timing and the driver falls back to nominal. Top-level walking still validates strictly. */
function findChild(
  buf: Buffer,
  start: number,
  end: number,
  type: string,
): { payloadStart: number; payloadEnd: number } | null {
  let pos = start;
  while (pos + 8 <= end) {
    let h: BoxHeader | null;
    try {
      h = readBoxHeader(buf, pos);
    } catch {
      return null;
    }
    if (!h || pos + h.size > end) break;
    if (h.type === type) {
      return { payloadStart: pos + h.headerSize, payloadEnd: pos + h.size };
    }
    pos += h.size;
  }
  return null;
}

/** Descend a path of nested box types. Returns the deepest box's payload range, or `null` if any level is missing. */
function descend(
  buf: Buffer,
  start: number,
  end: number,
  path: readonly string[],
): { payloadStart: number; payloadEnd: number } | null {
  let s = start;
  let e = end;
  for (const type of path) {
    const child = findChild(buf, s, e, type);
    if (!child) return null;
    s = child.payloadStart;
    e = child.payloadEnd;
  }
  return { payloadStart: s, payloadEnd: e };
}

/** Read the media timescale from a `moov` payload (`trak → mdia → mdhd`). */
function parseTimescale(buf: Buffer, moovStart: number, moovEnd: number): number | null {
  const mdhd = descend(buf, moovStart, moovEnd, ['trak', 'mdia', 'mdhd']);
  if (!mdhd) return null;
  const p = mdhd.payloadStart;
  const version = buf[p];
  // mdhd: version(1) flags(3) then creation/modification (4 or 8 each) then timescale(4).
  const tsOffset = version === 1 ? p + 4 + 8 + 8 : p + 4 + 4 + 4;
  if (tsOffset + 4 > buf.length) return null;
  return buf.readUInt32BE(tsOffset);
}

/** Read a fragment's base-media-decode-time from a `moof` payload (`traf → tfdt`). */
function parseTfdt(buf: Buffer, moofStart: number, moofEnd: number): number | null {
  const tfdt = descend(buf, moofStart, moofEnd, ['traf', 'tfdt']);
  if (!tfdt) return null;
  const p = tfdt.payloadStart;
  const version = buf[p];
  if (version === 1) {
    if (p + 12 > buf.length) return null;
    return Number(buf.readBigUInt64BE(p + 4));
  }
  if (p + 8 > buf.length) return null;
  return buf.readUInt32BE(p + 4);
}

/**
 * Sum a fragment's sample durations from its `traf → trun` (media-timescale units). The trailing fragment has no next `tfdt` to delta against, so this is how its real duration is recovered instead of falling back to the nominal chunk duration (which overshoots — ffmpeg's last fragment is typically a short remainder). Falls back to `tfhd` default_sample_duration × sample_count, then `null` when neither is present.
 */
function parseFragmentRawDuration(buf: Buffer, moofStart: number, moofEnd: number): number | null {
  const traf = findChild(buf, moofStart, moofEnd, 'traf');
  if (!traf) return null;
  const trun = findChild(buf, traf.payloadStart, traf.payloadEnd, 'trun');
  if (trun) {
    const p = trun.payloadStart;
    if (p + 8 <= buf.length) {
      const flags = buf.readUIntBE(p + 1, 3);
      const sampleCount = buf.readUInt32BE(p + 4);
      let q = p + 8;
      if (flags & 0x000001) q += 4; // data-offset
      if (flags & 0x000004) q += 4; // first-sample-flags
      const durationPresent = (flags & 0x000100) !== 0;
      const sizePresent = (flags & 0x000200) !== 0;
      const sampleFlagsPresent = (flags & 0x000400) !== 0;
      const ctoPresent = (flags & 0x000800) !== 0;
      if (durationPresent) {
        let total = 0;
        for (let i = 0; i < sampleCount; i++) {
          if (q + 4 > buf.length) return null;
          total += buf.readUInt32BE(q);
          q += 4;
          if (sizePresent) q += 4;
          if (sampleFlagsPresent) q += 4;
          if (ctoPresent) q += 4;
        }
        return total;
      }
    }
    // trun lacks per-sample durations → fall through to tfhd default below.
    const tfhd = findChild(buf, traf.payloadStart, traf.payloadEnd, 'tfhd');
    if (!tfhd) return null;
    const tp = tfhd.payloadStart;
    if (tp + 8 > buf.length) return null;
    const tflags = buf.readUIntBE(tp + 1, 3);
    const sampleCount = buf.readUInt32BE(trun.payloadStart + 4);
    let r = tp + 4 + 4; // version/flags + track_id
    if (tflags & 0x000001) r += 8; // base-data-offset
    if (tflags & 0x000002) r += 4; // sample-description-index
    if (tflags & 0x000008) {
      if (r + 4 > buf.length) return null;
      return buf.readUInt32BE(r) * sampleCount;
    }
  }
  return null;
}

function scan(buf: Buffer, baseOffset: number, isFinal: boolean): ScanResult {
  const chunks: ScannedChunk[] = [];
  let firstMoofOffset: number | null = null;
  let pendingMoofOffset: number | null = null;
  let pendingMoofTfdt: number | null = null;
  let pendingMoofPayload: { start: number; end: number } | null = null;
  let timescale: number | null = null;
  // End of the most recent `mdat`. The trailing fragment runs to here, not to EOF: ffmpeg writes
  // an `mfra` random-access index (and potentially other boxes) after the last `mdat`, which must
  // not be appended to the SourceBuffer as if it were media.
  let lastMdatEnd = 0;
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const h = readBoxHeader(buf, pos);
    if (!h || pos + h.size > buf.length) break;
    if (h.type === 'moov' && baseOffset === 0) {
      timescale = parseTimescale(buf, pos + h.headerSize, pos + h.size);
    }
    if (h.type === 'moof') {
      const offset = baseOffset + pos;
      const tfdt = parseTfdt(buf, pos + h.headerSize, pos + h.size);
      if (pendingMoofOffset !== null) {
        const rawDuration =
          tfdt !== null && pendingMoofTfdt !== null ? tfdt - pendingMoofTfdt : null;
        chunks.push({ byte: [pendingMoofOffset, offset], rawDuration });
      }
      if (firstMoofOffset === null) firstMoofOffset = offset;
      pendingMoofOffset = offset;
      pendingMoofTfdt = tfdt;
      pendingMoofPayload = { start: pos + h.headerSize, end: pos + h.size };
    }
    if (h.type === 'mdat') lastMdatEnd = baseOffset + pos + h.size;
    pos += h.size;
  }
  const init: ChunkRange | null =
    baseOffset === 0 && firstMoofOffset !== null ? [0, firstMoofOffset] : null;
  let resumeOffset = baseOffset + pos;
  if (pendingMoofOffset !== null) {
    if (isFinal) {
      // Close the trailing fragment at its `mdat` end (excluding any trailing `mfra`/index boxes).
      // It has no next `tfdt` to delta against, so recover its real duration from the fragment's
      // own `trun` sample durations; `null` only if that can't be parsed (driver falls back to nominal).
      const end = lastMdatEnd > pendingMoofOffset ? lastMdatEnd : baseOffset + pos;
      const rawDuration = pendingMoofPayload
        ? parseFragmentRawDuration(buf, pendingMoofPayload.start, pendingMoofPayload.end)
        : null;
      chunks.push({ byte: [pendingMoofOffset, end], rawDuration });
    } else {
      // Park the cursor at the in-progress fragment so the next call re-observes its `moof` (and `tfdt`) and can finalise it when a subsequent `moof` arrives.
      resumeOffset = pendingMoofOffset;
    }
  } else if (baseOffset === 0 && !isFinal) {
    // We've read the init region (`ftyp`/`moov`) but no `moof` has landed yet, so `firstMoofOffset`
    // — and therefore the init byte range — is still unknown. `init` is only ever emitted on a
    // `baseOffset === 0` scan, so advancing the cursor past the `moov` here would lose the init
    // segment permanently (the symptom: opus/flac tracks whose init never gets appended and so
    // never decode). Rewind to 0 to re-scan from the start once the first fragment is written.
    resumeOffset = 0;
  }
  return { init, timescale, chunks, resumeOffset };
}

export const mp4Scanner: Scanner = { scan };
