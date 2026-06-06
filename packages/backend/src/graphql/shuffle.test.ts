import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(tracks);
});

const ShuffledTracksQuery = graphql(`
  query ShuffledTracks(
    $first: Int
    $last: Int
    $after: ID
    $before: ID
    $shuffleSeed: String
    $shuffleInitialTrackId: ID
    $filterArtistIn: [String!]
  ) {
    playbackQueue {
      tracks(
        first: $first
        last: $last
        after: $after
        before: $before
        shuffleSeed: $shuffleSeed
        shuffleInitialTrackId: $shuffleInitialTrackId
        filterArtistIn: $filterArtistIn
      ) {
        totalCount
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        edges {
          cursor
          node {
            id
            title
            artist
          }
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
  shuffleSeed?: string | null;
  shuffleInitialTrackId?: string | null;
  filterArtistIn?: string[] | null;
};

async function fetchIds(vars: Vars): Promise<string[]> {
  const { data } = await gqlRequest(app)
    .query(ShuffledTracksQuery)
    .variables({
      first: null,
      last: null,
      after: null,
      before: null,
      shuffleSeed: null,
      shuffleInitialTrackId: null,
      filterArtistIn: null,
      ...vars,
    })
    .expectNoErrors();
  return data.playbackQueue!.tracks.edges.map((e) => e.node.id);
}

test('PlaybackQueue.tracks shuffleSeed orders deterministically per seed', async () => {
  await seed(10);
  const once = await fetchIds({ first: 100, shuffleSeed: 'seed-a' });
  const again = await fetchIds({ first: 100, shuffleSeed: 'seed-a' });
  const other = await fetchIds({ first: 100, shuffleSeed: 'seed-b' });
  expect(again).toEqual(once);
  expect(other).not.toEqual(once);
});

test('PlaybackQueue.tracks shuffleSeed returns a permutation of the library', async () => {
  await seed(10);
  const library = await fetchIds({ first: 100 });
  const shuffled = await fetchIds({ first: 100, shuffleSeed: 'seed-a' });
  expect(shuffled).toHaveLength(10);
  expect([...shuffled].sort()).toEqual([...library].sort());
});

test('PlaybackQueue.tracks shuffleInitialTrackId comes first and has no predecessor', async () => {
  await seed(10);
  const library = await fetchIds({ first: 100 });
  const initial = library[4]!;
  const shuffled = await fetchIds({
    first: 100,
    shuffleSeed: 'seed-a',
    shuffleInitialTrackId: initial,
  });
  expect(shuffled[0]).toBe(initial);
  const previous = await fetchIds({
    last: 1,
    before: initial,
    shuffleSeed: 'seed-a',
    shuffleInitialTrackId: initial,
  });
  expect(previous).toEqual([]);
});

test('PlaybackQueue.tracks pages and single-steps through the shuffled order consistently', async () => {
  await seed(10);
  const library = await fetchIds({ first: 100 });
  const initial = library[2]!;
  const vars = { shuffleSeed: 'seed-a', shuffleInitialTrackId: initial };
  const oneShot = await fetchIds({ first: 100, ...vars });

  const paged: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await fetchIds({ first: 3, after, ...vars });
    if (page.length === 0) break;
    paged.push(...page);
    after = page.at(-1)!;
  }
  expect(paged).toEqual(oneShot);

  const stepped: string[] = [oneShot[0]!];
  for (;;) {
    const next = await fetchIds({ first: 1, after: stepped.at(-1)!, ...vars });
    if (next.length === 0) break;
    stepped.push(next[0]!);
  }
  expect(stepped).toEqual(oneShot);
});

test('PlaybackQueue.tracks steps backward through the shuffled order', async () => {
  await seed(10);
  const library = await fetchIds({ first: 100 });
  const vars = { shuffleSeed: 'seed-a', shuffleInitialTrackId: library[0]! };
  const order = await fetchIds({ first: 100, ...vars });
  const previous = await fetchIds({ last: 1, before: order[5]!, ...vars });
  expect(previous).toEqual([order[4]!]);
});

test('PlaybackQueue.tracks shuffle composes with filters', async () => {
  await seed(10, (i) => (i < 5 ? 'A' : 'B'));
  const filtered = await fetchIds({ first: 100, filterArtistIn: ['A'] });
  const shuffled = await fetchIds({ first: 100, shuffleSeed: 'seed-a', filterArtistIn: ['A'] });
  const again = await fetchIds({ first: 100, shuffleSeed: 'seed-a', filterArtistIn: ['A'] });
  expect(shuffled).toHaveLength(5);
  expect([...shuffled].sort()).toEqual([...filtered].sort());
  expect(again).toEqual(shuffled);
});

test('PlaybackQueue.tracks rejects shuffleInitialTrackId without shuffleSeed', async () => {
  await seed(3);
  const library = await fetchIds({ first: 100 });
  const { errors } = await gqlRequest(app)
    .query(ShuffledTracksQuery)
    .variables({
      first: 100,
      last: null,
      after: null,
      before: null,
      shuffleSeed: null,
      shuffleInitialTrackId: library[0]!,
      filterArtistIn: null,
    })
    .expectErrors();
  expect(errors[0]!.message).toContain('`shuffleInitialTrackId` requires `shuffleSeed`');
});
