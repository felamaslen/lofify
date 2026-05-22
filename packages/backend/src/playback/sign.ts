import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';

const _PlaybackOptionsSchema = z.object({
  quality: z.number().int().min(0).max(10).nullable(),
  format: z.string().nullable(),
});

export type PlaybackOptions = z.infer<typeof _PlaybackOptionsSchema>;

function encodeOptionsSegments(opts: PlaybackOptions): string[] {
  const parts: string[] = [];
  if (opts.format != null) parts.push(`f:${opts.format.toLowerCase()}`);
  if (opts.quality != null) parts.push(`q:${opts.quality}`);
  return parts;
}

export function signPayload(payload: string): string {
  return crypto
    .createHmac('sha256', env.PLAYBACK_SIGNING_SECRET)
    .update(payload)
    .digest('hex');
}

export function signPlaybackUrl(id: string, opts: PlaybackOptions): string {
  const segments = encodeOptionsSegments(opts);
  segments.push(id);
  const payload = segments.join('/');
  return `/play/${signPayload(payload)}/${payload}`;
}

export function verifySignature(payload: string, signature: string): boolean {
  const expected = signPayload(payload);
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}
