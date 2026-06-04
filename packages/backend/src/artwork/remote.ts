import ky from 'ky';

import { env } from '../env.js';

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Download an image from a user-supplied URL (e.g. one dropped from another browser tab — the server fetches because most image hosts block cross-origin reads on the client). The body is streamed and the transfer aborted as soon as it exceeds `UPLOAD_MAX_BYTES`, so an oversized (or unbounded) source never buffers past the cap. Whether the bytes really are an image is sniffed where they are stored, exactly as for file uploads.
 */
export async function fetchRemoteImage(rawUrl: string): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Artwork URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Artwork URL must be http(s).');
  }

  // One deadline for the whole download — ky's own timeout only covers time-to-headers when the
  // body is streamed manually — joined with a local controller that cuts the transfer off at the
  // byte cap.
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);

  try {
    const res = await ky.get(url, {
      signal,
      timeout: false,
      retry: 0,
      headers: { accept: 'image/*' },
    });
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > env.UPLOAD_MAX_BYTES) {
      controller.abort();
      throw new Error('the image is too large');
    }
    if (!res.body) throw new Error('the response was empty');

    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > env.UPLOAD_MAX_BYTES) {
        controller.abort();
        throw new Error('the image is too large');
      }
      chunks.push(value);
    }
    if (received === 0) throw new Error('the response was empty');
    return Buffer.concat(chunks);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not fetch the artwork URL: ${detail}`);
  }
}
