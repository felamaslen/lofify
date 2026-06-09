import { ilike, inArray, type SQL, sql } from 'drizzle-orm';
import type { ID, Int } from 'grats';

import { db } from '../db/client.js';
import {
  artistSynonyms as artistSynonymsTable,
  tracks as tracksTable,
} from '../db/schema/index.js';
import { toGqlTrack } from './track.js';
import { clampLimit, type TrackConnection, type TrackEdge } from './track-queries.js';

/** Most matches of each kind returned for a single search; the name groups show a top-N dropdown rather than paginating. */
const SEARCH_LIMIT = 20;

/** Default page size for the paginated filename group; smaller than `SEARCH_LIMIT` because a substring path match can be broad. */
const FILENAME_PAGE_SIZE = 10;

/** Escape the `ILIKE` wildcard metacharacters in a raw query so a literal `%` or `_` matches itself. */
function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** A case-insensitive prefix `ILIKE` pattern (matches the start of the string). */
function likePattern(query: string): string {
  return `${escapeLike(query)}%`;
}

/** A case-insensitive substring `ILIKE` pattern (matches anywhere), for fields where anchoring to the start is too strict — e.g. a file path the user only remembers a fragment of. */
function containsPattern(query: string): string {
  return `%${escapeLike(query)}%`;
}

/** The effective (override-aware) artist of a track. */
const artistName = sql`coalesce(${tracksTable.artistOverride}, ${tracksTable.artist})`;
/** The effective (override-aware) album of a track. */
const albumName = sql`coalesce(${tracksTable.albumOverride}, ${tracksTable.album})`;

/**
 * A distinct artist in the library.
 *
 * @gqlType
 */
export type Artist = {
  /** The artist's name, suitable to pass back as `Query.tracks(filterArtistIn:)`. @gqlField */
  name: string;
};

/**
 * An edge in an `ArtistConnection`.
 *
 * @gqlType
 */
export type ArtistEdge = {
  /** @gqlField */
  node: Artist;
  /** Opaque cursor for this edge; equal to the artist's name. @gqlField */
  cursor: string;
};

/**
 * Artists matching a search.
 *
 * @gqlType
 */
export type ArtistConnection = {
  /** @gqlField */
  edges: ArtistEdge[];
  /** Total distinct artists matching the search, ignoring the result cap. @gqlField */
  totalCount: Int;
};

/**
 * A distinct album in the library.
 *
 * @gqlType
 */
export type Album = {
  /** The album's title, suitable to pass back as `Query.tracks(filterAlbumIn:)`. @gqlField */
  name: string;
  /** Every artist credited on a track of this album. @gqlField */
  artists: Artist[];
};

/**
 * An edge in an `AlbumConnection`.
 *
 * @gqlType
 */
export type AlbumEdge = {
  /** @gqlField */
  node: Album;
  /** Opaque cursor for this edge; equal to the album's title. @gqlField */
  cursor: string;
};

/**
 * Albums matching a search.
 *
 * @gqlType
 */
export type AlbumConnection = {
  /** @gqlField */
  edges: AlbumEdge[];
  /** Total distinct albums matching the search, ignoring the result cap. @gqlField */
  totalCount: Int;
};

/**
 * Results of a library search, grouped by the kind of thing matched. Each group is resolved independently, so a client may select only the kinds it intends to render.
 *
 * @gqlType
 */
export class Search {
  /** Prefix pattern, for name matches (artist/album/title). */
  private readonly pattern: string;
  /** Substring pattern, for file-path matches. */
  private readonly filenamePattern: string;

  constructor(query: string) {
    this.pattern = likePattern(query);
    this.filenamePattern = containsPattern(query);
  }

