/**
 * Browser playback capabilities the player negotiates against the server's `Accept` header rules. Detected once at module load — the result is stable per page lifetime.
 */
export type Capabilities = {
  /** Bare `<audio>` element can decode flac (used by the passthrough path; flac is NOT routed through MSE). */
  flacDirect: boolean;
  /** MSE supports `audio/mpeg` — required for chunked mp3 playback. */
  mpegMse: boolean;
  /** MSE supports `audio/webm; codecs=opus` — required for chunked Opus playback. */
  webmMse: boolean;
};

function detect(): Capabilities {
  if (typeof window === 'undefined') {
    return { flacDirect: false, mpegMse: false, webmMse: false };
  }
  const audio = document.createElement('audio');
  // `canPlayType` returns `''` (no), `'maybe'` or `'probably'` — anything other than `''` counts as supported. Some browsers historically used `audio/x-flac`.
  const flacDirect =
    audio.canPlayType('audio/flac') !== '' || audio.canPlayType('audio/x-flac') !== '';
  const mse = typeof MediaSource !== 'undefined';
  return {
    flacDirect,
    mpegMse: mse && MediaSource.isTypeSupported('audio/mpeg'),
    webmMse: mse && MediaSource.isTypeSupported('audio/webm; codecs=opus'),
  };
}

export const capabilities: Capabilities = detect();

export type Quality = 'max' | 'high' | 'medium' | 'low';

/**
 * Build the `Accept` header value the server will negotiate against. `max` puts `audio/flac` first so the server can pick passthrough on lossless sources; everything else lists only encoded formats in preference order (webm first — better quality-per-byte than mp3).
 */
export function acceptHeaderFor(quality: Quality, caps: Capabilities = capabilities): string {
  const parts: string[] = [];
  if (quality === 'max' && caps.flacDirect) parts.push('audio/flac');
  if (caps.webmMse) parts.push('audio/webm');
  if (caps.mpegMse) parts.push('audio/mpeg');
  return parts.join(', ');
}

/** Whether `max` is selectable. Disabled when the browser cannot decode flac, since flac is never encoded — only passed through. */
export function isMaxQualityAvailable(caps: Capabilities = capabilities): boolean {
  return caps.flacDirect;
}
