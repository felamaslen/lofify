import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(tracks);
});

const RepeatTracksQuery = graphql(`
  query RepeatTracks(
    $first: Int
    $last: Int
    $after: String
    $before: String
    $offset: Int
    $repeat: Boolean
    $shuffleSeed: String
    $shuffleInitialTrackId: ID
    $filterArtistIn: [String!]
  ) {
    tracks(
      first: $first
      last: $last
      after: $after
      before: $before
      offset: $offset
      repeat: $repeat
      shuffleSeed: $shuffleSeed
      shuffleInitialTrackId: $shuffleInitialTrackId
      filterArtistIn: $filterArtistIn
    ) {
      totalCount
      pageInfo {
        hasNextPage
        hasPreviousPage
      }
      edges {
        node {
          id
          title
        }
      }
    }
  }
`);

async function seed(count: number, artistFor: (i: number) => string = () => 'A'): Promise<void> {
  await db.insert(tracks).values(
    Array.from({ length: count }, (_, i) => ({
      title: `t${i}`,
      trackNumber: i + 1,
      discNumber: 1,
      artist: artistFor(i),
      album: 'Album',
      year: null,
      format: 'mp3',
      codec: 'mp3',
      bitRate: null,
      sampleRate: 44_100,
      isLossless: false,
      file: `/library/${artistFor(i)}/Album/t${i}.mp3`,
      sizeBytes: 1024,
      durationSeconds: 100,
      sourceMtime: new Date(0),
    })),
  );
}

type Vars = {
  first?: number | null;
  last?: number | null;
  after?: string | null;
  before?: string | null;
  offset?: number | null;
  repeat?: boolean | null;
  shuffleSeed?: string | null;
  shuffleInitialTrackId?: string | null;
  filterArtistIn?: string[] | null;
};

type Page = { ids: string[]; hasNextPage: boolean; hasPreviousPage: boolean };

async function fetchPage(vars: Vars): Promise<Page> {
  const { data } = await gqlRequest(app)
    .query(RepeatTracksQuery)
    .variables({
      first: null,
      last: null,
      after: null,
      before: null,
      offset: null,
      repeat: null,
      shuffleSeed: null,
      shuffleInitialTrackId: null,
      filterArtistIn: null,
      ...vars,
    })
    .expectNoErrors();
  const conn = data.tracks!;
  return {
    ids: conn.edges.map((e) => e.node.id),
    hasNextPage: conn.pageInfo.hasNextPage,
    hasPreviousPage: conn.pageInfo.hasPreviousPage,
  };
}

test('Query.tracks repeat wraps a step past the last track to the first', async () => {
  await seed(3);
  const order = (await fetchPage({ first: 100 })).ids;
  const wrapped = await fetchPage({ first: 1, after: order.at(-1)!, repeat: true });
  expect(wrapped.ids).toEqual([order[0]!]);
});

test('Query.tracks repeat fills an underfilled page from the start of the order', async () => {
  await seed(3);
  const order = (await fetchPage({ first: 100 })).ids;
  const page = await fetchPage({ first: 3, after: order[1]!, repeat: true });
  expect(page.ids).toEqual([order[2]!, order[0]!, order[1]!]);
});

test('Query.tracks repeat caps a page at one full lap with no duplicates', async () => {
  await seed(5);
  const order = (await fetchPage({ first: 100 })).ids;
  const page = await fetchPage({ first: 100, after: order[1]!, repeat: true });
  expect(page.ids).toHaveLength(5);
  expect(new Set(page.ids).size).toBe(5);
  expect(page.ids).toEqual([...order.slice(2), ...order.slice(0, 2)]);
});

test('Query.tracks repeat wraps a backward step at the first track to the last', async () => {
  await seed(3);
  const order = (await fetchPage({ first: 100 })).ids;
  const wrapped = await fetchPage({ last: 1, before: order[0]!, repeat: true });
  expect(wrapped.ids).toEqual([order.at(-1)!]);
  const two = await fetchPage({ last: 2, before: order[1]!, repeat: true });
  expect(two.ids).toEqual([order.at(-1)!, order[0]!]);
});

test('Query.tracks repeat cycles the same shuffled permutation', async () => {
  await seed(4);
  const library = (await fetchPage({ first: 100 })).ids;
  const vars = { shuffleSeed: 'seed-a', shuffleInitialTrackId: library[0]!, repeat: true };
  const order = (await fetchPage({ first: 100, ...vars })).ids;
  const stepped: string[] = [order[0]!];
  for (let i = 0; i < 8; i++) {
    const next = await fetchPage({ first: 1, after: stepped.at(-1)!, ...vars });
    stepped.push(next.ids[0]!);
  }
  expect(stepped).toEqual([...order, ...order, order[0]!]);
});

test('Query.tracks repeat reports more pages in both directions whenever tracks match', async () => {
  await seed(2);
  const order = (await fetchPage({ first: 100 })).ids;
  const page = await fetchPage({ first: 1, after: order.at(-1)!, repeat: true });
  expect(page.hasNextPage).toBe(true);
  expect(page.hasPreviousPage).toBe(true);
  const empty = await fetchPage({ first: 1, repeat: true, filterArtistIn: ['Nobody'] });
  expect(empty.ids).toEqual([]);
  expect(empty.hasNextPage).toBe(false);
  expect(empty.hasPreviousPage).toBe(false);
});

test('Query.tracks offset ignores repeat', async () => {
  await seed(3);
  const order = (await fetchPage({ first: 100 })).ids;
  const window = await fetchPage({ first: 100, offset: 2, repeat: true });
  expect(window.ids).toEqual([order[2]!]);
});

test('Query.tracks repeat on a single-track set steps back to the same track', async () => {
  await seed(1);
  const order = (await fetchPage({ first: 100 })).ids;
  const wrapped = await fetchPage({ first: 1, after: order[0]!, repeat: true });
  expect(wrapped.ids).toEqual([order[0]!]);
});
