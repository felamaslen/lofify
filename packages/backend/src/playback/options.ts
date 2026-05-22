import { z } from 'zod';

export const FORMAT_VALUES = [
  'original',
  'auto_hi',
  'auto_lo',
  'aac',
  'ogg',
  'webm',
  'flac',
] as const;
export type RequestedFormat = (typeof FORMAT_VALUES)[number];

const OptionsSchema = z.object({
  format: z.enum(FORMAT_VALUES).nullable(),
  quality: z.number().int().min(0).max(10).nullable(),
});

export type ParsedOptions = z.infer<typeof OptionsSchema>;

/**
 * Parse the `options` portion of a `/play/...` URL — zero or more `<key>:<value>` segments such as `f:ogg`, `q:7`.
 *
 * Returns `null` when a segment cannot be parsed, when a key repeats, or when a value violates a constraint.
 */
export function parseOptionSegments(segments: string[]): ParsedOptions | null {
  const raw: { format?: string; quality?: number } = {};
  for (const segment of segments) {
    if (segment === '') continue;
    const idx = segment.indexOf(':');
    if (idx < 0) return null;
    const key = segment.slice(0, idx);
    const value = segment.slice(idx + 1);
    if (key === 'f') {
      if (raw.format !== undefined) return null;
      raw.format = value;
    } else if (key === 'q') {
      if (raw.quality !== undefined) return null;
      const n = Number(value);
      if (!Number.isInteger(n)) return null;
      raw.quality = n;
    } else {
      return null;
    }
  }
  const result = OptionsSchema.safeParse({
    format: raw.format ?? null,
    quality: raw.quality ?? null,
  });
  return result.success ? result.data : null;
}
