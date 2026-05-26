/**
 * Browser playback capabilities. The app is MSE-only — playback is impossible without `MediaSource`, and every supported delivery codec needs a corresponding `MediaSource.isTypeSupported` ack. Detected once at module load — the result is stable per page lifetime.
 */

export type Capabilities = {
  /** Whether `MediaSource` exists at all. When false, playback is impossible and the UI should block. */
  mse: boolean;
  /** `audio/mp4; codecs="opus"` — required for opus delivery. */
  opusInMp4: boolean;
  /** `audio/mp4; codecs="flac"` — required to receive lossless flac at MAX quality. When false, MAX still works but the server falls through to the lossy preset in `formatLossy`. */
  flacInMp4: boolean;
  /** `audio/mpeg` — required for mp3 delivery. */
  mp3: boolean;
};

function detect(): Capabilities {
  if (typeof MediaSource === 'undefined') {
    return { mse: false, opusInMp4: false, flacInMp4: false, mp3: false };
  }
  return {
    mse: true,
    opusInMp4: MediaSource.isTypeSupported('audio/mp4; codecs="opus"'),
    flacInMp4: MediaSource.isTypeSupported('audio/mp4; codecs="flac"'),
    mp3: MediaSource.isTypeSupported('audio/mpeg'),
  };
}

export const capabilities: Capabilities = detect();
