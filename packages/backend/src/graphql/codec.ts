/**
 * Pure helpers for normalising the verbose codec/format strings `music-metadata` reports into the short tokens the rest of the app uses. Kept in a leaf module (no GraphQL or playback imports) so both `track.ts` and the playback `resolve.ts` can use it without forming an import cycle.
 */

export function deriveFormat(format: string, codec: string): string {
  const f = format.toLowerCase();
  const c = codec.toLowerCase();
  if (f === c) return f;
  if (c.includes(f) || f.includes(c)) return c.length >= f.length ? c : f;
  return `${f} ${c}`;
}

/** Collapse the verbose `music-metadata` codec string (e.g. `"mpeg 1 layer 3"`) into a short, human-friendly abbreviation suitable for display (e.g. `"mp3"`). Falls back to the raw input when no rule matches. */
export function abbreviateCodec(raw: string): string {
  const c = raw.toLowerCase().trim();
  if (!c) return c;
  if (/\bmpeg\b.*\blayer\s*3\b/.test(c) || c === 'mp3') return 'mp3';
  if (/\bmpeg\b.*\blayer\s*2\b/.test(c) || c === 'mp2') return 'mp2';
  if (c === 'flac') return 'flac';
  if (c === 'alac' || c.includes('apple lossless')) return 'alac';
  if (c === 'opus') return 'opus';
  if (c.includes('vorbis')) return 'vorbis';
  if (c.includes('aac')) return 'aac';
  if (c.includes('windows media') || c === 'wma') return 'wma';
  if (c.includes("monkey's audio") || c === 'ape') return 'ape';
  if (c.includes('wavpack') || c === 'wv') return 'wv';
  if (c.includes('musepack') || c === 'mpc') return 'mpc';
  if (c === 'tta' || c.includes('true audio')) return 'tta';
  if (c.startsWith('pcm')) return 'pcm';
  if (c.includes('dsd')) return 'dsd';
  return c;
}
