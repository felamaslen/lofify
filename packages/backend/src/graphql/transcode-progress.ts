import { eq } from 'drizzle-orm';
import type { ID, Int } from 'grats';

import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { parseOptionSegments } from '../playback/options.js';
import { parseAcceptHeader, resolveTarget } from '../playback/route.js';
import type { TranscodeJob } from '../playback/transcode.js';
import {
  getOrStartTranscodeJob,
  jobCacheKey,
  SEGMENT_DURATION_SECONDS,
} from '../playback/transcode.js';

/**
 * Snapshot of how far the server has progressed transcoding a track's playback stream. Drives the "still encoding" overlay in the playback bar so the client knows which seek targets are reachable.
 *
 * @gqlType
 */
export class TranscodeProgress {
  constructor(private snapshot: { readyChunks: number; isDone: boolean }) {}

  /** Number of equal-duration chunks that have been written to the transcode cache so far. Multiply by `chunkDurationSeconds` to get the seconds-ready cursor. @gqlField */
  readyChunks(): Int {
    return this.snapshot.readyChunks;
  }

  /** Duration of a single transcode chunk, in seconds. Constant for the lifetime of the subscription. @gqlField */
  chunkDurationSeconds(): Int {
    return SEGMENT_DURATION_SECONDS;
  }

  /** True once ffmpeg has finished (successfully or not). After this the snapshot is final. @gqlField */
  isDone(): boolean {
    return this.snapshot.isDone;
  }
}

function snapshot(job: TranscodeJob | null): TranscodeProgress {
  if (!job) return new TranscodeProgress({ readyChunks: 0, isDone: true });
  return new TranscodeProgress({ readyChunks: job.readyChunks, isDone: job.done });
}

const THROTTLE_MS = 1000;

/**
 * Stream progress snapshots of the transcode that backs a given `(trackId, quality, Accept)` playback stream. Pass the same `Accept` header value the client will send to `/play/...` — the server resolves it to the same transcode job key, so the subscription observes the actual encoder the player is consuming.
 *
 * Emits at most once per second while the transcode is running, then yields a final snapshot when it finishes. Passthrough streams (`audio/flac` accepted on a flac source) yield a single `isDone: true` snapshot.
 *
 * @gqlSubscriptionField transcodeProgress
 */
export async function* transcodeProgressSubscription(args: {
  trackId: ID;
  /** The exact value the client will send in the `Accept` header on `/play/...` — may be a comma-separated list. Defaults to `audio/webm` if omitted. */
  acceptHeaderValue?: string | null;
  /** One of `low`, `medium`, `high`. */
  quality?: string | null;
}): AsyncIterable<TranscodeProgress> {
  const rows = await db
    .select()
    .from(tracksTable)
    .where(eq(tracksTable.id, args.trackId))
    .limit(1);
  const track = rows[0];
  if (!track) return;

  const accepts = parseAcceptHeader(args.acceptHeaderValue ?? 'audio/webm');
  if (!accepts) return;
  // Same edge-case the route enforces — flac-only Accept is invalid because flac is never encoded.
  if (accepts.includes('flac') && accepts.length === 1) return;

  const optionSegments: string[] = [];
  if (args.quality != null) {
    const q = args.quality.toLowerCase();
    const code = q === 'low' ? 'l' : q === 'medium' ? 'm' : q === 'high' ? 'h' : null;
    if (code) optionSegments.push(`q:${code}`);
  }
  const opts = parseOptionSegments(optionSegments);
  if (opts == null) return;

  const resolved = resolveTarget(track, opts, accepts);
  if (resolved.kind === 'passthrough') {
    // Flac passthrough — no encoder job to watch.
    yield snapshot(null);
    return;
  }

  const job = await getOrStartTranscodeJob(
    jobCacheKey(track.id, resolved.target),
    track.file,
    resolved.target,
  );

  let lastEmittedAt = 0;
  for (;;) {
    const now = Date.now();
    const wait = Math.max(0, lastEmittedAt + THROTTLE_MS - now);
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    yield snapshot(job);
    lastEmittedAt = Date.now();
    if (job.done) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        job.emitter.off('progress', finish);
        job.emitter.off('done', finish);
        resolve();
      };
      job.emitter.once('progress', finish);
      job.emitter.once('done', finish);
    });
  }
}
