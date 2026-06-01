import { inArray, type SQL, sql } from 'drizzle-orm';
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
  /** Total number of tracks matching the active filters, ignoring pagination arguments. @gqlField */
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

/** Combine the optional artist/album filters into a single `WHERE` fragment, matching the effective (override-aware) tag against each non-empty list. Null when no filter is active. */
function buildFilterClause(
  filterArtistIn: string[] | null | undefined,
  filterAlbumIn: string[] | null | undefined,
): SQL | null {
  const clauses: SQL[] = [];
  if (filterArtistIn && filterArtistIn.length > 0) {
    clauses.push(
      inArray(sql`coalesce(${tracksTable.artistOverride}, ${tracksTable.artist})`, filterArtistIn),
    );
  }
  if (filterAlbumIn && filterAlbumIn.length > 0) {
    clauses.push(
      inArray(sql`coalesce(${tracksTable.albumOverride}, ${tracksTable.album})`, filterAlbumIn),
    );
  }
  return clauses.length > 0 ? sql.join(clauses, sql` and `) : null;
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
  /** Restrict the result to tracks whose effective artist is one of these names. Pass the names returned by `Query.search` (not synonyms); an empty or omitted list applies no filter. */
  filterArtistIn?: string[] | null,
  /** Restrict the result to tracks whose effective album is one of these names. An empty or omitted list applies no filter. */
  filterAlbumIn?: string[] | null,
): Promise<TrackConnection | null> {
  if (first != null && last != null) {
    throw new Error('Pass either `first` or `last`, not both.');
  }
  const isBackward = last != null;
  const limit = clampLimit(isBackward ? last : first) ?? DEFAULT_PAGE_SIZE;

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

  const sortKey = sql`(coalesce(${tracksTable.artistOverride}, ${tracksTable.artist}, ''), coalesce(${tracksTable.albumOverride}, ${tracksTable.album}, ''), coalesce(${tracksTable.discNumberOverride}, ${tracksTable.discNumber}, 0), coalesce(${tracksTable.trackNumberOverride}, ${tracksTable.trackNumber}, 0), ${tracksTable.file}, ${tracksTable.id})`;
  const cursorSortKey = sql`(select coalesce(c."artistOverride", c.artist, ''), coalesce(c."albumOverride", c.album, ''), coalesce(c."discNumberOverride", c."discNumber", 0), coalesce(c."trackNumberOverride", c."trackNumber", 0), c.file, c.id from "Tracks" c where c.id = ${cursorId})`;

  const filterClause = buildFilterClause(filterArtistIn, filterAlbumIn);
  const cursorWhere = cursorId
    ? isBackward
      ? sql`${sortKey} < ${cursorSortKey}`
      : sql`${sortKey} > ${cursorSortKey}`
    : undefined;
  const conditions = [cursorWhere, filterClause].filter((c): c is SQL => c != null);
  const where = conditions.length > 0 ? sql.join(conditions, sql` and `) : sql`true`;

  const direction = isBackward ? sql`desc` : sql`asc`;
  const orderBy = sql`coalesce(${tracksTable.artistOverride}, ${tracksTable.artist}, '') ${direction}, coalesce(${tracksTable.albumOverride}, ${tracksTable.album}, '') ${direction}, coalesce(${tracksTable.discNumberOverride}, ${tracksTable.discNumber}, 0) ${direction}, coalesce(${tracksTable.trackNumberOverride}, ${tracksTable.trackNumber}, 0) ${direction}, ${tracksTable.file} ${direction}, ${tracksTable.id} ${direction}`;

  const rows = await db
    .select()
    .from(tracksTable)
    .where(where)
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
    .from(tracksTable)
    .where(filterClause ?? sql`true`);
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
