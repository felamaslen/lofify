/**
 * Spawn ffmpeg to produce a single-file encoded `.bin` for one cache entry. Output containers: fragmented mp4 (opus or flac), WebM (opus or Vorbis), or raw mp3. The live-tail driver in `live-tail.ts` walks the growing file and emits a `.idx`; this module just shells out and reports completion.
 *
 * Concurrency is bounded by `env.TRANSCODE_MAX_PARALLEL` via a shared semaphore. A `kill()` on the returned handle sends `SIGTERM` to the ffmpeg child and resolves the `done` promise without further waiting (the caller is responsible for cleaning up the partial output file).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { env } from '../env.js';
import type { Quality } from '../graphql/playback-format.js';

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

/** Container + codec pairing the encoder is willing to produce. Internal — `resolve.ts` translates a client's quality + supported-format lists into one of these. `webm/vorbis` is only ever reached as a passthrough copy (we never encode to Vorbis); `webm/opus` and `mp4/opus` may be either copy or transcode. */
export type EncodeFormat =
  | { container: 'mp4'; codec: 'opus' }
  | { container: 'mp4'; codec: 'flac' }
  | { container: 'webm'; codec: 'opus' }
  | { container: 'webm'; codec: 'vorbis' }
  | { container: 'mp3'; codec: 'mp3' };

export type EncodeTarget = {
  format: EncodeFormat;
  quality: Quality;
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
  /** True once `done` settles iff the encode was terminated by `kill()` before finishing (rather than completing or failing on its own). Its output is then truncated and must not be treated as complete. Read after `done` resolves. */
  readonly aborted: boolean;
  kill(): void;
}

function opusBitrateKbps(q: Quality): number {
  return { MIN: 16, LOW: 64, MEDIUM: 128, HIGH: 192, MAX: 256 }[q];
}

function mp3BitrateKbps(q: Quality): number {
  return { MIN: 64, LOW: 128, MEDIUM: 192, HIGH: 256, MAX: 320 }[q];
}

function opusEncodeArgs(quality: Quality): string[] {
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
}

function mp4CodecArgs(codec: 'opus' | 'flac', quality: Quality, passthrough: boolean): string[] {
  switch (codec) {
    case 'opus':
      return passthrough ? ['-c:a', 'copy'] : opusEncodeArgs(quality);
    case 'flac':
      return passthrough ? ['-c:a', 'copy'] : ['-c:a', 'flac', '-compression_level', '5'];
  }
}

function webmCodecArgs(codec: 'opus' | 'vorbis', quality: Quality, passthrough: boolean): string[] {
  // Vorbis is copy-only — `resolve.ts` only ever picks webm/vorbis when the source is already Vorbis.
  if (codec === 'vorbis' || passthrough) return ['-c:a', 'copy'];
  return opusEncodeArgs(quality);
}

function mp3CodecArgs(quality: Quality, passthrough: boolean): string[] {
  // `-reservoir 0` disables LAME's bit reservoir so every frame is self-contained. The player can
  // then splice between bitrates mid-stream (adaptive switching) without the first frames of the new
  // encode referencing reservoir bits from the old one — which otherwise decodes to an audible click.
  return passthrough
    ? ['-c:a', 'copy']
    : ['-c:a', 'libmp3lame', '-b:a', `${mp3BitrateKbps(quality)}k`, '-reservoir', '0'];
}

function buildArgs(opts: EncoderOpts): string[] {
  const { source, target, outPath, chunkDurationSeconds, passthrough = false } = opts;
  const base = ['-hide_banner', '-loglevel', 'error', '-i', source, '-vn'];
  const fragDurationMicros = String(Math.round(chunkDurationSeconds * 1_000_000));
  const clusterMillis = String(Math.round(chunkDurationSeconds * 1000));

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
    case 'webm':
      return [
        ...base,
        ...webmCodecArgs(target.format.codec, target.quality, passthrough),
        '-f',
        'webm',
        // dash mode emits a Cues element and keyframe-aligned, single-track clusters — the layout
        // the WebM MSE byte-stream format expects; cluster_time_limit splits clusters on the nominal
        // chunk boundary so the live-tail scanner's per-cluster byte ranges line up with seek points.
        '-dash',
        '1',
        '-dash_track_number',
        '1',
        '-cluster_time_limit',
        clusterMillis,
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
  let aborted = false;
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
        aborted = true;
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
            // Exit 0 is a clean finish even if a kill() raced in just after the process exited.
            if (code === 0) {
              resolve();
              return;
            }
            // Non-zero because we terminated it mid-encode: aborted, not a failure. Output truncated.
            if (killed) {
              aborted = true;
              resolve();
              return;
            }
            const error = new Error(
              `ffmpeg exited with code ${code} signal ${signal ?? '-'}: ${stderr.trim()}`,
            );
            // ffmpeg reports a full disk on stderr rather than via an errno; tag it so the
            // cache can recognise it as ENOSPC and trigger an emergency sweep.
            if (/No space left on device/i.test(stderr)) {
              (error as Error & { code?: string }).code = 'ENOSPC';
            }
            reject(error);
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
    get aborted(): boolean {
      return aborted;
    },
    kill: (): void => {
      killed = true;
      proc?.kill('SIGTERM');
    },
  };
}

/** Nominal encode bitrate (kbps) for a transcoded lossy target, or `null` for codecs without a fixed target bitrate (flac, or any copy). For display only. */
export function encodeBitrateKbps(target: EncodeTarget): number | null {
  switch (target.format.codec) {
    case 'opus':
      return opusBitrateKbps(target.quality);
    case 'mp3':
      return mp3BitrateKbps(target.quality);
    default:
      return null;
  }
}

/** Cache key fragment derived from a target. Used by the cache module to build per-entry filenames. */
export function targetKey(target: EncodeTarget): string {
  return `f-${target.format.container}-${target.format.codec}_q-${target.quality.toLowerCase()}`;
}
