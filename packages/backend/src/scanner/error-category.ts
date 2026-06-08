/** Map a thrown scan error to a short, user-facing category. Everything is "Unknown error" for now; real categories will be added once we see which failures actually occur in production. The full stack is preserved separately, so no detail is lost in the meantime. */
export function categoriseScanError(_err: unknown): string {
  return 'Unknown error';
}
