import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { env } from '../env.js';
import { logger } from '../logger.js';

const tracer = trace.getTracer('lofify.playback');

export type TranscodeTarget = {
  format: 'flac' | 'ogg' | 'webm' | 'aac';
  codec: string;
  quality: number | null;
};

type Entry = {
  key: string;
  chunks: Buffer[];
  bytes: number;
  done: boolean;
  error: Error | null;
  lastAccess: number;
  emitter: EventEmitter;
};

const cache = new Map<string, Entry>();
let activeProcesses = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeProcesses < env.TRANSCODE_MAX_PARALLEL) {
    activeProcesses += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(() => {
      activeProcesses += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeProcesses -= 1;
  const next = waitQueue.shift();
  if (next) next();
}

function evict(): void {
  const now = Date.now();
  const ttlMs = env.TRANSCODE_CACHE_TTL_SECONDS * 1000;
  let total = 0;
  const entries = [...cache.values()].filter((e) => e.done);
  for (const e of entries) {
    if (now - e.lastAccess > ttlMs) {
      cache.delete(e.key);
    } else {
      total += e.bytes;
    }
  }
  if (total <= env.TRANSCODE_CACHE_MAX_BYTES) return;
  const sorted = [...cache.values()]
    .filter((e) => e.done)
    .sort((a, b) => a.lastAccess - b.lastAccess);
  for (const e of sorted) {
    if (total <= env.TRANSCODE_CACHE_MAX_BYTES) break;
    cache.delete(e.key);
    total -= e.bytes;
  }
}

function ffmpegArgs(source: string, target: TranscodeTarget): string[] {
  const q = target.quality ?? 5;
  switch (target.format) {
    case 'flac':
      return ['-i', source, '-vn', '-c:a', 'flac', '-f', 'flac', 'pipe:1'];
    case 'ogg': {
      const qa = Math.max(-1, Math.min(10, q));
      return ['-i', source, '-vn', '-c:a', 'libvorbis', '-q:a', String(qa), '-f', 'ogg', 'pipe:1'];
    }
    case 'webm': {
      const bitrate = Math.round(32 + (q / 10) * (256 - 32));
      return [
        '-i',
        source,
        '-vn',
        '-c:a',
        'libopus',
        '-b:a',
        `${bitrate}k`,
        '-vbr',
        'on',
        '-f',
        'webm',
        'pipe:1',
      ];
    }
    case 'aac': {
      const bitrate = Math.round(64 + (q / 10) * (256 - 64));
      return ['-i', source, '-vn', '-c:a', 'aac', '-b:a', `${bitrate}k`, '-f', 'adts', 'pipe:1'];
    }
  }
}

async function runFfmpeg(entry: Entry, source: string, target: TranscodeTarget): Promise<void> {
  return tracer.startActiveSpan(
    'playback.transcode',
    {
      attributes: {
        'playback.source': source,
        'playback.target.format': target.format,
        'playback.target.codec': target.codec,
        'playback.target.quality': target.quality ?? -1,
      },
    },
    async (span) => {
      const semaphoreStart = Date.now();
      await acquireSlot();
      span.setAttribute('playback.semaphore.waitMs', Date.now() - semaphoreStart);
      try {
        await new Promise<void>((resolve, reject) => {
          const args = ffmpegArgs(source, target);
          const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
          let stderr = '';
          proc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          proc.stdout.on('data', (chunk: Buffer) => {
            entry.chunks.push(chunk);
            entry.bytes += chunk.length;
            entry.lastAccess = Date.now();
            entry.emitter.emit('chunk', chunk);
          });
          proc.on('error', reject);
          proc.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
            }
          });
        });
        span.setAttribute('playback.bytes', entry.bytes);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally {
        releaseSlot();
        span.end();
      }
    },
  );
}

/** Return the cache entry for `key`, starting ffmpeg if no in-flight or completed transcode exists yet. */
export function getOrStartTranscode(
  key: string,
  source: string,
  target: TranscodeTarget,
): Entry {
  const existing = cache.get(key);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }
  const entry: Entry = {
    key,
    chunks: [],
    bytes: 0,
    done: false,
    error: null,
    lastAccess: Date.now(),
    emitter: new EventEmitter(),
  };
  entry.emitter.setMaxListeners(0);
  cache.set(key, entry);
  runFfmpeg(entry, source, target).then(
    () => {
      entry.done = true;
      entry.lastAccess = Date.now();
      entry.emitter.emit('done');
      evict();
    },
    (err: Error) => {
      entry.done = true;
      entry.error = err;
      entry.emitter.emit('done');
      logger.error('transcode failed', { key, err: err.message });
    },
  );
  return entry;
}

/** Wait for an in-progress transcode to finish, then return the full buffer. */
export function waitForCompletion(entry: Entry): Promise<Buffer> {
  if (entry.done) {
    if (entry.error) return Promise.reject(entry.error);
    return Promise.resolve(Buffer.concat(entry.chunks));
  }
  return new Promise((resolve, reject) => {
    entry.emitter.once('done', () => {
      if (entry.error) reject(entry.error);
      else resolve(Buffer.concat(entry.chunks));
    });
  });
}

type ChunkSubscription = {
  /** Buffers already produced before this subscriber attached. */
  initial: Buffer[];
  /** Resolves with each new chunk; resolves with null when the stream ends. */
  next: () => Promise<Buffer | null>;
  /** Final error, if ffmpeg failed (only valid after `next` returned null). */
  error: () => Error | null;
};

export function subscribe(entry: Entry): ChunkSubscription {
  const initial = entry.chunks.slice();
  let cursor = entry.chunks.length;
  return {
    initial,
    error: () => entry.error,
    next: () => {
      if (cursor < entry.chunks.length) {
        const chunk = entry.chunks[cursor]!;
        cursor += 1;
        return Promise.resolve(chunk);
      }
      if (entry.done) return Promise.resolve(null);
      return new Promise((resolve) => {
        const onChunk = (chunk: Buffer): void => {
          entry.emitter.off('done', onDone);
          cursor += 1;
          resolve(chunk);
        };
        const onDone = (): void => {
          entry.emitter.off('chunk', onChunk);
          resolve(null);
        };
        entry.emitter.once('chunk', onChunk);
        entry.emitter.once('done', onDone);
      });
    },
  };
}

/** Test-only — drop all cached entries. */
export function _resetTranscodeCache(): void {
  cache.clear();
}
