import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(tracks);
});

const TracksQuery = graphql(`
  query Tracks($first: Int, $last: Int, $after: ID, $before: ID) {
    tracks(first: $first, last: $last, after: $after, before: $before) {
      edges {
        cursor
        node {
          id
          title
          trackNumber
          discNumber
          artist
          album
          year
          format
          duration {
            seconds
            formatted
          }
          url
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      totalCount
    }
  }
`);

const TrackQuery = graphql(`
  query Track($id: ID!) {
    track(id: $id) {
      id
      title
      trackNumber
      discNumber
      artist
      album
      year
      format
      duration {
        seconds
        formatted
      }
      url
    }
  }
`);

const TrackUrlQuery = graphql(`
  query TrackUrl($id: ID!, $format: TrackFormat) {
    track(id: $id) {
      id
      url(format: $format)
    }
  }
`);

type Seed = {
  id?: string;
  artist: string | null;
  album: string | null;
  year?: string | null;
  discNumber: number | null;
  trackNumber: number | null;
  title: string;
  format: string;
  codec: string;
  durationSeconds: number;
};

async function seed(rows: Seed[]) {
  await db.insert(tracks).values(
    rows.map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      title: r.title,
      trackNumber: r.trackNumber,
      discNumber: r.discNumber,
      artist: r.artist,
      album: r.album,
      year: r.year ?? null,
      format: r.format,
      codec: r.codec,
      bitRate: null,
      sampleRate: 44_100,
      isLossless: r.format === 'flac',
      file: `/library/${r.artist ?? 'unk'}/${r.album ?? 'unk'}/${r.title}.${r.format}`,
      sizeBytes: 1024,
      durationSeconds: r.durationSeconds,
      sourceMtime: new Date(0),
    })),
  );
}

test('Query.tracks paginates forward in artist/year-desc/album/disc/track order', async () => {
  await seed([
    {
      artist: 'B',
      album: 'B1',
      year: '2050',
      discNumber: 1,
      trackNumber: 1,
      title: 'b-2050',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 100,
    },
    {
      artist: 'A',
      album: 'Zebra',
      year: '2011',
      discNumber: 1,
      trackNumber: 1,
      title: 'a-2011-zebra',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 100,
    },
    {
      artist: 'A',
      album: 'Beta',
      year: '2002',
      discNumber: 1,
      trackNumber: 1,
      title: 'a-2002-beta',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 100,
    },
    {
      artist: 'A',
      album: 'Alpha',
      year: '2002',
      discNumber: 1,
      trackNumber: 2,
      title: 'a-2002-alpha-t2',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 100,
    },
    {
      artist: 'A',
      album: 'Alpha',
      year: '2002',
      discNumber: 1,
      trackNumber: 1,
      title: 'a-2002-alpha-t1',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 100,
    },
  ]);

  // Artist outranks year (all of A precedes B's 2050), year is newest-first (2011 before 2002),
  // and album groups within a year (Alpha before Beta, both 2002) ahead of disc/track.
  const { data: first } = await gqlRequest(app)
    .query(TracksQuery)
    .variables({ first: 2, last: null, after: null, before: null })
    .expectNoErrors();
  const page1 = first.tracks!;
  expect(page1.totalCount).toBe(5);
  expect(page1.edges.map((e) => e.node.title)).toEqual(['a-2011-zebra', 'a-2002-alpha-t1']);
  expect(page1.edges.map((e) => e.cursor)).toEqual(page1.edges.map((e) => e.node.id));
  expect(page1.pageInfo.endCursor).toBe(page1.edges.at(-1)!.node.id);
  expect(page1.pageInfo.hasNextPage).toBe(true);
  expect(page1.pageInfo.hasPreviousPage).toBe(false);

  const { data: second } = await gqlRequest(app)
    .query(TracksQuery)
    .variables({ first: 2, last: null, after: page1.pageInfo.endCursor, before: null })
    .expectNoErrors();
  const page2 = second.tracks!;
  expect(page2.edges.map((e) => e.node.title)).toEqual(['a-2002-alpha-t2', 'a-2002-beta']);
  expect(page2.pageInfo.hasNextPage).toBe(true);
  expect(page2.pageInfo.hasPreviousPage).toBe(true);

  const { data: third } = await gqlRequest(app)
    .query(TracksQuery)
    .variables({ first: 2, last: null, after: page2.pageInfo.endCursor, before: null })
    .expectNoErrors();
  const page3 = third.tracks!;
  expect(page3.edges.map((e) => e.node.title)).toEqual(['b-2050']);
  expect(page3.pageInfo.hasNextPage).toBe(false);
});

