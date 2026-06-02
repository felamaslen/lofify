import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(tracks);
});

type Seed = {
  title: string | null;
  artist: string;
  album: string;
  codec: string;
  isLossless: boolean;
  bitRate: number | null;
  bitDepth: number | null;
};

async function seed(rows: Seed[]) {
  await db.insert(tracks).values(
    rows.map((r, i) => ({
      title: r.title,
      trackNumber: null,
      discNumber: null,
      artist: r.artist,
      album: r.album,
      year: null,
      format: r.codec,
      codec: r.codec,
      bitRate: r.bitRate,
      sampleRate: 44_100,
      bitDepth: r.bitDepth,
      channels: 2,
      isLossless: r.isLossless,
      file: `/library/${r.artist}/${r.album}/${r.title ?? 'untitled'}-${i}.${r.codec}`,
      sizeBytes: 1_000_000,
      durationSeconds: 200,
      sourceMtime: new Date(0),
    })),
  );
}

const TracksQuery = graphql(`
  query Tracks($includeDuplicates: Boolean) {
    tracks(first: 100, includeDuplicates: $includeDuplicates) {
      totalCount
      edges {
        node {
          id
          title
          sourceFormat
          bitrateKbps
          duplicates {
            sourceFormat
            bitrateKbps
          }
        }
      }
    }
  }
`);

/** Set the album override to its current value, a no-op edit that triggers a dedup recompute of the group. */
const RegroupMutation = graphql(`
  mutation Regroup($id: ID!, $album: String) {
    trackUpdate(id: $id, album: $album) {
      id
    }
  }
`);

const RetitleMutation = graphql(`
  mutation Retitle($id: ID!, $title: String) {
    trackUpdate(id: $id, title: $title) {
      id
    }
  }
`);

async function tracksList(includeDuplicates?: boolean) {
  const { data } = await gqlRequest(app)
    .query(TracksQuery)
    .variables({ includeDuplicates: includeDuplicates ?? null })
    .expectNoErrors();
  return data.tracks!;
}

test('a tag edit groups identical recordings, keeping the lossless copy canonical', async () => {
  await seed([
    {
      title: 'Song',
      artist: 'Art',
      album: 'Alb',
      codec: 'vorbis',
      isLossless: false,
      bitRate: 192_000,
      bitDepth: null,
    },
    {
      title: 'Song',
      artist: 'Art',
      album: 'Alb',
      codec: 'flac',
      isLossless: true,
      bitRate: 900_000,
      bitDepth: 16,
    },
  ]);
  const before = await tracksList();
  // No recompute has run yet: both copies are visible.
  expect(before.totalCount).toBe(2);

  await gqlRequest(app)
    .mutate(RegroupMutation)
    .variables({ id: before.edges[0]!.node.id, album: 'Alb' })
    .expectNoErrors();

  const visible = await tracksList();
  expect(visible.totalCount).toBe(1);
  const canonical = visible.edges[0]!.node;
  expect(canonical.sourceFormat).toBe('flac');
  expect(canonical.duplicates.map((d) => d.sourceFormat)).toEqual(['vorbis']);

  const all = await tracksList(true);
  expect(all.totalCount).toBe(2);
});

test('the higher-bitrate copy wins canonical among same-codec lossy sources', async () => {
  await seed([
    {
      title: 'Song',
      artist: 'Art',
      album: 'Alb',
      codec: 'mp3',
      isLossless: false,
      bitRate: 96_000,
      bitDepth: null,
    },
    {
      title: 'Song',
      artist: 'Art',
      album: 'Alb',
      codec: 'mp3',
      isLossless: false,
      bitRate: 320_000,
      bitDepth: null,
    },
  ]);
  const seeded = await tracksList(true);
  await gqlRequest(app)
    .mutate(RegroupMutation)
    .variables({ id: seeded.edges[0]!.node.id, album: 'Alb' })
    .expectNoErrors();

  const visible = await tracksList();
  expect(visible.totalCount).toBe(1);
  expect(visible.edges[0]!.node.bitrateKbps).toBe(320);
});

test('matching is case-insensitive and trimmed', async () => {
  await seed([
    {
      title: 'The Song',
      artist: 'X',
      album: 'Y',
      codec: 'flac',
      isLossless: true,
      bitRate: 900_000,
      bitDepth: 16,
    },
    {
      title: 'the song ',
      artist: 'x',
      album: 'y',
      codec: 'mp3',
      isLossless: false,
      bitRate: 256_000,
      bitDepth: null,
    },
  ]);
  const seeded = await tracksList(true);
  await gqlRequest(app)
    .mutate(RegroupMutation)
    .variables({ id: seeded.edges[0]!.node.id, album: 'Y' })
    .expectNoErrors();

  expect((await tracksList()).totalCount).toBe(1);
  expect((await tracksList(true)).totalCount).toBe(2);
});

test('untitled tracks are never grouped', async () => {
  await seed([
    {
      title: null,
      artist: 'X',
      album: 'Y',
      codec: 'flac',
      isLossless: true,
      bitRate: 900_000,
      bitDepth: 16,
    },
    {
      title: null,
      artist: 'X',
      album: 'Y',
      codec: 'mp3',
      isLossless: false,
      bitRate: 256_000,
      bitDepth: null,
    },
  ]);
  const seeded = await tracksList(true);
  await gqlRequest(app)
    .mutate(RegroupMutation)
    .variables({ id: seeded.edges[0]!.node.id, album: 'Y' })
    .expectNoErrors();

  expect((await tracksList()).totalCount).toBe(2);
});

test('retitling a track out of a group re-ranks both groups', async () => {
  await seed([
    {
      title: 'Song',
      artist: 'Art',
      album: 'Alb',
      codec: 'flac',
      isLossless: true,
      bitRate: 900_000,
      bitDepth: 16,
    },
    {
      title: 'Song',
      artist: 'Art',
      album: 'Alb',
      codec: 'mp3',
      isLossless: false,
      bitRate: 256_000,
      bitDepth: null,
    },
  ]);
  const seeded = await tracksList(true);
  await gqlRequest(app)
    .mutate(RegroupMutation)
    .variables({ id: seeded.edges[0]!.node.id, album: 'Alb' })
    .expectNoErrors();
  const grouped = await tracksList();
  expect(grouped.totalCount).toBe(1);

  // Retitle the lossy copy so it leaves the group; both become singletons.
  const lossy = seeded.edges.find((e) => e.node.sourceFormat === 'mp3')!;
  await gqlRequest(app)
    .mutate(RetitleMutation)
    .variables({ id: lossy.node.id, title: 'Different' })
    .expectNoErrors();

  const after = await tracksList();
  expect(after.totalCount).toBe(2);
  for (const edge of after.edges) {
    expect(edge.node.duplicates).toEqual([]);
  }
});
