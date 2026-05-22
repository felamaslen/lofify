import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { env } from '../env.js';
import type { TranscodeTarget } from './transcode.js';

const tracer = trace.getTracer('lofify.playback');

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

function codecArgs(target: TranscodeTarget): string[] {
  const q = target.quality ?? 5;
  switch (target.format) {
    case 'webm': {
      const bitrate = Math.round(32 + (q / 10) * (256 - 32));
      // libopus encodes internally at 48 kHz, so any non-48 kHz source has to be resampled. Force the SoX resampler (`soxr`) at maximum precision instead of swresample's default; it noticeably reduces high-frequency ringing on lossy → lossy transcodes (e.g. 44.1 kHz Vorbis → 48 kHz Opus).
      return [
        '-c:a',
        'libopus',
        '-b:a',
        `${bitrate}k`,
        '-vbr',
        'on',
        '-application',
        'audio',
        '-af',
        'aresample=resampler=soxr:precision=28:dither_method=triangular_hp',
        '-ar',
        '48000',
      ];
    }
    case 'ogg': {
      const qa = Math.max(-1, Math.min(10, q));
      return ['-c:a', 'libvorbis', '-q:a', String(qa)];
    }
    case 'flac':
      return ['-c:a', 'flac'];
    case 'aac': {
      const bitrate = Math.round(64 + (q / 10) * (256 - 64));
      return ['-c:a', 'aac', '-b:a', `${bitrate}k`];
    }
  }
}

export interface FfmpegHandle {
  readonly done: Promise<void>;
  kill(): void;
}

/** Spawn a long-running ffmpeg that encodes `source` once and writes the DASH output (`init.webm` + `chunk-NNNNN.webm`) into `outDir`. One pass = no codec-boundary gaps between chunks. The returned `done` promise resolves when ffmpeg finishes (or rejects on non-zero exit); `kill` lets the cache drop the job when its entry is evicted mid-encode. */
export function spawnDashEncoder(
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
        'playback.target.format': target.format,
        'playback.target.codec': target.codec,
        'playback.target.quality': target.quality ?? -1,
      },
    },
    async (span) => {
      const semaphoreStart = Date.now();
      await acquireSlot();
      span.setAttribute('playback.semaphore.waitMs', Date.now() - semaphoreStart);
      if (killed) {
        releaseSlot();
        span.end();
        return;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          // `-f dash` runs as a single encoder pass and writes one init segment + N media segments — gap-less by construction across chunk boundaries. `-single_file 0` writes one file per segment; `-use_template 1` enables the $Number$ substitution; `-utc_timing_url` etc. would be VOD/Live-specific noise we don't need.
          const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            source,
            '-vn',
            ...codecArgs(target),
            '-f',
            'dash',
            '-dash_segment_type',
            'webm',
            '-seg_duration',
            String(segmentSeconds),
            '-use_template',
            '1',
            '-use_timeline',
            '0',
            '-single_file',
            '0',
            '-init_seg_name',
            'init.webm',
            '-media_seg_name',
            'chunk-$Number%05d$.webm',
            '-window_size',
            '0',
            '-extra_window_size',
            '0',
            '-remove_at_exit',
            '0',
            `${outDir}/manifest.mpd`,
          ];
          proc = spawn('ffmpeg', args);
          let stderr = '';
          proc.stderr.on('data', (c: Buffer) => {
            stderr += c.toString();
          });
          // Discard stdout — DASH muxer writes to files, not pipe:1.
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
        releaseSlot();
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