test('Query.tracks orders years numerically and newest-first, not lexically', async () => {
  // Lexical text sort would give 100 < 2002 < 2011 < 99; numeric descending gives 2011, 2002, 100, 99.
  await seed(
    ['2011', '100', '2002', '99'].map((year) => ({
      artist: 'A',
      album: 'A1',
      year,
      discNumber: 1,
      trackNumber: 1,
      title: `y${year}`,
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 100,
    })),
  );

  const { data } = await gqlRequest(app)
    .query(TracksQuery)
    .variables({ first: 100, last: null, after: null, before: null })
    .expectNoErrors();
  expect(data.tracks!.edges.map((e) => e.node.title)).toEqual(['y2011', 'y2002', 'y100', 'y99']);
});

test('Query.tracks paginates backward with last/before', async () => {
  await seed([
    {
      artist: 'A',
      album: 'A1',
      discNumber: 1,
      trackNumber: 1,
      title: 't1',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 60,
    },
    {
      artist: 'A',
      album: 'A1',
      discNumber: 1,
      trackNumber: 2,
      title: 't2',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 60,
    },
    {
      artist: 'A',
      album: 'A1',
      discNumber: 1,
      trackNumber: 3,
      title: 't3',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 60,
    },
    {
      artist: 'A',
      album: 'A1',
      discNumber: 1,
      trackNumber: 4,
      title: 't4',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 60,
    },
  ]);

  const { data: tail } = await gqlRequest(app)
    .query(TracksQuery)
    .variables({ first: null, last: 2, after: null, before: null })
    .expectNoErrors();
  const last = tail.tracks!;
  expect(last.edges.map((e) => e.node.title)).toEqual(['t3', 't4']);
  expect(last.pageInfo.hasPreviousPage).toBe(true);
  expect(last.pageInfo.hasNextPage).toBe(false);

  const { data: before } = await gqlRequest(app)
    .query(TracksQuery)
    .variables({ first: null, last: 2, after: null, before: last.pageInfo.startCursor })
    .expectNoErrors();
  const prev = before.tracks!;
  expect(prev.edges.map((e) => e.node.title)).toEqual(['t1', 't2']);
});

test('Query.track returns derived format/duration and a signed url', async () => {
  const id = '01934567-89ab-7cde-8123-456789abcdef';
  await seed([
    {
      id,
      artist: 'A',
      album: 'A1',
      discNumber: 1,
      trackNumber: 1,
      title: 'only',
      format: 'ogg',
      codec: 'vorbis',
      durationSeconds: 332,
    },
  ]);

  const { data: single } = await gqlRequest(app)
    .query(TrackQuery)
    .variables({ id })
    .expectNoErrors();
  const t = single.track!;
  expect(t.format).toBe('ogg vorbis');
  expect(t.duration).toEqual({ seconds: 332, formatted: '05:32' });

  // Default url() with no format resolves this vorbis source to opus-in-mp4 at max (no opus copy
  // possible, so it transcodes) and bakes the concrete target into the path.
  expect(t.url).toMatchInlineSnapshot(
    `"/play/9190c88f0efa8d31b3086857a0c37d3bcc2215be76e637488940c86fa2a600e3/c:mp4/a:opus/q:max/01934567-89ab-7cde-8123-456789abcdef"`,
  );

  const { data: signed } = await gqlRequest(app)
    .query(TrackUrlQuery)
    .variables({ id, format: { quality: 'HIGH', lossyFormats: ['audio/mpeg'] } })
    .expectNoErrors();
  expect(signed.track!.url).toMatchInlineSnapshot(
    `"/play/1f81408837b9000aee36727a92ef4b53da39c7bddc8a2d96b9e7e281904e672c/c:mp3/a:mp3/q:h/01934567-89ab-7cde-8123-456789abcdef"`,
  );
});

test('Query.track returns null when id is unknown', async () => {
  const { data } = await gqlRequest(app)
    .query(TrackQuery)
    .variables({ id: '00000000-0000-0000-0000-000000000000' })
    .expectNoErrors();
  expect(data.track).toBeNull();
});

