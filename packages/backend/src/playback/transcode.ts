import { EventEmitter } from 'node:events';

import { env } from '../env.js';
import { logger } from '../logger.js';
import { runFfmpeg } from './ffmpeg.js';

export type TranscodeTarget = {
  format: 'flac' | 'ogg' | 'webm' | 'aac';
  codec: string;
  quality: number | null;
};

export type Entry = {
  key: string;
  chunks: Buffer[];
  bytes: number;
  done: boolean;
  error: Error | null;
  lastAccess: number;
  emitter: EventEmitter;
};

const cache = new Map<string, Entry>();

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

/** Resolve once `entry.bytes >= target` or ffmpeg finishes (whichever happens first). */
export function waitForBytes(entry: Entry, target: number): Promise<void> {
  if (entry.bytes >= target || entry.done) return Promise.resolve();
  return new Promise((resolve) => {
    const check = (): void => {
      if (entry.bytes >= target || entry.done) {
        entry.emitter.off('chunk', check);
        entry.emitter.off('done', check);
        resolve();
      }
    };
    entry.emitter.on('chunk', check);
    entry.emitter.once('done', check);
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

/**
 * Subscribe to the entry's byte stream from a given offset.
 *
 * `initial` contains the slice of already-produced bytes starting at `startByte` (possibly empty if ffmpeg hasn't reached that offset yet). `next()` then yields each subsequent ffmpeg chunk verbatim, resolving with `null` once ffmpeg has finished. Multiple subscribers can attach to the same entry — each gets its own cursor and `initial` snapshot, so attaching late is fine.
 *
 * @param entry - the cached transcode entry to read from
 * @param startByte - first byte the caller wants; chunks before this offset are skipped, the chunk that straddles it is sliced
 */
export function subscribe(entry: Entry, startByte = 0): ChunkSubscription {
  const initial: Buffer[] = [];
  let consumed = 0;
  let chunkIdx = 0;
  while (chunkIdx < entry.chunks.length) {
    const len = entry.chunks[chunkIdx]!.length;
    if (consumed + len > startByte) break;
    consumed += len;
    chunkIdx += 1;
  }
  if (chunkIdx < entry.chunks.length && consumed < startByte) {
    initial.push(entry.chunks[chunkIdx]!.subarray(startByte - consumed));
    chunkIdx += 1;
  }
  while (chunkIdx < entry.chunks.length) {
    initial.push(entry.chunks[chunkIdx]!);
    chunkIdx += 1;
  }
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
