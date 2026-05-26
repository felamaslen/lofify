import { z } from 'zod';

import { FormatLossy, Quality } from '../graphql/playback-format.js';

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

const FORMAT_LOSSY_TO_URL = {
  [FormatLossy.OPUS]: 'opus',
  [FormatLossy.MP3]: 'mp3',
} satisfies Record<FormatLossy, string>;
const URL_TO_FORMAT_LOSSY = Object.fromEntries(
  Object.entries(FORMAT_LOSSY_TO_URL).map(([k, v]) => [v, k]),
) as Record<string, FormatLossy>;

export function qualityToToken(q: Quality): string {
  return QUALITY_TO_URL[q];
}

export function formatLossyToToken(f: FormatLossy): string {
  return FORMAT_LOSSY_TO_URL[f];
}

const OptionsSchema = z.object({
  quality: z.enum(Quality),
  formatLossy: z.enum(FormatLossy),
});

export type ParsedOptions = z.infer<typeof OptionsSchema>;

/**
 * Parse the option segments of a `/play/...` URL. The grammar is `q:<min|l|m|h|max>` and `f:<opus|mp3>`, in any order — both are required. Returns `null` if a key repeats, an unknown key appears, a value is outside the supported set, or a required key is missing.
 */
export function parseOptionSegments(segments: string[]): ParsedOptions | null {
  let quality: Quality | undefined;
  let formatLossy: FormatLossy | undefined;
  for (const segment of segments) {
    if (segment === '') continue;
    const idx = segment.indexOf(':');
    if (idx < 0) return null;
    const key = segment.slice(0, idx);
    const value = segment.slice(idx + 1);
    switch (key) {
      case 'q': {
        if (quality !== undefined) return null;
        const mapped = URL_TO_QUALITY[value];
        if (!mapped) return null;
        quality = mapped;
        break;
      }
      case 'f': {
        if (formatLossy !== undefined) return null;
        const mapped = URL_TO_FORMAT_LOSSY[value];
        if (!mapped) return null;
        formatLossy = mapped;
        break;
      }
      default:
        return null;
    }
  }
  if (quality === undefined || formatLossy === undefined) return null;
  const result = OptionsSchema.safeParse({ quality, formatLossy });
  return result.success ? result.data : null;
}
