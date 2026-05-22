import { eq } from 'drizzle-orm';
import type { Float, ID, Int } from 'grats';

import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { parseOptionSegments } from '../playback/options.js';
import { resolveTarget, transcodeCacheKey } from '../playback/route.js';
import type { Entry } from '../playback/transcode.js';
import { getOrStartTranscode } from '../playback/transcode.js';
import type { Format } from './track.js';

/**
 * Snapshot of how much of a transcoded playback stream the server has produced so far. Lets the client distinguish "the server has these bytes ready to serve" from "I've downloaded these bytes" — useful for seek-bar indicators and for clamping seeks to the transcoded region.
 *
 * @gqlType
 */
export class TranscodeProgress {
  constructor(
    private snapshot: { secondsTranscoded: number; bytesTranscoded: number; isDone: boolean },
  ) {}

  /** Seconds of audio the server has finished transcoding. Zero when no transcode is running (e.g. passthrough playback). @gqlField */
  secondsTranscoded(): Float {
    return this.snapshot.secondsTranscoded;
  }

  /** Bytes produced by the transcoder so far. Combined with `secondsTranscoded` this gives an average bytes-per-second the client can use to estimate the byte offset for a seek target. @gqlField */
  bytesTranscoded(): Int {
    return this.snapshot.bytesTranscoded;
  }

  /** True once transcoding has finished (successfully or not). After this the snapshot is final. @gqlField */
  isDone(): boolean {
    return this.snapshot.isDone;
  }
}

function snapshot(entry: Entry | null): TranscodeProgress {
  if (!entry) return new TranscodeProgress({ secondsTranscoded: 0, bytesTranscoded: 0, isDone: true });
  return new TranscodeProgress({
    secondsTranscoded: entry.transcodedSeconds,
    bytesTranscoded: entry.bytes,
    isDone: entry.done,
  });
}

const THROTTLE_MS = 1000;

/**
 * Stream progress snapshots of the transcode that backs a given `(trackId, format, quality)` playback URL. Emits at most once per second while the transcode is running, then yields a final snapshot when it finishes. The subscription kicks off the transcode if it isn't already running, so subscribing before fetching the playback URL is fine.
 *
 * @gqlSubscriptionField transcodeProgress
 */
export async function* transcodeProgressSubscription(args: {
  trackId: ID;
  format?: Format | null;
  quality?: Int | null;
}): AsyncIterable<TranscodeProgress> {
  const rows = await db
    .select()
    .from(tracksTable)
    .where(eq(tracksTable.id, args.trackId))
    .limit(1);
  const track = rows[0];
  if (!track) return;

  const optionSegments: string[] = [];
  if (args.format != null) optionSegments.push(`f:${args.format.toLowerCase()}`);
  if (args.quality != null) optionSegments.push(`q:${args.quality}`);
  const opts = parseOptionSegments(optionSegments);
  if (opts == null) return;

  const resolved = resolveTarget(track, opts);
  if (resolved.kind === 'passthrough') {
    // No transcode happens for passthrough; report a single "done at 0" snapshot
    // so subscribers don't hang.
    yield snapshot(null);
    return;
  }

  const cacheKey = transcodeCacheKey(track.id, resolved.target);
  const entry = getOrStartTranscode(cacheKey, track.file, resolved.target);

  let lastEmittedAt = 0;
  for (;;) {
    const now = Date.now();
    const wait = Math.max(0, lastEmittedAt + THROTTLE_MS - now);
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    yield snapshot(entry);
    lastEmittedAt = Date.now();
    if (entry.done) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        entry.emitter.off('progress', finish);
        entry.emitter.off('done', finish);
        resolve();
      };
      entry.emitter.once('progress', finish);
      entry.emitter.once('done', finish);
    });
  }
}