  /** Distinct artists whose name — or one of their registered synonyms — matches the query. A synonym match contributes its canonical artist, so the result is always a real artist name (never a synonym), suitable for `filterArtistIn`. @gqlField */
  async artists(): Promise<ArtistConnection> {
    const directMatch = ilike(artistName, this.pattern);
    const synonymMatch = ilike(artistSynonymsTable.synonym, this.pattern);
    // `union` dedupes, so an artist matched both directly and via a synonym appears once.
    const matches = sql`
      select distinct ${artistName} as name from ${tracksTable} where ${directMatch}
      union
      select distinct ${artistSynonymsTable.artist} as name from ${artistSynonymsTable} where ${synonymMatch}
    `;
    const page = await db.execute<{ name: string }>(
      sql`${matches} order by name limit ${SEARCH_LIMIT}`,
    );
    const total = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from (${matches}) as u`,
    );
    return {
      edges: page.rows.map((r) => ({ node: { name: r.name }, cursor: r.name })),
      totalCount: total.rows[0]?.count ?? 0,
    };
  }

  /** Distinct albums whose title matches the query, each carrying its credited artists. @gqlField */
  async albums(): Promise<AlbumConnection> {
    const match = ilike(albumName, this.pattern);
    const nameRows = await db
      .selectDistinct({ name: albumName })
      .from(tracksTable)
      .where(match)
      .orderBy(albumName)
      .limit(SEARCH_LIMIT);
    const names = nameRows.map((r) => r.name as string);

    const pairs =
      names.length === 0
        ? []
        : await db
            .selectDistinct({ name: albumName, artist: artistName })
            .from(tracksTable)
            .where(inArray(albumName, names))
            .orderBy(albumName, artistName);
    const artistsByAlbum = new Map<string, Artist[]>();
    for (const p of pairs) {
      if (p.artist == null) continue;
      const list = artistsByAlbum.get(p.name as string) ?? [];
      list.push({ name: p.artist as string });
      artistsByAlbum.set(p.name as string, list);
    }

    const totalRow = await db
      .select({ count: sql<number>`count(distinct ${albumName})::int` })
      .from(tracksTable)
      .where(match);
    return {
      edges: names.map((name) => ({
        node: { name, artists: artistsByAlbum.get(name) ?? [] },
        cursor: name,
      })),
      totalCount: totalRow[0]?.count ?? 0,
    };
  }

  /** Tracks whose title matches the query, in library order. @gqlField */
  async tracks(): Promise<TrackConnection> {
    const title = sql`coalesce(${tracksTable.titleOverride}, ${tracksTable.title})`;
    const match = ilike(title, this.pattern);
    return trackConnection(match, [title, sql`${tracksTable.file}`]);
  }

  /** Tracks whose file path contains the query, matched as a substring rather than a prefix, ordered by path. Surfaces recordings whose tags are missing or wrong but whose filename carries the query. Paginated (default page size 10), since a substring path match can be broad. @gqlField */
  async tracksByFilename(
    /** Maximum number of rows to return. Defaults to 10. */
    first?: Int | null,
    /** Continue after this cursor — a track `id` from a previous page's edge. */
    after?: ID | null,
  ): Promise<TrackConnection> {
    const limit = clampLimit(first) ?? FILENAME_PAGE_SIZE;
    const match = ilike(tracksTable.file, this.filenamePattern);
    // `file` is unique, so a single-column keyset on it is a total order.
    const keyset =
      after != null
        ? sql`${tracksTable.file} > (select c.file from ${tracksTable} c where c.id = ${after})`
        : null;
    const where = keyset ? sql`${match} and ${keyset}` : match;
    const rows = await db
      .select()
      .from(tracksTable)
      .where(where)
      .orderBy(tracksTable.file)
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const edges: TrackEdge[] = slice.map((row) => ({ node: toGqlTrack(row), cursor: row.id }));
    const totalRow = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tracksTable)
      .where(match);
    return {
      edges,
      pageInfo: {
        hasNextPage: hasMore,
        hasPreviousPage: after != null,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges.at(-1)?.cursor ?? null,
      },
      totalCount: totalRow[0]?.count ?? 0,
    };
  }
}

/** Build a capped `TrackConnection` of the tracks satisfying `match`, ordered by `orderBy`. Backs the title group: a top-N slice, not a paginated page. */
async function trackConnection(match: SQL, orderBy: SQL[]): Promise<TrackConnection> {
  const rows = await db
    .select()
    .from(tracksTable)
    .where(match)
    .orderBy(...orderBy)
    .limit(SEARCH_LIMIT + 1);
  const hasMore = rows.length > SEARCH_LIMIT;
  const slice = hasMore ? rows.slice(0, SEARCH_LIMIT) : rows;
  const edges: TrackEdge[] = slice.map((row) => ({ node: toGqlTrack(row), cursor: row.id }));
  const totalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tracksTable)
    .where(match);
  return {
    edges,
    pageInfo: {
      hasNextPage: hasMore,
      hasPreviousPage: false,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
    totalCount: totalRow[0]?.count ?? 0,
  };
}

/**
 * Search the library for artists, albums and tracks whose name matches `query` as a case-insensitive prefix, plus tracks whose file path contains `query` as a substring. Returns `null` for a blank query.
 *
 * @gqlQueryField
 */
export async function search(query: string): Promise<Search | null> {
  const trimmed = query.trim();
  if (trimmed === '') return null;
  return new Search(trimmed);
}
