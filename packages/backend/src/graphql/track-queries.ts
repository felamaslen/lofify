import { asc, desc, eq, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
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

/** Combine the optional artist/album filters and the duplicate filter into a single `WHERE` fragment. Matches the effective (override-aware) tag against each non-empty list; unless `includeDuplicates`, restricts to canonical rows (`priority` null or 0). Null when nothing is filtered. */
function buildFilterClause(
  filterArtistIn: string[] | null | undefined,
  filterAlbumIn: string[] | null | undefined,
  includeDuplicates: boolean,
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
  if (!includeDuplicates) {
    clauses.push(or(isNull(tracksTable.priority), eq(tracksTable.priority, 0))!);
  }
  return clauses.length > 0 ? sql.join(clauses, sql` and `) : null;
}

/** One column of the active sort order, expressed twice: `row` against the queried table and `cursor` against the cursor-lookup alias `c`, so the order-by, the row sort key, and the cursor sort-key subquery all derive from the same definition. */
type SortColumn = { row: SQL; cursor: SQL };

/** The column expressions of the active sort order, most significant first. Without a seed this is the library order (effective artist, album, disc, track, file, id). With a seed it's a deterministic pseudo-random permutation — a seeded hash of the id, with the id as tiebreaker — optionally preceded by a pin that sorts `shuffleInitialTrackId` first. */
function sortColumns(
  shuffleSeed: string | null | undefined,
  shuffleInitialTrackId: string | null | undefined,
): SortColumn[] {
  if (shuffleSeed != null) {
    const columns: SortColumn[] = [];
    if (shuffleInitialTrackId != null) {
      columns.push({
        row: ne(tracksTable.id, shuffleInitialTrackId),
        cursor: sql`(c.id != ${shuffleInitialTrackId})`,
      });
    }
    columns.push({
      row: sql`md5(${shuffleSeed} || ${tracksTable.id}::text)`,
      cursor: sql`md5(${shuffleSeed} || c.id::text)`,
    });
    columns.push({ row: sql`${tracksTable.id}`, cursor: sql`c.id` });
    return columns;
  }
  return [
    {
      row: sql`coalesce(${tracksTable.artistOverride}, ${tracksTable.artist}, '')`,
      cursor: sql`coalesce(c."artistOverride", c.artist, '')`,
    },
    {
      row: sql`coalesce(${tracksTable.albumOverride}, ${tracksTable.album}, '')`,
      cursor: sql`coalesce(c."albumOverride", c.album, '')`,
    },
    {
      row: sql`coalesce(${tracksTable.discNumberOverride}, ${tracksTable.discNumber}, 0)`,
      cursor: sql`coalesce(c."discNumberOverride", c."discNumber", 0)`,
    },
    {
      row: sql`coalesce(${tracksTable.trackNumberOverride}, ${tracksTable.trackNumber}, 0)`,
      cursor: sql`coalesce(c."trackNumberOverride", c."trackNumber", 0)`,
    },
    { row: sql`${tracksTable.file}`, cursor: sql`c.file` },
    { row: sql`${tracksTable.id}`, cursor: sql`c.id` },
  ];
}

function orderColumns(columns: SortColumn[], direction: typeof asc | typeof desc): SQL[] {
  return columns.map((c) => direction(c.row));
}

function rowSortKey(columns: SortColumn[]): SQL {
  return sql`(${sql.join(
    columns.map((c) => c.row),
    sql`, `,
  )})`;
}

function cursorSortKey(columns: SortColumn[], cursorId: string): SQL {
  return sql`(select ${sql.join(
    columns.map((c) => c.cursor),
    sql`, `,
  )} from "Tracks" c where c.id = ${cursorId})`;
}

/** The library's stable ascending sort order, used by `artistIndex` so it addresses the same row sequence as un-shuffled `tracks`. */
const ASC_ORDER = sql.join(orderColumns(sortColumns(null, null), asc), sql`, `);

async function countTracks(filterClause: SQL | null): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tracksTable)
    .where(filterClause ?? sql`true`);
  return row[0]?.count ?? 0;
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
 * Pass `offset` instead to fetch an arbitrary window (`first` rows from that zero-based index) in the same order — used for index-addressed scrolling (e.g. the letter scrubber jumping anywhere without paging through the gaps). When `offset` is set, the cursor arguments are ignored.
 *
 * Pass `shuffleSeed` to replace the library order with a deterministic pseudo-random permutation: the same seed always yields the same order, so cursor pagination and `offset` stay consistent across requests.
 *
 * Pass `repeat` to treat the active order as cyclic: a cursor page that runs past either end continues from the other end, so stepping past the last track yields the first and vice versa.
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
  /** Zero-based index of the first row to return, in the active sort order. When set, returns `first` rows from here and ignores `after`/`before`/`last`. */
  offset?: Int | null,
  /** Include every duplicate copy of a recording. By default only the canonical (highest-quality) copy of each duplicate group is returned. */
  includeDuplicates?: boolean | null,
  /** Seed for a deterministic pseudo-random ordering that replaces the library sort. The same seed always produces the same permutation. */
  shuffleSeed?: string | null,
  /** Track to place first in the shuffled order. Requires `shuffleSeed`. */
  shuffleInitialTrackId?: ID | null,
  /** Treat the active order as cyclic: a cursor page that runs past either end continues from the other end, capped at one full lap (never more rows than `totalCount`). `pageInfo` then reports more pages in both directions whenever any track matches. Ignored when `offset` is set. */
  repeat?: boolean | null,
): Promise<TrackConnection | null> {
  if (shuffleInitialTrackId != null && shuffleSeed == null) {
    throw new Error('`shuffleInitialTrackId` requires `shuffleSeed`.');
  }
  const sort = sortColumns(shuffleSeed, shuffleInitialTrackId);
  const filterClause = buildFilterClause(filterArtistIn, filterAlbumIn, includeDuplicates ?? false);

  if (offset != null) {
    const limit = clampLimit(first) ?? DEFAULT_PAGE_SIZE;
    const off = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const rows = await db
      .select()
      .from(tracksTable)
      .where(filterClause ?? sql`true`)
      .orderBy(...orderColumns(sort, asc))
      .limit(limit)
      .offset(off);
    const edges: TrackEdge[] = rows.map((row) => ({ node: toGqlTrack(row), cursor: row.id }));
    const totalCount = await countTracks(filterClause);
    return {
      edges,
      pageInfo: {
        hasNextPage: off + rows.length < totalCount,
        hasPreviousPage: off > 0,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges.at(-1)?.cursor ?? null,
      },
      totalCount,
    };
  }

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

  const cursorWhere = cursorId
    ? isBackward
      ? sql`${rowSortKey(sort)} < ${cursorSortKey(sort, cursorId)}`
      : sql`${rowSortKey(sort)} > ${cursorSortKey(sort, cursorId)}`
    : undefined;
  const conditions = [cursorWhere, filterClause].filter((c): c is SQL => c != null);
  const where = conditions.length > 0 ? sql.join(conditions, sql` and `) : sql`true`;

  const rows = await db
    .select()
    .from(tracksTable)
    .where(where)
    .orderBy(...orderColumns(sort, isBackward ? desc : asc))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  let ordered = isBackward ? slice.slice().reverse() : slice;

  const totalCount = await countTracks(filterClause);

  if (repeat) {
    // Wrap-fill an underfilled page from the order's other end, capped at one full lap so the
    // wrap can never duplicate a row already on the page (the wrap rows all sort at or before the
    // cursor, which the lap cap keeps disjoint from the post-cursor slice).
    const need = Math.min(limit, totalCount) - ordered.length;
    if (need > 0) {
      const wrap = await db
        .select()
        .from(tracksTable)
        .where(filterClause ?? sql`true`)
        .orderBy(...orderColumns(sort, isBackward ? desc : asc))
        .limit(need);
      ordered = isBackward ? [...wrap.reverse(), ...ordered] : [...ordered, ...wrap];
    }
  }

  const edges: TrackEdge[] = ordered.map((row) => ({
    node: toGqlTrack(row),
    cursor: row.id,
  }));

  // A cyclic order has more pages in both directions as long as anything matches.
  const cycles = repeat === true && totalCount > 0;

  return {
    edges,
    pageInfo: {
      hasNextPage: cycles || (isBackward ? cursorId != null : hasMore),
      hasPreviousPage: cycles || (isBackward ? hasMore : cursorId != null),
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
    totalCount,
  };
}

/**
 * Where a first-letter bucket begins in the `tracks` ordering.
 *
 * @gqlType
 */
export type ArtistInitial = {
  /** Upper-case first letter of the effective artist, or `#` for anything non-alphabetic (digits, symbols, non-Latin scripts, untagged). @gqlField */
  label: string;
  /** Zero-based index of the bucket's first track within the full `tracks` order, suitable as the `offset` to jump there. @gqlField */
  offset: Int;
};

/**
 * The first-letter buckets present in the library, in `tracks` order, each with the index where it starts. Powers an A–Z scrubber: map a scroll position to its bucket, or jump to a letter by feeding its `offset` to `Query.tracks`. Honours the same `filterArtistIn`/`filterAlbumIn` as `tracks`.
 *
 * @gqlQueryField
 */
export async function artistIndex(
  filterArtistIn?: string[] | null,
  filterAlbumIn?: string[] | null,
  /** Include every duplicate copy of a recording. By default only the canonical copy of each duplicate group is counted, matching `Query.tracks`. */
  includeDuplicates?: boolean | null,
): Promise<ArtistInitial[] | null> {
  const filterClause = buildFilterClause(filterArtistIn, filterAlbumIn, includeDuplicates ?? false);
  const effectiveArtist = sql`coalesce(${tracksTable.artistOverride}, ${tracksTable.artist}, '')`;
  const bucket = sql`case when ${effectiveArtist} ~ '^[A-Za-z]' then upper(left(${effectiveArtist}, 1)) else '#' end`;
  const result = await db.execute<{ label: string; offset: number }>(sql`
    select bucket as label, (min(rn) - 1)::int as "offset"
    from (
      select ${bucket} as bucket, row_number() over (order by ${ASC_ORDER}) as rn
      from ${tracksTable}
      ${filterClause ? sql`where ${filterClause}` : sql``}
    ) t
    group by bucket
    order by min(rn)
  `);
  return result.rows.map((r) => ({ label: r.label, offset: Number(r.offset) }));
}
