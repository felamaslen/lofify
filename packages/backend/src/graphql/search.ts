import { inArray, sql } from 'drizzle-orm';
import type { Int } from 'grats';

import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { toGqlTrack } from './track.js';
import type { TrackConnection, TrackEdge } from './track-queries.js';

/** Most matches of each kind returned for a single search; the UI shows a top-N dropdown rather than paginating. */
const SEARCH_LIMIT = 20;

/** Turn a user's raw query into a case-insensitive prefix `ILIKE` pattern (matches the start of the string), escaping the wildcard metacharacters so a literal `%` or `_` matches itself. */
function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `${escaped}%`;
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
  constructor(private readonly pattern: string) {}

  /** Distinct artists whose name matches the query. @gqlField */
  async artists(): Promise<ArtistConnection> {
    const match = sql`${artistName} ilike ${this.pattern} escape '\\'`;
    const rows = await db
      .selectDistinct({ name: artistName })
      .from(tracksTable)
      .where(match)
      .orderBy(artistName)
      .limit(SEARCH_LIMIT);
    const totalRow = await db
      .select({ count: sql<number>`count(distinct ${artistName})::int` })
      .from(tracksTable)
      .where(match);
    return {
      edges: rows.map((r) => ({ node: { name: r.name as string }, cursor: r.name as string })),
      totalCount: totalRow[0]?.count ?? 0,
    };
  }

  /** Distinct albums whose title matches the query, each carrying its credited artists. @gqlField */
  async albums(): Promise<AlbumConnection> {
    const match = sql`${albumName} ilike ${this.pattern} escape '\\'`;
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
    const match = sql`${title} ilike ${this.pattern} escape '\\'`;
    const rows = await db
      .select()
      .from(tracksTable)
      .where(match)
      .orderBy(title, tracksTable.file)
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
}

/**
 * Search the library for artists, albums and tracks whose name matches `query` as a case-insensitive prefix. Returns `null` for a blank query.
 *
 * @gqlQueryField
 */
export async function search(query: string): Promise<Search | null> {
  const trimmed = query.trim();
  if (trimmed === '') return null;
  return new Search(likePattern(trimmed));
}
