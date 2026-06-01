import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(tracks);
});

const SearchQuery = graphql(`
  query Search($query: String!) {
    search(query: $query) {
      artists {
        totalCount
        edges {
          cursor
          node {
            name
          }
        }
      }
      albums {
        totalCount
        edges {
          node {
            name
            artists {
              name
            }
          }
        }
      }
      tracks {
        totalCount
        edges {
          node {
            title
            artist
          }
        }
      }
    }
  }
`);

const FilteredTracksQuery = graphql(`
  query FilteredTracks($filterArtistIn: [String!], $filterAlbumIn: [String!]) {
    tracks(first: 100, filterArtistIn: $filterArtistIn, filterAlbumIn: $filterAlbumIn) {
      totalCount
      edges {
        node {
          id
          title
          artist
          album
        }
      }
    }
  }
`);

const NextFilteredTrackQuery = graphql(`
  query NextFilteredTrack($after: String!, $filterArtistIn: [String!]) {
    tracks(first: 1, after: $after, filterArtistIn: $filterArtistIn) {
      edges {
        node {
          artist
        }
      }
    }
  }
`);

type Seed = {
  artist: string | null;
  album: string | null;
  title: string;
  artistOverride?: string | null;
};

async function seed(rows: Seed[]) {
  await db.insert(tracks).values(
    rows.map((r, i) => ({
      title: r.title,
      trackNumber: i + 1,
      discNumber: 1,
      artist: r.artist,
      album: r.album,
      year: null,
      artistOverride: r.artistOverride ?? null,
      format: 'mp3',
      codec: 'mp3',
      bitRate: null,
      sampleRate: 44_100,
      isLossless: false,
      file: `/library/${r.artist ?? 'unk'}/${r.album ?? 'unk'}/${r.title}.mp3`,
      sizeBytes: 1024,
      durationSeconds: 60,
      sourceMtime: new Date(0),
    })),
  );
}

test('Query.search matches artists, albums and tracks case-insensitively', async () => {
  await seed([
    { artist: 'Daft Punk', album: 'Discovery', title: 'One More Time' },
    { artist: 'Daft Punk', album: 'Discovery', title: 'Aerodynamic' },
    { artist: 'Daft Punk', album: 'Homework', title: 'Da Funk' },
    { artist: 'Justice', album: 'Cross', title: 'Genesis' },
  ]);

  const { data } = await gqlRequest(app)
    .query(SearchQuery)
    .variables({ query: 'da' })
    .expectNoErrors();
  const s = data.search!;

  // "da" prefixes the artist Daft Punk once (distinct), and the title "Da Funk".
  expect(s.artists.totalCount).toBe(1);
  expect(s.artists.edges.map((e) => e.node.name)).toEqual(['Daft Punk']);
  expect(s.artists.edges.map((e) => e.cursor)).toEqual(['Daft Punk']);
  expect(s.tracks.totalCount).toBe(1);
  expect(s.tracks.edges.map((e) => e.node.title)).toEqual(['Da Funk']);
  // No album title starts with "da".
  expect(s.albums.totalCount).toBe(0);
});

test('Query.search matches only the beginning of the string, not a mid-string substring', async () => {
  await seed([
    { artist: 'Maki Asakawa', album: 'Blue', title: 'Konna Fuu ni Sugite Iku no Nara' },
    { artist: 'Yamaki', album: 'Other', title: 'Whatever' },
  ]);

  const { data } = await gqlRequest(app)
    .query(SearchQuery)
    .variables({ query: 'mak' })
    .expectNoErrors();
  expect(data.search!.artists.edges.map((e) => e.node.name)).toEqual(['Maki Asakawa']);
});

test('Query.search returns distinct albums paired with their artist', async () => {
  await seed([
    { artist: 'Daft Punk', album: 'Discovery', title: 'One More Time' },
    { artist: 'Daft Punk', album: 'Discovery', title: 'Aerodynamic' },
    { artist: 'Justice', album: 'Discovery EP', title: 'Phantom' },
  ]);

  const { data } = await gqlRequest(app)
    .query(SearchQuery)
    .variables({ query: 'discovery' })
    .expectNoErrors();
  const albums = data.search!.albums;
  expect(albums.totalCount).toBe(2);
  expect(albums.edges.map((e) => e.node)).toEqual([
    { name: 'Discovery', artists: [{ name: 'Daft Punk' }] },
    { name: 'Discovery EP', artists: [{ name: 'Justice' }] },
  ]);
});

