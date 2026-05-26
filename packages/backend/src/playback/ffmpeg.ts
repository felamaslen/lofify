import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { env } from '../env.js';
import type { TranscodeTarget } from './transcode.js';

const tracer = trace.getTracer('lofify.playback');

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

const transcodeSem = makeSemaphore(() => env.TRANSCODE_MAX_PARALLEL);
const bakeSem = makeSemaphore(() => env.TRANSCODE_BAKE_PARALLEL);

type Quality = 'low' | 'medium' | 'high' | 'max';

/** Map our named quality scale to a target bitrate (in kbps) for the given encoder. `max` is only chosen by the server when the client asked for flac but the source is lossy. */
function bitrateForQuality(format: 'mp4' | 'mp3', quality: Quality): number {
  const table: Record<Quality, number> =
    format === 'mp4'
      ? { low: 64, medium: 128, high: 192, max: 256 }
      : { low: 128, medium: 192, high: 256, max: 320 };
  return table[quality];
}

function opusCodecArgs(quality: Quality): string[] {
  const bitrate = bitrateForQuality('mp4', quality);
  return [
    '-c:a',
    'libopus',
    '-b:a',
    `${bitrate}k`,
    '-vbr',
    'on',
    '-application',
    'audio',
    // libopus encodes internally at 48 kHz, so any non-48 kHz source has to be resampled. Force the SoX resampler (`soxr`) at maximum precision instead of swresample's default; it noticeably reduces high-frequency ringing on lossy → lossy transcodes (e.g. 44.1 kHz Vorbis → 48 kHz Opus).
    '-af',
    'aresample=resampler=soxr:precision=28:dither_method=triangular_hp',
    '-ar',
    '48000',
  ];
}

function mp3CodecArgs(quality: Quality): string[] {
  const bitrate = bitrateForQuality('mp3', quality);
  return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`];
}

export interface FfmpegHandle {
  readonly done: Promise<void>;
  kill(): void;
}

/** Spawn ffmpeg to produce playback chunks for `source` in `outDir`. The container determines the muxer: mp4/opus uses the DASH muxer with fMP4 segments (one init segment + N media segments — gapless by construction, and Chrome's MSE plays them more cleanly than WebM-Opus); mp3 uses the segment muxer (frame-aligned standalone mp3 files, no init segment). */
export function spawnChunkedEncoder(
  source: string,
  target: TranscodeTarget,
  outDir: string,
  segmentSeconds: number,
): FfmpegHandle {
  let killed = false;
  let proc: ChildProcessWithoutNullStreams | null = null;
  const done = tracer.startActiveSpan(
    'playback.transcode',
    {
      attributes: {
        'playback.source': source,
        'playback.target.container': target.format.container,
        'playback.target.codec': target.format.codec,
        'playback.target.quality': target.quality,
      },
    },
    async (span) => {
      const semaphoreStart = Date.now();
      await acquire(transcodeSem);
      span.setAttribute('playback.semaphore.waitMs', Date.now() - semaphoreStart);
      if (killed) {
        release(transcodeSem);
        span.end();
        return;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const base = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            source,
            '-vn',
          ];
          const args =
            target.format.container === 'mp4'
              ? [
                  ...base,
                  ...opusCodecArgs(target.quality),
                  // `-f dash` runs as a single encoder pass and writes one init segment + N media segments — gap-less by construction across chunk boundaries. fMP4 (`-dash_segment_type mp4`) is preferred over WebM because Chrome's MSE plays multi-segment Opus more cleanly out of fMP4 (no audible glitches at cluster boundaries).
                  '-f',
                  'dash',
                  '-dash_segment_type',
                  'mp4',
                  '-seg_duration',
                  String(segmentSeconds),
                  '-use_template',
                  '1',
                  '-use_timeline',
                  '0',
                  '-single_file',
                  '0',
                  '-init_seg_name',
                  'init.mp4',
                  '-media_seg_name',
                  'chunk-$Number%05d$.m4s',
                  '-window_size',
                  '0',
                  '-extra_window_size',
                  '0',
                  '-remove_at_exit',
                  '0',
                  `${outDir}/manifest.mpd`,
                ]
              : [
                  ...base,
                  ...mp3CodecArgs(target.quality),
                  // Segment muxer writes standalone mp3 files with frame-aligned boundaries; no init segment is needed because every mp3 frame is self-describing. `-reset_timestamps` makes each chunk start at PTS 0, which is how MSE expects them when appended to an `audio/mpeg` SourceBuffer.
                  '-f',
                  'segment',
                  '-segment_time',
                  String(segmentSeconds),
                  '-segment_format',
                  'mp3',
                  '-reset_timestamps',
                  '1',
                  `${outDir}/chunk-%05d.mp3`,
                ];
          proc = spawn('ffmpeg', args);
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
        release(transcodeSem);
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

/** Spawn ffmpeg to re-encode `source` as a single flac file at `outPath`. Used to bake a lossless cache of non-flac lossless sources (e.g. ape, alac) so subsequent plays can hit the existing flac-passthrough path with no further transcode. The encode uses libFLAC's default compression and writes directly to `outPath` — atomic-rename is the caller's job. Gated by the bake semaphore so a backlog of bakes never starves live playback transcodes. */
export function spawnFlacBake(source: string, outPath: string): FfmpegHandle {
  let killed = false;
  let proc: ChildProcessWithoutNullStreams | null = null;
  const done = tracer.startActiveSpan(
    'playback.bake',
    {
      attributes: {
        'playback.source': source,
        'playback.target.container': 'flac',
        'playback.target.codec': 'flac',
      },
    },
    async (span) => {
      const semaphoreStart = Date.now();
      await acquire(bakeSem);
      span.setAttribute('playback.semaphore.waitMs', Date.now() - semaphoreStart);
      if (killed) {
        release(bakeSem);
        span.end();
        return;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            source,
            '-vn',
            '-c:a',
            'flac',
            '-compression_level',
            '5',
            '-y',
            outPath,
          ];
          proc = spawn('ffmpeg', args);
          let stderr = '';
          proc.stderr.on('data', (c: Buffer) => {
            stderr += c.toString();
          });
          proc.stdout.on('data', () => undefined);
          proc.on('error', reject);
          proc.on('close', (code, signal) => {
            if (killed) return resolve();
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
        release(bakeSem);
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
