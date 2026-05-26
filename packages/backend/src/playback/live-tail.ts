/**
 * Drives a `Scanner` against a growing `.bin` file. Polls file size, reads the new tail, asks the scanner for finalised chunks, accumulates them into an in-memory `IndexFile`, and atomically persists that to a `.idx` sidecar after every change. Subscribers receive a fresh snapshot via the `'update'` event — the manifest GraphQL subscription rides on top of this.
 *
 * The in-memory `index` is the source of truth during the encode; `.idx` exists so the cache survives process restarts (cache module can read it back on warm start) and so an out-of-band tool can inspect the cache without spawning the runtime.
 */

import { EventEmitter } from 'node:events';
import { open, rename, stat, writeFile } from 'node:fs/promises';

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { logger } from '../logger.js';
import type { ChunkRange, Scanner } from './scan-types.js';

const tracer = trace.getTracer('lofify.playback.liveTail');

export type IndexChunk = {
  /** Byte range in the `.bin`. */
  byte: ChunkRange;
  /** Cumulative encoded duration up to and including this chunk, in seconds. */
  endSeconds: number;
};

export type IndexFile = {
  /** Nominal target chunk duration the encoder is configured for. Same value the scanner factory was built with. Stored so a future change can detect stale `.idx` files. */
  chunkDurationSeconds: number;
  /** Cumulative encoded duration so far — equal to `chunks[last]?.endSeconds ?? 0`. */
  durationSeconds: number;
  /** Set to `true` after `finalise()` runs and the trailing chunk has been emitted. */
  done: boolean;
  /** Init byte range. Set the first time the scanner observes a chunk boundary while reading from offset 0. Always `null` for mp3 (no init). */
  init: ChunkRange | null;
  chunks: IndexChunk[];
};

export type LiveTailEvents = {
  update: (snapshot: IndexFile) => void;
  error: (err: unknown) => void;
};

export type LiveTailHandle = {
  /** Live in-memory snapshot. Consumers should treat it as read-only; the driver mutates it in place between updates. */
  readonly index: Readonly<IndexFile>;
  readonly emitter: EventEmitter;
  /** Stops polling and lets the in-flight tick (if any) settle. Does not call `finalise()`. */
  stop(): Promise<void>;
  /** Stops polling, runs one final scan with `isFinal=true` to flush the trailing chunk, sets `done=true`, and persists. */
  finalise(): Promise<void>;
};

export type LiveTailOptions = {
  scanner: Scanner;
  binPath: string;
  idxPath: string;
  /** Nominal chunk duration written to the `.idx`. Pass the same value used to configure the scanner factory. */
  chunkDurationSeconds: number;
  /** Polling interval. Tests can lower this to drive the loop quickly. */
  pollIntervalMs?: number;
};

export function startLiveTail(opts: LiveTailOptions): LiveTailHandle {
  const { scanner, binPath, idxPath, chunkDurationSeconds, pollIntervalMs = 250 } = opts;
  const index: IndexFile = {
    chunkDurationSeconds,
    durationSeconds: 0,
    done: false,
    init: null,
    chunks: [],
  };
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  let resumeOffset = 0;
  let stopped = false;

  async function readTail(): Promise<{ buf: Buffer; size: number } | null> {
    let size: number;
    try {
      const st = await stat(binPath);
      size = st.size;
    } catch {
      // .bin may not exist yet — encoder still spinning up.
      return null;
    }
    if (size < resumeOffset) {
      // The file shrunk — should never happen mid-encode. Treat as fatal so the cache entry is invalidated by the supervisor.
      throw new Error(`bin file shrank: size=${size} < resumeOffset=${resumeOffset}`);
    }
    const toRead = size - resumeOffset;
    const buf = Buffer.alloc(toRead);
    if (toRead > 0) {
      const handle = await open(binPath, 'r');
      try {
        await handle.read(buf, 0, toRead, resumeOffset);
      } finally {
        await handle.close();
      }
    }
    return { buf, size };
  }

  async function tick(isFinal: boolean): Promise<boolean> {
    const tail = await readTail();
    if (!tail && !isFinal) return false;
    const buf = tail?.buf ?? Buffer.alloc(0);
    // Skip spanning no-op polls (no new bytes, not a final flush) — keeps trace cardinality bounded under the 250 ms polling cadence.
    if (buf.length === 0 && !isFinal) return false;

    return tracer.startActiveSpan(
      'playback.liveTail.tick',
      {
        attributes: {
          'playback.liveTail.binPath': binPath,
          'playback.liveTail.isFinal': isFinal,
          'playback.liveTail.bytesRead': buf.length,
          'playback.liveTail.resumeOffset': resumeOffset,
        },
      },
      async (span): Promise<boolean> => {
        try {
          const result = scanner.scan(buf, resumeOffset, isFinal);
          let changed = false;
          if (result.init && !index.init) {
            index.init = result.init;
            changed = true;
          }
          for (const c of result.chunks) {
            const endSeconds = index.durationSeconds + c.durationSeconds;
            index.chunks.push({ byte: c.byte, endSeconds });
            index.durationSeconds = endSeconds;
            changed = true;
          }
          resumeOffset = result.resumeOffset;
          if (isFinal && !index.done) {
            index.done = true;
            changed = true;
          }
          span.setAttribute('playback.liveTail.chunksEmitted', result.chunks.length);
          span.setAttribute('playback.liveTail.totalChunks', index.chunks.length);
          if (changed) {
            await persist();
            emitter.emit('update', snapshot());
          }
          return changed;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async function persist(): Promise<void> {
    const tmp = `${idxPath}.tmp`;
    await writeFile(tmp, JSON.stringify(index));
    await rename(tmp, idxPath);
  }

  function snapshot(): IndexFile {
    return {
      chunkDurationSeconds: index.chunkDurationSeconds,
      durationSeconds: index.durationSeconds,
      done: index.done,
      init: index.init ? [index.init[0], index.init[1]] : null,
      chunks: index.chunks.map((c) => ({
        byte: [c.byte[0], c.byte[1]],
        endSeconds: c.endSeconds,
      })),
    };
  }

  const pollLoop = (async () => {
    while (!stopped) {
      try {
        await tick(false);
      } catch (err) {
        logger.error('live-tail tick failed', {
          binPath,
          err: err instanceof Error ? err.message : String(err),
        });
        emitter.emit('error', err);
      }
      if (stopped) break;
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    }
  })();

  return {
    get index() {
      return index;
    },
    emitter,
    async stop(): Promise<void> {
      stopped = true;
      await pollLoop;
    },
    async finalise(): Promise<void> {
      stopped = true;
      await pollLoop;
      await tick(true);
    },
  };
}
