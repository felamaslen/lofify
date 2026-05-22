import { spawn } from 'node:child_process';

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { env } from '../env.js';
import type { Entry, TranscodeTarget } from './transcode.js';

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

export async function runFfmpeg(
  entry: Entry,
  source: string,
  target: TranscodeTarget,
): Promise<void> {
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
          // `-progress pipe:2` writes machine-parseable progress lines
          // (`out_time_us=N`, `progress=continue|end`, …) onto stderr so we
          // can track how many seconds of audio have been encoded so far.
          const proc = spawn('ffmpeg', [
            '-hide_banner',
            '-loglevel',
            'error',
            '-progress',
            'pipe:2',
            ...args,
          ]);
          let stderr = '';
          proc.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            const match = /(?:^|\n)out_time_us=(\d+)/g;
            let m: RegExpExecArray | null;
            let latest: number | null = null;
            while ((m = match.exec(text)) !== null) latest = Number(m[1]);
            if (latest != null && Number.isFinite(latest)) {
              entry.transcodedSeconds = latest / 1_000_000;
              entry.emitter.emit('progress');
            }
          });

          const emit = (chunk: Buffer): void => {
            entry.chunks.push(chunk);
            entry.bytes += chunk.length;
            entry.lastAccess = Date.now();
            entry.emitter.emit('chunk', chunk);
          };

          // TESTING ONLY — when `TRANSCODE_MAX_BITRATE` is set, serialise the
          // emit calls through a delay chain so each chunk waits its share of
          // wall-clock time, keeping the effective throughput at or below the
          // configured bits/sec. ffmpeg keeps producing at full speed in the
          // background; we just gate when consumers see the bytes.
          const maxBps = env.TRANSCODE_MAX_BITRATE;
          let emitQueue: Promise<void> = Promise.resolve();
          proc.stdout.on('data', (chunk: Buffer) => {
            if (maxBps <= 0) {
              emit(chunk);
              return;
            }
            const delayMs = (chunk.length * 8 * 1000) / maxBps;
            emitQueue = emitQueue.then(() => new Promise((r) => setTimeout(r, delayMs)));
            void emitQueue.then(() => emit(chunk));
          });

          proc.on('error', reject);
          proc.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
              return;
            }
            if (maxBps <= 0) resolve();
            else void emitQueue.then(() => resolve());
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
