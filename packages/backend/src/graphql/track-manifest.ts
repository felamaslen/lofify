import { eq } from 'drizzle-orm';
import type { Float, ID } from 'grats';

import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { defaultCache } from '../playback/cache.js';
import type { IndexChunk, IndexFile } from '../playback/live-tail.js';
import { resolveTarget } from '../playback/resolve.js';
import type { TrackFormat } from './track.js';

/**
 * Byte range of the init segment in the encoded `.bin`. Clients fetch this range first and prepend it to the SourceBuffer before appending any chunk. Null on containers that have no init segment (mp3).
 *
 * @gqlType
 */
export class TrackManifestInit {
  constructor(private range: readonly [number, number]) {}
  /** Inclusive start byte offset. @gqlField */
  byteStart(): Float {
    return this.range[0];
  }
  /** Exclusive end byte offset. @gqlField */
  byteEnd(): Float {
    return this.range[1];
  }
}

/**
 * One finalised chunk of the encoded stream. Clients pick the chunk whose byte range covers a target seek time by binary-searching `endSeconds`, then issue a `Range: bytes=byteStart-byteEnd-1` request against the playback URL.
 *
 * @gqlType
 */
export class TrackManifestChunk {
  constructor(private c: IndexChunk) {}
  /** Inclusive start byte offset. @gqlField */
  byteStart(): Float {
    return this.c.byte[0];
  }
  /** Exclusive end byte offset. @gqlField */
  byteEnd(): Float {
    return this.c.byte[1];
  }
  /** Cumulative encoded end time of this chunk, in seconds. Strictly increasing across the `chunks` array. @gqlField */
  endSeconds(): Float {
    return this.c.endSeconds;
  }
}

/**
 * Live manifest snapshot for a `(track, quality, format)` cache entry. Grows monotonically as the encoder produces chunks: subscribers receive an initial snapshot of whatever's ready, then a fresh snapshot whenever the index changes, terminating with `done: true`.
 *
 * @gqlType
 */
export class TrackManifest {
  constructor(private snap: IndexFile) {}
  /** Nominal chunk duration the encoder is configured for, in seconds. Actual `endSeconds` deltas may run a few % longer (mp3 windows close on the next frame boundary after crossing the threshold). @gqlField */
  chunkDurationSeconds(): Float {
    return this.snap.chunkDurationSeconds;
  }
  /** Cumulative encoded duration so far, equal to `chunks[last].endSeconds` or `0` when no chunks have landed yet. @gqlField */
  durationSeconds(): Float {
    return this.snap.durationSeconds;
  }
  /** True once the encoder has finished and the trailing chunk has been emitted. After this, no more snapshots will arrive. @gqlField */
  done(): boolean {
    return this.snap.done;
  }
  /** Init-segment byte range. `null` for mp3, and `null` for fmp4 until the first fragment boundary has been observed. @gqlField */
  init(): TrackManifestInit | null {
    return this.snap.init ? new TrackManifestInit(this.snap.init) : null;
  }
  /** Finalised chunks, in order. @gqlField */
  chunks(): TrackManifestChunk[] {
    return this.snap.chunks.map((c) => new TrackManifestChunk(c));
  }
}

const THROTTLE_MS = 1000;

/**
 * Stream manifest snapshots for `(trackId, quality, format)`. The same `(quality, format)` values the client baked into its signed playback URL drive cache-entry selection on the server, so the manifest describes exactly the bytes the playback route will serve.
 *
 * Emits at most once per second while the encoder runs, then a final snapshot when it finishes. For already-warm cache entries (or for tracks served by passthrough) the subscription emits a single `done: true` snapshot and completes.
 *
 * @gqlSubscriptionField trackManifest
 */
export async function* trackManifestSubscription(args: {
  /** Track id. */
  trackId: ID;
  /** Same `(quality, formatLossy)` the client baked into its signed playback URL. */
  format: TrackFormat;
}): AsyncIterable<TrackManifest> {
  const rows = await db
    .select()
    .from(tracksTable)
    .where(eq(tracksTable.id, args.trackId))
    .limit(1);
  const track = rows[0];
  if (!track) return;

  const target = resolveTarget(track, {
    quality: args.format.quality,
    formatLossy: args.format.formatLossy,
  });
  const entry = await defaultCache.getOrStart({
    trackId: track.id,
    sourceMtime: track.sourceMtime,
    sourcePath: track.file,
    sourceCodec: track.codec.toLowerCase(),
    target,
  });

  let lastEmittedAt = 0;
  for (;;) {
    const wait = Math.max(0, lastEmittedAt + THROTTLE_MS - Date.now());
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    yield new TrackManifest(entry.index);
    lastEmittedAt = Date.now();
    if (entry.isDone() || entry.error()) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        entry.emitter.off('update', finish);
        entry.emitter.off('error', finish);
        resolve();
      };
      entry.emitter.once('update', finish);
      entry.emitter.once('error', finish);
    });
  }
}
