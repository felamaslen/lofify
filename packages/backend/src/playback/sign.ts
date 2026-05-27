import crypto from 'node:crypto';

import { env } from '../env.js';
import type { EncodeTarget } from './encoder.js';
import { encodeTargetSegments } from './options.js';

export function signPayload(payload: string): string {
  return crypto.createHmac('sha256', env.PLAYBACK_SIGNING_SECRET).update(payload).digest('hex');
}

export function signPlaybackUrl(id: string, target: EncodeTarget): string {
  const payload = [...encodeTargetSegments(target), id].join('/');
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
