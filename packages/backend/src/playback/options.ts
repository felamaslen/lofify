import { z } from 'zod';

/** Quality the client asks the server to deliver. `low` / `medium` / `high` map to coarse encoder presets; `max` is server-internal — it's chosen when the client accepts flac but the source is lossy, and corresponds to the encoder's highest fidelity preset. */
export type Quality = 'low' | 'medium' | 'high' | 'max';

/** The three client-selectable qualities, in their on-URL single-character form. `max` is intentionally absent — clients ask for it via `Accept: audio/flac, ...`, not via the URL. */
const CHAR_TO_QUALITY = { l: 'low', m: 'medium', h: 'high' } as const satisfies Record<string, Quality>;
const QUALITY_TO_CHAR: Record<'low' | 'medium' | 'high', 'l' | 'm' | 'h'> = {
  low: 'l',
  medium: 'm',
  high: 'h',
};

export function qualityToChar(q: 'low' | 'medium' | 'high'): 'l' | 'm' | 'h' {
  return QUALITY_TO_CHAR[q];
}

const QualitySchema = z.enum(['low', 'medium', 'high']);

const OptionsSchema = z.object({
  quality: QualitySchema.nullable(),
});

export type ParsedOptions = z.infer<typeof OptionsSchema>;

/**
 * Parse the `options` portion of a `/play/...` URL — zero or one `q:<l|m|h>` segment.
 *
 * Returns `null` when a segment cannot be parsed, when the key repeats, or when the value is outside the supported set.
 */
export function parseOptionSegments(segments: string[]): ParsedOptions | null {
  let quality: 'low' | 'medium' | 'high' | undefined;
  for (const segment of segments) {
    if (segment === '') continue;
    const idx = segment.indexOf(':');
    if (idx < 0) return null;
    const key = segment.slice(0, idx);
    const value = segment.slice(idx + 1);
    if (key === 'q') {
      if (quality !== undefined) return null;
      const mapped = (CHAR_TO_QUALITY as Record<string, 'low' | 'medium' | 'high' | undefined>)[value];
      if (!mapped) return null;
      quality = mapped;
    } else {
      return null;
    }
  }
  const result = OptionsSchema.safeParse({ quality: quality ?? null });
  return result.success ? result.data : null;
}
