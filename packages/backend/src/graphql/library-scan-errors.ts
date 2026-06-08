import { count, desc, lt } from 'drizzle-orm';
import type { ID, Int } from 'grats';

import { db } from '../db/client.js';
import { type ScanError, scanErrors } from '../db/schema/index.js';
import { deleteScanError, scanErrorFileById } from '../scanner/error-store.js';
import { upsertTrackTracked } from '../scanner/scan.js';
import type { DateTime } from './date-time.js';
import { clampLimit, DEFAULT_PAGE_SIZE, type PageInfo } from './track-queries.js';
import type { Void } from './types.js';

/**
 * A file the scanner failed to read. It is skipped on every scan until retried or dismissed, so it stops one broken file from being re-attempted endlessly.
 *
 * @gqlType
 */
export type LibraryScanError = {
  /** @gqlField */
  id: ID;
  /** Absolute path of the file that failed. @gqlField */
  filename: string;
  /** Short, human-readable category of the failure. @gqlField */
  message: string;
  /** When the most recent failed attempt occurred. @gqlField */
  attemptedAt: DateTime;
};

/**
 * One page of a Relay-style traversal over the recorded scan errors, most recent first.
 *
 * @gqlType
 */
export type LibraryScanErrorConnection = {
  /** @gqlField */
  edges: LibraryScanErrorEdge[];
  /** @gqlField */
  pageInfo: PageInfo;
  /** Total number of recorded scan errors, ignoring pagination arguments. @gqlField */
  totalCount: Int;
};

/**
 * A single entry in a `LibraryScanErrorConnection`.
 *
 * @gqlType
 */
export type LibraryScanErrorEdge = {
  /** @gqlField */
  node: LibraryScanError;
  /** Cursor for paginating relative to this edge; equal to the error's `id`. @gqlField */
  cursor: ID;
};

function toGqlError(row: ScanError): LibraryScanError {
  return {
    id: row.id,
    filename: row.file,
    message: row.message,
    attemptedAt: row.attemptedAt,
  };
}

/**
 * The files that failed to scan and are being skipped, newest first. Page through with `first`/`after`. Returns null only when something has gone wrong; an empty library of errors yields an empty connection.
 *
 * @gqlQueryField
 */
export async function libraryScanErrors(args: {
  first?: Int | null;
  after?: ID | null;
}): Promise<LibraryScanErrorConnection | null> {
  const limit = clampLimit(args.first) ?? DEFAULT_PAGE_SIZE;
  const where = args.after != null ? lt(scanErrors.id, args.after) : undefined;
  const rows = await db
    .select()
    .from(scanErrors)
    .where(where)
    .orderBy(desc(scanErrors.id))
    .limit(limit + 1);
  const hasNextPage = rows.length > limit;
  const page = hasNextPage ? rows.slice(0, limit) : rows;

  const [totals] = await db.select({ value: count() }).from(scanErrors);
  const totalCount = totals?.value ?? 0;

  const edges: LibraryScanErrorEdge[] = page.map((row) => ({
    node: toGqlError(row),
    cursor: row.id,
  }));
  return {
    edges,
    totalCount,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: args.after != null,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
}

/**
 * Re-attempts the file behind a recorded scan error. On success the file is parsed and its error cleared; on failure the error is refreshed with the latest attempt. Either way the client should refetch `libraryScanErrors`. No-op when the error id is unknown (already retried or dismissed).
 *
 * @gqlMutationField
 */
export async function libraryScanErrorRetry(args: { id: ID }): Promise<Void> {
  const file = await scanErrorFileById(args.id);
  if (file == null) return {};
  try {
    await upsertTrackTracked(file);
  } catch {
    // The failure is recorded back onto the error row by the scan funnel; the
    // client sees the refreshed error on its next fetch.
  }
  return {};
}

/**
 * Removes a recorded scan error from the review list without retrying its file. The file may resurface as an error if a future scan reaches it again. No-op when the error id is unknown.
 *
 * @gqlMutationField
 */
export async function libraryScanErrorDismiss(args: { id: ID }): Promise<Void> {
  await deleteScanError(args.id);
  return {};
}
