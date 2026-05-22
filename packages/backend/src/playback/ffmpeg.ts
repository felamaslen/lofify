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

type Quality = 'low' | 'medium' | 'high' | 'max';

/** Map our named quality scale to a target bitrate (in kbps) for the given encoder. `max` is only chosen by the server when the client asked for flac but the source is lossy. */
function bitrateForQuality(format: 'webm' | 'mp3', quality: Quality): number {
  const table: Record<Quality, number> =
    format === 'webm'
      ? { low: 64, medium: 128, high: 192, max: 256 }
      : { low: 128, medium: 192, high: 256, max: 320 };
  return table[quality];
}

function webmCodecArgs(quality: Quality): string[] {
  const bitrate = bitrateForQuality('webm', quality);
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

/** Spawn ffmpeg to produce playback chunks for `source` in `outDir`. The container determines the muxer: webm/opus uses the DASH muxer (one init segment + N media segments — gapless by construction); mp3 uses the segment muxer (frame-aligned standalone mp3 files, no init segment). */
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
      await acquireSlot();
      span.setAttribute('playback.semaphore.waitMs', Date.now() - semaphoreStart);
      if (killed) {
        releaseSlot();
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
            target.format.container === 'webm'
              ? [
                  ...base,
                  ...webmCodecArgs(target.quality),
                  // `-f dash` runs as a single encoder pass and writes one init segment + N media segments — gap-less by construction across chunk boundaries.
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