test('Track.url rejects quality values outside the Quality enum', async () => {
  await seed([
    {
      artist: 'A',
      album: 'A1',
      discNumber: 1,
      trackNumber: 1,
      title: 'only',
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 60,
    },
  ]);
  const { data: list } = await gqlRequest(app)
    .query(TracksQuery)
    .variables({ first: 1, last: null, after: null, before: null })
    .expectNoErrors();
  const id = list.tracks!.edges[0]!.node.id;

  const { errors } = await gqlRequest(app)
    .query(TrackUrlQuery)
    // Cast around gql.tada's literal-union typing so we can exercise the schema rejection at runtime.
    .variables({
      id,
      format: { quality: 'ULTRA' as 'LOW', lossyFormats: ['audio/mp4; codecs="opus"'] },
    })
    .expectErrors();
  expect(errors[0]?.message).toMatch(/Quality/);
});

const TracksPathQuery = graphql(`
  query TracksPath {
    tracks(first: 100) {
      edges {
        node {
          title
          path
        }
      }
    }
  }
`);

test('Query.tracks orders untagged tracks by file path and exposes Track.path', async () => {
  await db.insert(tracks).values(
    ['/library/c.mp3', '/library/a.mp3', '/library/b.mp3'].map((file) => ({
      title: null,
      trackNumber: null,
      discNumber: null,
      artist: null,
      album: null,
      year: null,
      format: 'mp3',
      codec: 'mp3',
      bitRate: null,
      sampleRate: 44_100,
      isLossless: false,
      file,
      sizeBytes: 1024,
      durationSeconds: 60,
      sourceMtime: new Date(0),
    })),
  );

  const { data } = await gqlRequest(app).query(TracksPathQuery).expectNoErrors();
  expect(data.tracks!.edges.map((e) => e.node.path)).toEqual([
    '/library/a.mp3',
    '/library/b.mp3',
    '/library/c.mp3',
  ]);
  expect(data.tracks!.edges.every((e) => e.node.title === null)).toBe(true);
});

const OffsetTracksQuery = graphql(`
  query OffsetTracks($first: Int, $offset: Int) {
    tracks(first: $first, offset: $offset) {
      totalCount
      pageInfo {
        hasNextPage
        hasPreviousPage
      }
      edges {
        node {
          artist
        }
      }
    }
  }
`);

const ArtistIndexQuery = graphql(`
  query ArtistIndex {
    artistIndex {
      label
      offset
    }
  }
`);

function seedArtists(artists: (string | null)[]) {
  return seed(
    artists.map((artist, i) => ({
      artist,
      album: 'Al',
      discNumber: 1,
      trackNumber: i + 1,
      title: `t${i}`,
      format: 'mp3',
      codec: 'mp3',
      durationSeconds: 60,
    })),
  );
}

test('Query.tracks offset returns an arbitrary window without paging through the gap', async () => {
  await seedArtists(['A', 'B', 'C', 'D', 'E']);

  const { data } = await gqlRequest(app)
    .query(OffsetTracksQuery)
    .variables({ first: 2, offset: 2 })
    .expectNoErrors();
  expect(data.tracks!.totalCount).toBe(5);
  expect(data.tracks!.edges.map((e) => e.node.artist)).toEqual(['C', 'D']);
  expect(data.tracks!.pageInfo).toEqual({ hasNextPage: true, hasPreviousPage: true });
});

test('Query.tracks sorts artists case-insensitively', async () => {
  await seedArtists(['Zebra', 'apple', 'Banana', 'aardvark']);

  const { data } = await gqlRequest(app)
    .query(OffsetTracksQuery)
    .variables({ first: 10, offset: 0 })
    .expectNoErrors();
  expect(data.tracks!.edges.map((e) => e.node.artist)).toEqual([
    'aardvark',
    'apple',
    'Banana',
    'Zebra',
  ]);
});

test('Query.artistIndex buckets by first letter with the offset each begins at', async () => {
  // The untagged track sorts first (empty effective artist) under the `#` bucket.
  await seedArtists([null, 'Alpha', 'Apex', 'Beta', 'Zeta']);

  const { data } = await gqlRequest(app).query(ArtistIndexQuery).expectNoErrors();
  expect(data.artistIndex).toEqual([
    { label: '#', offset: 0 },
    { label: 'A', offset: 1 },
    { label: 'B', offset: 3 },
    { label: 'Z', offset: 4 },
  ]);
});
