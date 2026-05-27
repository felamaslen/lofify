import { Quality } from '../graphql/playback-format.js';
import type { EncodeFormat, EncodeTarget } from './encoder.js';

const QUALITY_TO_URL = {
  [Quality.MIN]: 'min',
  [Quality.LOW]: 'l',
  [Quality.MEDIUM]: 'm',
  [Quality.HIGH]: 'h',
  [Quality.MAX]: 'max',
} satisfies Record<Quality, string>;
// Derived from `QUALITY_TO_URL` so the two tables can't drift; the cast is sound because `Object.entries` over a `Record<Quality, string>` yields the enum keys as strings.
const URL_TO_QUALITY = Object.fromEntries(
  Object.entries(QUALITY_TO_URL).map(([k, v]) => [v, k]),
) as Record<string, Quality>;

// The signed URL bakes a fully-resolved `(container, codec)` rather than the client's request, because
// `auto` resolution at MAX depends on client capabilities the stateless `/play` route never sees. The
// resolver runs once in `Track.url`; the route and the manifest subscription just decode the result.
const VALID_FORMATS = [
  'mp4/opus',
  'mp4/flac',
  'webm/opus',
  'webm/vorbis',
  'mp3/mp3',
] as const satisfies `${EncodeFormat['container']}/${EncodeFormat['codec']}`[];

export function qualityToToken(q: Quality): string {
  return QUALITY_TO_URL[q];
}

/** URL option segments for a resolved target: `c:<container>`, `a:<codec>`, `q:<quality>`. */
export function encodeTargetSegments(target: EncodeTarget): string[] {
  return [
    `c:${target.format.container}`,
    `a:${target.format.codec}`,
    `q:${qualityToToken(target.quality)}`,
  ];
}

/**
 * Parse the option segments of a `/play/...` URL into the resolved `EncodeTarget`. The grammar is `c:<container>`, `a:<codec>` and `q:<min|l|m|h|max>`, in any order — all three are required. Returns `null` if a key repeats, an unknown key appears, a value is outside the supported set, a required key is missing, or the `(container, codec)` pair isn't one the encoder produces.
 */
export function parseOptionSegments(segments: string[]): EncodeTarget | null {
  let container: string | undefined;
  let codec: string | undefined;
  let quality: Quality | undefined;
  for (const segment of segments) {
    if (segment === '') continue;
    const idx = segment.indexOf(':');
    if (idx < 0) return null;
    const key = segment.slice(0, idx);
    const value = segment.slice(idx + 1);
    switch (key) {
      case 'c':
        if (container !== undefined) return null;
        container = value;
        break;
      case 'a':
        if (codec !== undefined) return null;
        codec = value;
        break;
      case 'q': {
        if (quality !== undefined) return null;
        const mapped = URL_TO_QUALITY[value];
        if (!mapped) return null;
        quality = mapped;
        break;
      }
      default:
        return null;
    }
  }
  if (container === undefined || codec === undefined || quality === undefined) return null;
  const pair = `${container}/${codec}`;
  if (!(VALID_FORMATS as readonly string[]).includes(pair)) return null;
  return {
    format: { container, codec } as EncodeFormat,
    quality,
  };
}
