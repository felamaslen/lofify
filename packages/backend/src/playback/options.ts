import { z } from 'zod';

/** Quality the client asks the server to deliver. `low` / `medium` / `high` map to coarse encoder presets; `max` is the highest-fidelity preset and pins the URL to the lossy transcode pipeline (it suppresses any flac upgrade that might otherwise apply via `Accept: audio/flac`). */
export type Quality = 'low' | 'medium' | 'high' | 'max';

/** Client-selectable qualities, in their on-URL single-character form. Capital `M` is `max`; lowercase letters are mnemonic for `low`/`medium`/`high`. */
const CHAR_TO_QUALITY = { l: 'low', m: 'medium', h: 'high', M: 'max' } as const satisfies Record<string, Quality>;
const QUALITY_TO_CHAR: Record<Quality, 'l' | 'm' | 'h' | 'M'> = {
  low: 'l',
  medium: 'm',
  high: 'h',
  max: 'M',
};

export function qualityToChar(q: Quality): 'l' | 'm' | 'h' | 'M' {
  return QUALITY_TO_CHAR[q];
}

const QualitySchema = z.enum(['low', 'medium', 'high', 'max']);

const OptionsSchema = z.object({
  quality: QualitySchema.nullable(),
});

export type ParsedOptions = z.infer<typeof OptionsSchema>;

/**
 * Parse the `options` portion of a `/play/...` URL — zero or one `q:<l|m|h|M>` segment.
 *
 * Returns `null` when a segment cannot be parsed, when the key repeats, or when the value is outside the supported set.
 */
export function parseOptionSegments(segments: string[]): ParsedOptions | null {
  let quality: Quality | undefined;
  for (const segment of segments) {
    if (segment === '') continue;
    const idx = segment.indexOf(':');
    if (idx < 0) return null;
    const key = segment.slice(0, idx);
    const value = segment.slice(idx + 1);
    if (key === 'q') {
      if (quality !== undefined) return null;
      const mapped = (CHAR_TO_QUALITY as Record<string, Quality | undefined>)[value];
      if (!mapped) return null;
      quality = mapped;
    } else {
      return null;
    }
  }
  const result = OptionsSchema.safeParse({ quality: quality ?? null });
  return result.success ? result.data : null;
}
