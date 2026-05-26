/** Half-open file byte range, `[start, end)`, in the underlying `.bin`. */
export type ChunkRange = readonly [start: number, end: number];

/** A finalised playback chunk: byte range in the `.bin` plus the chunk's duration in raw timebase units (fmp4: `tfdt` delta in media-timescale units; mp3: sample count). The live-tail driver divides by the `ScanResult.timescale` to get seconds. `rawDuration` is `null` when the scanner can't determine it — the trailing fmp4 fragment, whose duration would need the next `tfdt` that never arrives — and the driver substitutes the nominal chunk duration. */
export type ScannedChunk = {
  byte: ChunkRange;
  rawDuration: number | null;
};

/**
 * Shared interface for the live-tail scanners that turn a growing encoder-output file into a `.idx` of chunk byte ranges + cumulative timings. One implementation per container format (fmp4, mp3). The scanners are pure functions: there is no carry-forward state; re-walking the tail from `resumeOffset` reconstructs everything the next call needs.
 *
 * Timing is reported in raw timebase units (`ScannedChunk.rawDuration`) plus a `timescale`, rather than seconds, so the scanner never has to do floating-point division and the driver can normalise uniformly across formats. fmp4 derives both from the file (timescale from `mdhd`, durations from `tfdt` deltas); mp3 reports sample counts against the sample rate.
 */
export type ScanResult = {
  /** Byte range of the init segment, populated only on calls where `baseOffset === 0` and at least one chunk boundary has been observed (so the init's end is known). Caller persists this in the `.idx` on the first non-null value and ignores it thereafter. mp3 always returns `null` — it has no init. */
  init: ChunkRange | null;
  /** Timebase that `rawDuration` is measured in: media-timescale ticks per second for fmp4 (from `mdhd`), or the sample rate for mp3. Reported whenever the scanner can read it from the buffer (every call for mp3; the init-bearing call for fmp4) and `null` otherwise. The driver latches the first non-null value — it's constant for the lifetime of a stream. */
  timescale: number | null;
  /** Complete chunks observed in this call, in order. A chunk is complete once both its start and end are known (either via a subsequent boundary or via `isFinal === true`). */
  chunks: ScannedChunk[];
  /** File offset to resume the next call from. The caller reads `[resumeOffset, currentFileSize)` and passes it back as the next call's `baseOffset`. May equal `baseOffset` if no progress could be made — that just means the caller should wait for more bytes. */
  resumeOffset: number;
};

export interface Scanner {
  /** Walk `buf` end-to-end. `buf[0]` is treated as file offset `baseOffset`. If `isFinal` is true the buffer ends at the file's final byte, so any pending in-progress chunk is finalised using that as its end. */
  scan(buf: Buffer, baseOffset: number, isFinal: boolean): ScanResult;
}
