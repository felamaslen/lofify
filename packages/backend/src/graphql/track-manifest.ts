import { eq } from 'drizzle-orm';
import type { Float, ID } from 'grats';

import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { defaultCache } from '../playback/cache.js';
import type { IndexChunk } from '../playback/live-tail.js';
import { resolveTarget } from '../playback/resolve.js';
import { abbreviateCodec } from './codec.js';
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
 * One emission in the live manifest stream for a `(track, quality, format)` cache entry. `chunks` is a *delta* — only the chunks finalised since the previous emission — because the encoded stream grows append-only and re-sending the whole list every tick is O(events × chunks). The client appends each delta to its running list in arrival order. The scalar fields (`durationSeconds`, `done`, `init`) carry the current absolute state on every emission, so a client that joined mid-stream is told where it stands without needing the full history.
 *
 * @gqlType
 */
export class TrackManifest {
  constructor(private emit: ManifestEmission) {}
  /** Cumulative encoded duration so far, equal to the last chunk's `endSeconds` or `0` when no chunks have landed yet. @gqlField */
  durationSeconds(): Float {
    return this.emit.durationSeconds;
  }
  /** True once the encoder has finished and the trailing chunk has been emitted. After this, no more emissions will arrive. @gqlField */
  done(): boolean {
    return this.emit.done;
  }
  /** Init-segment byte range. `null` for mp3, and `null` for fmp4 until the first fragment boundary has been observed. Repeated on every emission until non-null, so it's never missed. @gqlField */
  init(): TrackManifestInit | null {
    return this.emit.init ? new TrackManifestInit(this.emit.init) : null;
  }
  /** Chunks finalised since the previous emission, in order. A delta, not the full list — the client appends them to its accumulated manifest. @gqlField */
  chunks(): TrackManifestChunk[] {
    return this.emit.chunks.map((c) => new TrackManifestChunk(c));
  }
}

/** Snapshot captured at emission time: the chunk delta plus the current absolute scalar state. Captured eagerly (rather than reading the live `IndexFile`) so concurrent encoder appends can't race the GraphQL field resolution. */
type ManifestEmission = {
  chunks: readonly IndexChunk[];
  durationSeconds: number;
  done: boolean;
  init: readonly [number, number] | null;
};

const THROTTLE_MS = 1000;

/**
 * Stream manifest snapshots for `(trackId, quality, format)`. The same `(quality, format)` values the client baked into its signed playback URL drive cache-entry selection on the server, so the manifest describes exactly the bytes the playback route will serve.
 *
 * Emits at most once per second while the encoder runs, then a final emission when it finishes. For already-warm cache entries (or for tracks served by passthrough) the subscription emits a single `done: true` emission and completes.
 *
 * `chunks` is a per-emission delta (see `TrackManifest`). Each subscription tracks its own sent-count starting at zero, so the first emission replays every chunk finalised so far and later emissions carry only new ones — restarting (or reconnecting) the subscription always yields the full list up front, then deltas.
 *
 * @gqlSubscriptionField trackManifest
 */
export async function* trackManifestSubscription(args: {
  /** Track id. */
  trackId: ID;
  /** The same `TrackFormat` passed to `Track.url`; resolved identically so the manifest describes exactly the bytes the playback route will serve. */
  format: TrackFormat;
}): AsyncIterable<TrackManifest> {
  const rows = await db.select().from(tracksTable).where(eq(tracksTable.id, args.trackId)).limit(1);
  const track = rows[0];
  if (!track) return;

  const sourceCodec = abbreviateCodec(track.codec);
  const target = resolveTarget({ isLossless: track.isLossless, sourceCodec }, args.format);
  const entry = await defaultCache.getOrStart({
    trackId: track.id,
    sourceMtime: track.sourceMtime,
    sourcePath: track.file,
    sourceCodec,
    target,
  });

  let lastEmittedAt = 0;
  let sentChunks = 0;
  for (;;) {
    const wait = Math.max(0, lastEmittedAt + THROTTLE_MS - Date.now());
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    // Snapshot eagerly: capture the delta and scalars in one synchronous read so a concurrent
    // encoder append can't grow the list between computing the slice and resolving the fields.
    const index = entry.index;
    const chunks = index.chunks.slice(sentChunks);
    sentChunks = index.chunks.length;
    yield new TrackManifest({
      chunks,
      durationSeconds: index.durationSeconds,
      done: index.done,
      init: index.init,
    });
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
