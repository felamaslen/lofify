/**
 * Browser playback capabilities, as the preference-ordered MIME lists the server's format resolver expects. The app is MSE-only — playback is impossible without `MediaSource`, and every delivery codec needs a `MediaSource.isTypeSupported` ack. Detected once at module load — the result is stable per page lifetime.
 */

const MP4_OPUS = 'audio/mp4; codecs="opus"';
const WEBM_OPUS = 'audio/webm; codecs="opus"';
const WEBM_VORBIS = 'audio/webm; codecs="vorbis"';
const MP4_FLAC = 'audio/mp4; codecs="flac"';
const MPEG = 'audio/mpeg';

/** Which lossy codec the user would rather receive when the server has to transcode. */
export type LossyPreference = 'OPUS' | 'MP3';

export type Capabilities = {
  /** Whether `MediaSource` exists at all. When false, playback is impossible and the UI should block. */
  mse: boolean;
  /** Whether the page is running as an installed PWA (display-mode standalone, or iOS `navigator.standalone`). Gates features that depend on gapless cross-track buffering — Original mode can pick any codec per track, which a single SourceBuffer can't span, so it's hidden in standalone where backgrounded JS throttling makes the `ended`-driven track change unreliable. */
  standalone: boolean;
  /** Preference-ordered lossless MIME types playable via MSE (`audio/mp4; codecs="flac"` when supported, else empty). Sent as `TrackFormat.losslessFormats`. */
  losslessFormats: string[];
  /** Whether FLAC-in-MP4 decodes — i.e. lossless sources can be delivered losslessly. Drives the Max-quality tooltip. */
  flacInMp4: boolean;
  /** Whether Opus can be delivered (in either container). Enables the Opus preference. */
  opusSupported: boolean;
  /** Whether MP3 can be delivered. Enables the MP3 preference. */
  mp3Supported: boolean;
  /**
   * Build the `TrackFormat.lossyFormats` list to send for a given preference. The preferred transcodable codec leads (it wins below MAX and as the MAX fallback); copy-only Vorbis always trails — present so a Vorbis source can be copied, never chosen for a transcode.
   */
  lossyFormats(preference: LossyPreference): string[];
};

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari predates display-mode and exposes a non-standard boolean.
  return (window.navigator as { standalone?: boolean }).standalone === true;
}

function detect(): Capabilities {
  const standalone = detectStandalone();
  if (typeof MediaSource === 'undefined') {
    return {
      mse: false,
      standalone,
      losslessFormats: [],
      flacInMp4: false,
      opusSupported: false,
      mp3Supported: false,
      lossyFormats: () => [],
    };
  }
  const sup = (t: string): boolean => MediaSource.isTypeSupported(t);
  const opus = [MP4_OPUS, WEBM_OPUS].filter(sup);
  const mp3 = sup(MPEG) ? [MPEG] : [];
  const vorbis = sup(WEBM_VORBIS) ? [WEBM_VORBIS] : [];
  const flac = sup(MP4_FLAC) ? [MP4_FLAC] : [];
  return {
    mse: true,
    standalone,
    losslessFormats: flac,
    flacInMp4: flac.length > 0,
    opusSupported: opus.length > 0,
    mp3Supported: mp3.length > 0,
    lossyFormats: (preference) => {
      const ordered = preference === 'MP3' ? [...mp3, ...opus] : [...opus, ...mp3];
      return [...ordered, ...vorbis];
    },
  };
}

export const capabilities: Capabilities = detect();
