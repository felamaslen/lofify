/** Map a thrown scan error to a short, user-facing category. Recognised failures get a friendly label; anything else falls back to "Unknown error", with the full stack preserved separately. Categories are added as real failures surface in production. */
export function categoriseScanError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return 'File not found';
  return 'Unknown error';
}
