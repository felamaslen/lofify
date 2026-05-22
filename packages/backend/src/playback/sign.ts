import crypto from 'node:crypto';

import { env } from '../env.js';
import type { ParsedOptions } from './options.js';

function encodeOptionsSegments(opts: ParsedOptions): string[] {
  const parts: string[] = [];
  if (opts.format != null) parts.push(`f:${opts.format}`);
  if (opts.quality != null) parts.push(`q:${opts.quality}`);
  return parts;
}

export function signPayload(payload: string): string {
  return crypto.createHmac('sha256', env.PLAYBACK_SIGNING_SECRET).update(payload).digest('hex');
}

export function signPlaybackUrl(id: string, opts: ParsedOptions): string {
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
