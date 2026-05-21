import { sql } from 'drizzle-orm';
import type { ID, Int } from 'grats';
import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { toGqlTrack, type Track } from './track.js';

/**
 * One page of a Relay-style traversal over the track library.
 *
 * @gqlType
 */
export type TrackConnection = {
  /** @gqlField */
  edges: TrackEdge[];
  /** @gqlField */
  pageInfo: PageInfo;
  /** Total number of tracks in the library, ignoring pagination arguments. @gqlField */
  totalCount: Int;
};

/**
 * A single entry in a `TrackConnection`.
 *
 * @gqlType
 */
export type TrackEdge = {
  /** @gqlField */
  node: Track;
  /** Cursor for paginating relative to this edge; equal to the track's `id`. @gqlField */
  cursor: ID;
};

/**
 * Boundary metadata for a `TrackConnection`.
 *
 * @gqlType
 */
export type PageInfo = {
  /** True when more tracks exist after the current page in the sort order. @gqlField */
  hasNextPage: boolean;
  /** True when more tracks exist before the current page in the sort order. @gqlField */
  hasPreviousPage: boolean;
  /** Cursor of the first edge on the current page, or `null` for an empty page. @gqlField */
  startCursor: ID | null;
  /** Cursor of the last edge on the current page, or `null` for an empty page. @gqlField */
  endCursor: ID | null;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function clampLimit(value: Int | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_PAGE_SIZE, Math.floor(value));
}

/**
 * Look up a single track by id. Returns `null` when no track with that id exists.
 *
 * @gqlQueryField
 */
export async function track(id: ID): Promise<Track | null> {
  const rows = await db
    .select()
    .from(tracksTable)
    .where(sql`${tracksTable.id} = ${id}`)
    .limit(1);
  const row = rows[0];
  return row ? toGqlTrack(row) : null;
}

/**
 * List the library in Relay-cursor pagination order: by `artist`, `album`, `discNumber`, `trackNumber`, then `id` for stability. Supply exactly one of `first`/`last` and at most one of `after`/`before`.
 *
 * @gqlQueryField
 */
export async function tracks(
  first?: Int | null,
  last?: Int | null,
  after?: string | null,
  before?: string | null,
): Promise<TrackConnection | null> {
  if (first != null && last != null) {
    throw new Error('Pass either `first` or `last`, not both.');
  }
  const isBackward = last != null;
  const limit =
    clampLimit(isBackward ? last : first) ?? DEFAULT_PAGE_SIZE;

  const cursorId = isBackward ? before : after;
  if (cursorId) {
    const exists = await db
      .select({ id: tracksTable.id })
      .from(tracksTable)
      .where(sql`${tracksTable.id} = ${cursorId}`)
      .limit(1);
    if (exists.length === 0) {
      throw new Error('Unknown cursor.');
    }
  }

  const sortKey = sql`(coalesce(${tracksTable.artist}, ''), coalesce(${tracksTable.album}, ''), coalesce(${tracksTable.discNumber}, 0), coalesce(${tracksTable.trackNumber}, 0), ${tracksTable.id})`;
  const cursorSortKey = sql`(select coalesce(c.artist, ''), coalesce(c.album, ''), coalesce(c."discNumber", 0), coalesce(c."trackNumber", 0), c.id from "Tracks" c where c.id = ${cursorId})`;

  const where = cursorId
    ? isBackward
      ? sql`${sortKey} < ${cursorSortKey}`
      : sql`${sortKey} > ${cursorSortKey}`
    : undefined;

  const direction = isBackward ? sql`desc` : sql`asc`;
  const orderBy = sql`coalesce(${tracksTable.artist}, '') ${direction}, coalesce(${tracksTable.album}, '') ${direction}, coalesce(${tracksTable.discNumber}, 0) ${direction}, coalesce(${tracksTable.trackNumber}, 0) ${direction}, ${tracksTable.id} ${direction}`;

  const rows = await db
    .select()
    .from(tracksTable)
    .where(where ?? sql`true`)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const ordered = isBackward ? slice.slice().reverse() : slice;

  const edges: TrackEdge[] = ordered.map((row) => ({
    node: toGqlTrack(row),
    cursor: row.id,
  }));

  const totalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tracksTable);
  const totalCount = totalRow[0]?.count ?? 0;

  return {
    edges,
    pageInfo: {
      hasNextPage: isBackward ? cursorId != null : hasMore,
      hasPreviousPage: isBackward ? hasMore : cursorId != null,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
    totalCount,
  };
}
