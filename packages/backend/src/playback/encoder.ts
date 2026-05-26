/**
 * Spawn ffmpeg to produce a single-file encoded `.bin` for one cache entry. Output containers: fragmented mp4 (opus or flac) or raw mp3. The live-tail driver in `live-tail.ts` walks the growing file and emits a `.idx`; this module just shells out and reports completion.
 *
 * Concurrency is bounded by `env.TRANSCODE_MAX_PARALLEL` via a shared semaphore. A `kill()` on the returned handle sends `SIGTERM` to the ffmpeg child and resolves the `done` promise without further waiting (the caller is responsible for cleaning up the partial output file).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { env } from '../env.js';

const tracer = trace.getTracer('lofify.playback.encoder');

type Semaphore = {
  active: number;
  waiters: Array<() => void>;
  getMax: () => number;
};

function makeSemaphore(getMax: () => number): Semaphore {
  return { active: 0, waiters: [], getMax };
}

function acquire(sem: Semaphore): Promise<void> {
  if (sem.active < sem.getMax()) {
    sem.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    sem.waiters.push(() => {
      sem.active += 1;
      resolve();
    });
  });
}

function release(sem: Semaphore): void {
  sem.active -= 1;
  const next = sem.waiters.shift();
  if (next) next();
}

const encoderSem = makeSemaphore(() => env.TRANSCODE_MAX_PARALLEL);

/** Client-facing playback quality preset. `max` is the highest-fidelity lossy preset; for lossless flac targets it's a placeholder (the codec has no quality knob). */
export type EncodeQuality = 'low' | 'medium' | 'high' | 'max';

/** Container + codec pairing the encoder is willing to produce. */
export type EncodeFormat =
  | { container: 'mp4'; codec: 'opus' }
  | { container: 'mp4'; codec: 'flac' }
  | { container: 'mp3'; codec: 'mp3' };

export type EncodeTarget = {
  format: EncodeFormat;
  quality: EncodeQuality;
};

export type EncoderOpts = {
  source: string;
  target: EncodeTarget;
  outPath: string;
  /** Nominal chunk duration. Drives ffmpeg's `-frag_duration` for fmp4 outputs; for mp3 the value isn't passed to ffmpeg (the scanner does the windowing) but is still required so the encoder and scanner agree. */
  chunkDurationSeconds: number;
  /** When `true`, use `-c:a copy` instead of re-encoding. Valid only when the source's on-disk codec matches `target.format.codec` — caller's responsibility to ensure. */
  passthrough?: boolean;
};

export interface FfmpegHandle {
  readonly done: Promise<void>;
  kill(): void;
}

function opusBitrateKbps(q: EncodeQuality): number {
  return { low: 64, medium: 128, high: 192, max: 256 }[q];
}

function mp3BitrateKbps(q: EncodeQuality): number {
  return { low: 128, medium: 192, high: 256, max: 320 }[q];
}

function mp4CodecArgs(
  codec: 'opus' | 'flac',
  quality: EncodeQuality,
  passthrough: boolean,
): string[] {
  switch (codec) {
    case 'opus':
      return [
        '-c:a',
        'libopus',
        '-b:a',
        `${opusBitrateKbps(quality)}k`,
        '-vbr',
        'on',
        '-application',
        'audio',
        // libopus runs at 48 kHz internally — force soxr at max precision so the resample on non-48 sources doesn't introduce ringing artefacts.
        '-af',
        'aresample=resampler=soxr:precision=28:dither_method=triangular_hp',
        '-ar',
        '48000',
      ];
    case 'flac':
      return passthrough
        ? ['-c:a', 'copy']
        : ['-c:a', 'flac', '-compression_level', '5'];
  }
}

function mp3CodecArgs(quality: EncodeQuality, passthrough: boolean): string[] {
  return passthrough
    ? ['-c:a', 'copy']
    : ['-c:a', 'libmp3lame', '-b:a', `${mp3BitrateKbps(quality)}k`];
}

function buildArgs(opts: EncoderOpts): string[] {
  const { source, target, outPath, chunkDurationSeconds, passthrough = false } = opts;
  const base = ['-hide_banner', '-loglevel', 'error', '-i', source, '-vn'];
  const fragDurationMicros = String(Math.round(chunkDurationSeconds * 1_000_000));

  switch (target.format.container) {
    case 'mp4':
      return [
        ...base,
        ...mp4CodecArgs(target.format.codec, target.quality, passthrough),
        '-f',
        'mp4',
        // empty_moov keeps the init region small; default_base_moof keeps each moof self-contained so the live-tail scanner can walk fragments without parsing the initial moov; frag_keyframe aligns fragments to audio frame boundaries.
        '-movflags',
        '+frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration',
        fragDurationMicros,
        '-y',
        outPath,
      ];
    case 'mp3':
      return [
        ...base,
        ...mp3CodecArgs(target.quality, passthrough),
        '-f',
        'mp3',
        // Strip any tags from the source so the scanner sees only frames.
        '-write_id3v1',
        '0',
        '-id3v2_version',
        '0',
        '-y',
        outPath,
      ];
  }
}

export function spawnEncoder(opts: EncoderOpts): FfmpegHandle {
  let killed = false;
  let proc: ChildProcessWithoutNullStreams | null = null;
  const done = tracer.startActiveSpan(
    'playback.encode',
    {
      attributes: {
        'playback.source': opts.source,
        'playback.target.container': opts.target.format.container,
        'playback.target.codec': opts.target.format.codec,
        'playback.target.quality': opts.target.quality,
        'playback.passthrough': opts.passthrough ?? false,
      },
    },
    async (span) => {
      const semStart = Date.now();
      await acquire(encoderSem);
      span.setAttribute('playback.semaphore.waitMs', Date.now() - semStart);
      if (killed) {
        release(encoderSem);
        span.end();
        return;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          proc = spawn('ffmpeg', buildArgs(opts));
          let stderr = '';
          proc.stderr.on('data', (c: Buffer) => {
            stderr += c.toString();
          });
          proc.stdout.on('data', () => undefined);
          proc.on('error', reject);
          proc.on('close', (code, signal) => {
            if (killed) {
              resolve();
              return;
            }
            if (code !== 0) {
              reject(
                new Error(
                  `ffmpeg exited with code ${code} signal ${signal ?? '-'}: ${stderr.trim()}`,
                ),
              );
              return;
            }
            resolve();
          });
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally {
        release(encoderSem);
        span.end();
      }
    },
  );
  return {
    done,
    kill: (): void => {
      killed = true;
      proc?.kill('SIGTERM');
    },
  };
}

/** Cache key fragment derived from a target. Used by the cache module to build per-entry filenames. */
export function targetKey(target: EncodeTarget): string {
  return `f-${target.format.codec}_q-${target.quality}`;
}