test('Query.search returns every credited artist on an album', async () => {
  await seed([
    { artist: 'Bibio', album: 'Split Single', title: 'Side A' },
    { artist: 'Boards of Canada', album: 'Split Single', title: 'Side B' },
  ]);

  const { data } = await gqlRequest(app)
    .query(SearchQuery)
    .variables({ query: 'split' })
    .expectNoErrors();
  const album = data.search!.albums.edges[0]!.node;
  expect(album.name).toBe('Split Single');
  expect(album.artists.map((a) => a.name)).toEqual(['Bibio', 'Boards of Canada']);
});

test('Query.search matches the effective artist, not the scanned tag, when overridden', async () => {
  await seed([{ artist: 'Wrong Name', artistOverride: 'Aphex Twin', album: 'SAW', title: 'Xtal' }]);

  const { data } = await gqlRequest(app)
    .query(SearchQuery)
    .variables({ query: 'aphex' })
    .expectNoErrors();
  expect(data.search!.artists.edges.map((e) => e.node.name)).toEqual(['Aphex Twin']);

  const { data: wrong } = await gqlRequest(app)
    .query(SearchQuery)
    .variables({ query: 'wrong' })
    .expectNoErrors();
  expect(wrong.search!.artists.totalCount).toBe(0);
});

test('Query.search returns null for a blank query', async () => {
  await seed([{ artist: 'A', album: 'B', title: 'C' }]);
  const { data } = await gqlRequest(app)
    .query(SearchQuery)
    .variables({ query: '   ' })
    .expectNoErrors();
  expect(data.search).toBeNull();
});

test('Query.tracks filterArtistIn restricts results and totalCount', async () => {
  await seed([
    { artist: 'Daft Punk', album: 'Discovery', title: 'One More Time' },
    { artist: 'Daft Punk', album: 'Homework', title: 'Da Funk' },
    { artist: 'Justice', album: 'Cross', title: 'Genesis' },
  ]);

  const { data } = await gqlRequest(app)
    .query(FilteredTracksQuery)
    .variables({ filterArtistIn: ['Daft Punk'], filterAlbumIn: null })
    .expectNoErrors();
  expect(data.tracks!.totalCount).toBe(2);
  expect(data.tracks!.edges.map((e) => e.node.artist)).toEqual(['Daft Punk', 'Daft Punk']);
});

test('Query.tracks filterAlbumIn restricts results', async () => {
  await seed([
    { artist: 'Daft Punk', album: 'Discovery', title: 'One More Time' },
    { artist: 'Daft Punk', album: 'Discovery', title: 'Aerodynamic' },
    { artist: 'Daft Punk', album: 'Homework', title: 'Da Funk' },
  ]);

  const { data } = await gqlRequest(app)
    .query(FilteredTracksQuery)
    .variables({ filterArtistIn: null, filterAlbumIn: ['Discovery'] })
    .expectNoErrors();
  expect(data.tracks!.totalCount).toBe(2);
  expect(data.tracks!.edges.map((e) => e.node.title)).toEqual(['One More Time', 'Aerodynamic']);
});

test('Query.tracks paging after a cursor outside the filter returns the next matching track', async () => {
  // Sort order is by effective artist, so Alpha < Bravo < Charlie. We page from
  // the Bravo track — which is excluded by the filter — and expect the next
  // filtered track *after its sort position* (Charlie, not the earlier Alpha).
  await seed([
    { artist: 'Alpha', album: 'X', title: 'a-song' },
    { artist: 'Bravo', album: 'X', title: 'b-song' },
    { artist: 'Charlie', album: 'X', title: 'c-song' },
  ]);

  const { data: all } = await gqlRequest(app)
    .query(FilteredTracksQuery)
    .variables({ filterArtistIn: null, filterAlbumIn: null })
    .expectNoErrors();
  const bravoId = all.tracks!.edges.find((e) => e.node.artist === 'Bravo')!.node.id;

  const { data } = await gqlRequest(app)
    .query(NextFilteredTrackQuery)
    .variables({ after: bravoId, filterArtistIn: ['Alpha', 'Charlie'] })
    .expectNoErrors();
  expect(data.tracks!.edges.map((e) => e.node.artist)).toEqual(['Charlie']);
});
