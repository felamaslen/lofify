import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { LRUCache } from 'lru-cache';

import { env } from '../env.js';
import { logger } from '../logger.js';
import { type FfmpegHandle, spawnChunkedEncoder } from './ffmpeg.js';

/** Target encoded delivery format. `flac` is never encoded — it's passthrough-only — so it does not appear here. The container/codec pairing is fixed (opus only ever ships in webm; mp3 only ever ships raw), so they're modelled as a discriminated union to make impossible states unrepresentable. */
export type TranscodeTarget = {
  format: { container: 'webm'; codec: 'opus' } | { container: 'mp3'; codec: 'mp3' };
  /** Coarse quality preset. `max` is server-chosen only — it kicks in when the client accepted flac but the source is lossy, so we still need to encode (because we can't passthrough non-flac as flac). */
  quality: 'low' | 'medium' | 'high' | 'max';
};

/** Duration of one playback chunk, in seconds. Matches `-seg_duration` passed to ffmpeg. */
export const SEGMENT_DURATION_SECONDS = 6;

/** A single track's in-progress / completed transcode. Owns the tmpdir, the ffmpeg process, and a `'progress'` event stream the GraphQL subscription drives off. */
export type TranscodeJob = {
  key: string;
  dir: string;
  target: TranscodeTarget;
  /** Number of `chunk-NNNNN.{ext}` files currently on disk. Initialised at 0; bumped by the dir watcher. */
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
  return `${trackId}:${target.format.container}:${target.format.codec}:${target.quality}`;
}

/** File extension and (optional) init-segment name for a target's chunked output. */
export function chunkLayout(target: TranscodeTarget): { ext: string; init: string | null } {
  return target.format.container === 'webm'
    ? { ext: 'webm', init: 'init.webm' }
    : { ext: 'mp3', init: null };
}

const cache = new LRUCache<string, TranscodeJob>({
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

async function countChunks(dir: string, ext: string): Promise<number> {
  try {
    const names = await readdir(dir);
    const suffix = `.${ext}`;
    let n = 0;
    for (const name of names) if (name.startsWith('chunk-') && name.endsWith(suffix)) n += 1;
    return n;
  } catch {
    return 0;
  }
}

/** Poll the tmpdir at a fixed cadence and bump `job.readyChunks` whenever new files appear. */
async function watchChunks(job: TranscodeJob): Promise<void> {
  const { ext } = chunkLayout(job.target);
  while (!job.stop.aborted && !job.done) {
    const n = await countChunks(job.dir, ext);
    if (n > job.readyChunks) {
      job.readyChunks = n;
      job.emitter.emit('progress');
    }
    await delay(250);
  }
  if (!job.stop.aborted) {
    const n = await countChunks(job.dir, ext);
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
  const dir = await mkdtemp(path.join(root, `${safeKey}-`));
  const ffmpeg = spawnChunkedEncoder(source, target, dir, SEGMENT_DURATION_SECONDS);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const job: TranscodeJob = {
    key,
    dir,
    target,
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

export async function readChunkFile(job: TranscodeJob, name: string): Promise<Buffer> {
  return readFile(path.join(job.dir, name));
}

export function _resetTranscodeCache(): void {
  cache.clear();
  inFlightStart.clear();
}
