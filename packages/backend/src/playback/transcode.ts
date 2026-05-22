import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { LRUCache } from 'lru-cache';

import { env } from '../env.js';
import { logger } from '../logger.js';
import { type FfmpegHandle, spawnDashEncoder } from './ffmpeg.js';

export type TranscodeTarget = {
  format: 'flac' | 'ogg' | 'webm' | 'aac';
  codec: string;
  quality: number | null;
};

/** Duration of one playback chunk, in seconds. Matches `-seg_duration` passed to ffmpeg's DASH muxer. */
export const SEGMENT_DURATION_SECONDS = 6;

/** A single track's in-progress / completed DASH transcode. Owns the tmpdir, the ffmpeg process, and a `'progress'` event stream the GraphQL subscription drives off. */
export type TranscodeJob = {
  key: string;
  dir: string;
  /** Number of `chunk-NNNNN.webm` files currently on disk. Initialised at 0; bumped by the dir watcher. */
  readyChunks: number;
  /** Set after ffmpeg exits successfully and the final chunk count has been recorded. */
  done: boolean;
  /** Final error from ffmpeg, if any. */
  error: Error | null;
  /** Events: `progress` (after `readyChunks` increases), `done` (on completion or failure). */
  emitter: EventEmitter;
  /** Internal — handle on the ffmpeg process so we can kill it when the entry is evicted mid-encode. */
  ffmpeg: FfmpegHandle;
  /** Internal — async-iterator abort flag used by the polling readyChunks watcher. */
  stop: { aborted: boolean };
};

function transcodeRoot(): string {
  return env.TRANSCODE_TMPDIR ?? path.join(tmpdir(), 'lofify-transcode');
}

export function jobCacheKey(trackId: string, target: TranscodeTarget): string {
  return `${trackId}:${target.format}:${target.codec}:${target.quality ?? 'auto'}`;
}

const cache = new LRUCache<string, TranscodeJob>({
  // Use a count cap as a coarse guard; per-job disk usage varies, so the disk-quota story is driven by the tmpfs mount in containers and by TTL eviction here.
  max: 64,
  ttl: env.TRANSCODE_CACHE_TTL_SECONDS * 1000,
  updateAgeOnGet: true,
  dispose: (job) => {
    job.ffmpeg.kill();
    job.stop.aborted = true;
    rm(job.dir, { recursive: true, force: true }).catch((err: unknown) => {
      logger.warn('transcode tmpdir cleanup failed', {
        dir: job.dir,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  },
});

const inFlightStart = new Map<string, Promise<TranscodeJob>>();

async function countChunks(dir: string): Promise<number> {
  try {
    const names = await readdir(dir);
    let n = 0;
    for (const name of names) if (name.startsWith('chunk-') && name.endsWith('.webm')) n += 1;
    return n;
  } catch {
    return 0;
  }
}

/** Poll the tmpdir at a fixed cadence and bump `job.readyChunks` whenever new files appear. `fs.watch` would be lower-latency but its semantics differ across platforms (especially in containers) — a 250ms poll is plenty since ffmpeg writes a chunk every ~6/realtime seconds anyway. */
async function watchChunks(job: TranscodeJob): Promise<void> {
  while (!job.stop.aborted && !job.done) {
    const n = await countChunks(job.dir);
    if (n > job.readyChunks) {
      job.readyChunks = n;
      job.emitter.emit('progress');
    }
    await delay(250);
  }
  // Final reconciliation after ffmpeg exits — pick up any chunk(s) written between the last poll and exit.
  if (!job.stop.aborted) {
    const n = await countChunks(job.dir);
    if (n > job.readyChunks) {
      job.readyChunks = n;
      job.emitter.emit('progress');
    }
  }
}

async function startJob(
  key: string,
  source: string,
  target: TranscodeTarget,
): Promise<TranscodeJob> {
  const root = transcodeRoot();
  await mkdir(root, { recursive: true });
  const safeKey = key.replace(/[^A-Za-z0-9_.-]+/g, '_');
  // `mkdtemp` gives each ffmpeg invocation its own directory, so an LRU eviction's `rm` (which is fire-and-forget) can't race with a subsequent re-start for the same key and pull the new job's output out from under it. The `${safeKey}-` prefix is debug-friendly when inspecting the tmpfs by hand.
  const dir = await mkdtemp(path.join(root, `${safeKey}-`));
  const ffmpeg = spawnDashEncoder(source, target, dir, SEGMENT_DURATION_SECONDS);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const job: TranscodeJob = {
    key,
    dir,
    readyChunks: 0,
    done: false,
    error: null,
    emitter,
    ffmpeg,
    stop: { aborted: false },
  };
  cache.set(key, job);

  ffmpeg.done.then(
    () => {
      job.done = true;
      job.emitter.emit('done');
    },
    (err: Error) => {
      job.done = true;
      job.error = err;
      job.emitter.emit('done');
      logger.error('transcode failed', { key, err: err.message });
    },
  );

  void watchChunks(job);
  return job;
}

/** Get or start a transcode job for `(track, target)`. Concurrent callers for the same key share the same job. */
export async function getOrStartTranscodeJob(
  key: string,
  source: string,
  target: TranscodeTarget,
): Promise<TranscodeJob> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = inFlightStart.get(key);
  if (pending) return pending;
  const promise = startJob(key, source, target).finally(() => inFlightStart.delete(key));
  inFlightStart.set(key, promise);
  return promise;
}

/** Resolve once `job.readyChunks >= n` or ffmpeg finishes (whichever happens first). */
export function waitForChunks(job: TranscodeJob, n: number): Promise<void> {
  if (job.readyChunks >= n || job.done) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = (): void => {
      job.emitter.off('progress', onProgress);
      job.emitter.off('done', onDone);
    };
    const onProgress = (): void => {
      if (job.readyChunks >= n) {
        cleanup();
        resolve();
      }
    };
    const onDone = (): void => {
      cleanup();
      resolve();
    };
    job.emitter.on('progress', onProgress);
    job.emitter.once('done', onDone);
  });
}

/** Read a chunk file from the job's tmpdir. */
export async function readChunkFile(job: TranscodeJob, name: string): Promise<Buffer> {
  return readFile(path.join(job.dir, name));
}

/** Test-only — drop all cached jobs (and their tmpdirs) and the in-flight start map. */
export function _resetTranscodeCache(): void {
  cache.clear();
  inFlightStart.clear();
}
