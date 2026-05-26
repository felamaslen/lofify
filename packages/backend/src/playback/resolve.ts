/**
 * Pick the `EncodeTarget` for a given client request. The rule is one line: lossless sources at `MAX` go to flac-in-mp4; everything else (lossy sources at any quality, or lossless sources at non-max quality) goes to the lossy target in the requested format. Passthrough vs re-encode is decided downstream by the cache module from `sourceCodec === target.codec`.
 */

import type { Track as DbTrack } from '../db/schema/index.js';
import { FormatLossy, Quality } from '../graphql/playback-format.js';
import type { EncodeTarget } from './encoder.js';
import type { ParsedOptions } from './options.js';

const FLAC_TARGET: EncodeTarget = {
  format: { container: 'mp4', codec: 'flac' },
  quality: Quality.MAX,
};

function lossyTarget(quality: Quality, formatLossy: FormatLossy): EncodeTarget {
  switch (formatLossy) {
    case FormatLossy.OPUS:
      return { format: { container: 'mp4', codec: 'opus' }, quality };
    case FormatLossy.MP3:
      return { format: { container: 'mp3', codec: 'mp3' }, quality };
  }
}

export function resolveTarget(track: DbTrack, opts: ParsedOptions): EncodeTarget {
  if (track.isLossless && opts.quality === Quality.MAX) return FLAC_TARGET;
  return lossyTarget(opts.quality, opts.formatLossy);
}

export function contentTypeFor(target: EncodeTarget): string {
  switch (target.format.container) {
    case 'mp4':
      switch (target.format.codec) {
        case 'opus':
          return 'audio/mp4; codecs="opus"';
        case 'flac':
          return 'audio/mp4; codecs="flac"';
      }
      break;
    case 'mp3':
      return 'audio/mpeg';
  }
}
