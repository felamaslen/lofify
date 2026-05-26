import crypto from 'node:crypto';

import { env } from '../env.js';
import { formatLossyToToken, type ParsedOptions, qualityToToken } from './options.js';

function encodeOptionsSegments(opts: ParsedOptions): string[] {
  return [`q:${qualityToToken(opts.quality)}`, `f:${formatLossyToToken(opts.formatLossy)}`];
}

export function signPayload(payload: string): string {
  return crypto.createHmac('sha256', env.PLAYBACK_SIGNING_SECRET).update(payload).digest('hex');
}

export function signPlaybackUrl(id: string, opts: ParsedOptions): string {
  const payload = [...encodeOptionsSegments(opts), id].join('/');
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
