/**
 * Browser playback capabilities the player negotiates against the server's `Accept` header rules. Detected once at module load — the result is stable per page lifetime.
 */
export type Capabilities = {
  /** Bare `<audio>` element can decode flac (used by the passthrough path; flac is NOT routed through MSE). */
  flacDirect: boolean;
  /** MSE supports `audio/mpeg` — required for chunked mp3 playback. */
  mpegMse: boolean;
  /** MSE supports `audio/mp4; codecs="opus"` — required for chunked Opus (fMP4) playback. */
  mp4OpusMse: boolean;
};

function detect(): Capabilities {
  if (typeof window === 'undefined') {
    return { flacDirect: false, mpegMse: false, mp4OpusMse: false };
  }
  const audio = document.createElement('audio');
  // `canPlayType` returns `''` (no), `'maybe'` or `'probably'` — anything other than `''` counts as supported. Some browsers historically used `audio/x-flac`.
  const flacDirect =
    audio.canPlayType('audio/flac') !== '' || audio.canPlayType('audio/x-flac') !== '';
  const mse = typeof MediaSource !== 'undefined';
  return {
    flacDirect,
    mpegMse: mse && MediaSource.isTypeSupported('audio/mpeg'),
    mp4OpusMse: mse && MediaSource.isTypeSupported('audio/mp4; codecs="opus"'),
  };
}

export const capabilities: Capabilities = detect();

export type Quality = 'max' | 'high' | 'medium' | 'low';

/** Encoded delivery format the client requests. Flac is *not* a selectable format here — it kicks in implicitly when quality is `max` and the source is lossless. */
export type Format = 'mp4' | 'mp3';

/**
 * Build the `Accept` header value the server will negotiate against. `max` puts `audio/flac` first so the server can pick passthrough on lossless sources; the selected encoded format follows so lossy sources (and lossy → encoded fallback) get the user's chosen container.
 */
export function acceptHeaderFor(
  quality: Quality,
  format: Format,
  caps: Capabilities = capabilities,
): string {
  const parts: string[] = [];
  if (quality === 'max' && caps.flacDirect) parts.push('audio/flac');
  parts.push(format === 'mp4' ? 'audio/mp4' : 'audio/mpeg');
  return parts.join(', ');
}

/** Whether `max` is selectable. Disabled when the browser cannot decode flac, since flac is never encoded — only passed through. */
export function isMaxQualityAvailable(caps: Capabilities = capabilities): boolean {
  return caps.flacDirect;
}

/** Whether the given encoded format can be played by this browser. */
export function isFormatAvailable(format: Format, caps: Capabilities = capabilities): boolean {
  return format === 'mp4' ? caps.mp4OpusMse : caps.mpegMse;
}

/** Pick a sensible default format — prefer mp4/opus (better quality-per-byte) and fall back to mp3. */
export function defaultFormat(caps: Capabilities = capabilities): Format {
  if (caps.mp4OpusMse) return 'mp4';
  return 'mp3';
}
