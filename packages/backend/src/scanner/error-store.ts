import { eq, inArray } from 'drizzle-orm';

import { db } from '../db/client.js';
import { scanErrors } from '../db/schema/index.js';
import { categoriseScanError } from './error-category.js';

/** Record (or refresh) the error row for a file the scanner failed to read, categorising the failure for display and stashing the full stack for diagnosis. Keyed by path, so a repeated failure updates the existing row rather than piling up duplicates. */
export async function recordFileError(file: string, err: unknown): Promise<void> {
  const message = categoriseScanError(err);
  const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const now = new Date();
  await db
    .insert(scanErrors)
    .values({ file, message, stack, attemptedAt: now })
    .onConflictDoUpdate({
      target: scanErrors.file,
      set: { message, stack, attemptedAt: now },
    });
}

/** Drop the error row for a file, if any. Called when the file later scans cleanly or is deleted, so a recovered file stops being reported. */
export async function clearFileError(file: string): Promise<void> {
  await db.delete(scanErrors).where(eq(scanErrors.file, file));
}

/** Return the subset of `paths` that currently have an error row, in one query. Lets the scanner skip files it already knows are broken without preloading the whole error table. */
export async function erroredFilesIn(paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const rows = await db
    .select({ file: scanErrors.file })
    .from(scanErrors)
    .where(inArray(scanErrors.file, paths));
  return new Set(rows.map((r) => r.file));
}
