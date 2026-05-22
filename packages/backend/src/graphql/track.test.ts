import gql from 'fake-tag';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { gqlRequest, makeApp } from '../test/inject.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await makeApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await db.delete(tracks);
});

type GqlTrack = {
  id: string;
  title: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  artist: string | null;
  album: string | null;
  year: string | null;
  format: string;
  duration: { seconds: number; formatted: string };
  url: string;
};

type GqlEdge = { node: GqlTrack; cursor: string };
type GqlConnection = {
  edges: GqlEdge[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  totalCount: number;
};

const TRACK_FRAGMENT = gql`
  fragment TrackFields on Track {
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
`;

const TRACKS_QUERY = gql`
  query ($first: Int, $last: Int, $after: String, $before: String) {
    tracks(first: $first, last: $last, after: $after, before: $before) {
      edges {
        cursor
        node {
          ...TrackFields
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
  ${TRACK_FRAGMENT}
`;

const TRACK_QUERY = gql`
  query ($id: ID!) {
    track(id: $id) {
      ...TrackFields
    }
  }
  ${TRACK_FRAGMENT}
`;

const TRACK_URL_QUERY = gql`
  query ($id: ID!, $quality: Int, $format: Format) {
    track(id: $id) {
      id
      url(quality: $quality, format: $format)
    }
  }
`;

type Seed = {
  id?: string;
  artist: string | null;
  album: string | null;
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
      year: null,
      format: r.format,
      codec: r.codec,
      bitRate: null,
      sampleRate: 44_100,
      isLossless: r.format === 'flac',
      file: `/library/${r.artist ?? 'unk'}/${r.album ?? 'unk'}/${r.title}.${r.format}`,
      sizeBytes: 1024,
      durationSeconds: r.durationSeconds,
    })),
  );
}

test('Query.tracks paginates forward in artist/album/disc/track order', async () => {
  await seed([
    { artist: 'B', album: 'B1', discNumber: 1, trackNumber: 1, title: 'b1-1', format: 'mp3', codec: 'mp3', durationSeconds: 100 },
    { artist: 'A', album: 'A2', discNumber: 1, trackNumber: 1, title: 'a2-1', format: 'mp3', codec: 'mp3', durationSeconds: 100 },
    { artist: 'A', album: 'A1', discNumber: 2, trackNumber: 1, title: 'a1-2-1', format: 'mp3', codec: 'mp3', durationSeconds: 100 },
    { artist: 'A', album: 'A1', discNumber: 1, trackNumber: 2, title: 'a1-1-2', format: 'mp3', codec: 'mp3', durationSeconds: 100 },
    { artist: 'A', album: 'A1', discNumber: 1, trackNumber: 1, title: 'a1-1-1', format: 'mp3', codec: 'mp3', durationSeconds: 100 },
  ]);

  const first = await gqlRequest(app, TRACKS_QUERY, { first: 2 });
  expect(first.errors).toBeUndefined();
  const page1 = (first.data as { tracks: GqlConnection }).tracks;
  expect(page1.totalCount).toBe(5);
  expect(page1.edges.map((e) => e.node.title)).toEqual(['a1-1-1', 'a1-1-2']);
  expect(page1.edges.map((e) => e.cursor)).toEqual(page1.edges.map((e) => e.node.id));
  expect(page1.pageInfo.endCursor).toBe(page1.edges.at(-1)!.node.id);
  expect(page1.pageInfo.hasNextPage).toBe(true);
  expect(page1.pageInfo.hasPreviousPage).toBe(false);

  const second = await gqlRequest(app, TRACKS_QUERY, {
    first: 2,
    after: page1.pageInfo.endCursor,
  });
  const page2 = (second.data as { tracks: GqlConnection }).tracks;
  expect(page2.edges.map((e) => e.node.title)).toEqual(['a1-2-1', 'a2-1']);
  expect(page2.pageInfo.hasNextPage).toBe(true);
  expect(page2.pageInfo.hasPreviousPage).toBe(true);

  const third = await gqlRequest(app, TRACKS_QUERY, {
    first: 2,
    after: page2.pageInfo.endCursor,
  });
  const page3 = (third.data as { tracks: GqlConnection }).tracks;
  expect(page3.edges.map((e) => e.node.title)).toEqual(['b1-1']);
  expect(page3.pageInfo.hasNextPage).toBe(false);
});

test('Query.tracks paginates backward with last/before', async () => {
  await seed([
    { artist: 'A', album: 'A1', discNumber: 1, trackNumber: 1, title: 't1', format: 'mp3', codec: 'mp3', durationSeconds: 60 },
    { artist: 'A', album: 'A1', discNumber: 1, trackNumber: 2, title: 't2', format: 'mp3', codec: 'mp3', durationSeconds: 60 },
    { artist: 'A', album: 'A1', discNumber: 1, trackNumber: 3, title: 't3', format: 'mp3', codec: 'mp3', durationSeconds: 60 },
    { artist: 'A', album: 'A1', discNumber: 1, trackNumber: 4, title: 't4', format: 'mp3', codec: 'mp3', durationSeconds: 60 },
  ]);

  const tail = await gqlRequest(app, TRACKS_QUERY, { last: 2 });
  const last = (tail.data as { tracks: GqlConnection }).tracks;
  expect(last.edges.map((e) => e.node.title)).toEqual(['t3', 't4']);
  expect(last.pageInfo.hasPreviousPage).toBe(true);
  expect(last.pageInfo.hasNextPage).toBe(false);

  const before = await gqlRequest(app, TRACKS_QUERY, {
    last: 2,
    before: last.pageInfo.startCursor,
  });
  const prev = (before.data as { tracks: GqlConnection }).tracks;
  expect(prev.edges.map((e) => e.node.title)).toEqual(['t1', 't2']);
});

test('Query.track returns derived format/duration and a signed url', async () => {
  const id = '01934567-89ab-7cde-8123-456789abcdef';
  await seed([
    { id, artist: 'A', album: 'A1', discNumber: 1, trackNumber: 1, title: 'only', format: 'ogg', codec: 'vorbis', durationSeconds: 332 },
  ]);

  const single = await gqlRequest(app, TRACK_QUERY, { id });
  expect(single.errors).toBeUndefined();
  const t = (single.data as { track: GqlTrack }).track;
  expect(t.format).toBe('ogg vorbis');
  expect(t.duration).toEqual({ seconds: 332, formatted: '05:32' });

  expect(t.url).toMatchInlineSnapshot(
    `"/play/be5ca606a3a5d4d82dbe6a389d521e03f983bff315b2546866e46fabc43aab59/01934567-89ab-7cde-8123-456789abcdef"`,
  );

  const signed = await gqlRequest(app, TRACK_URL_QUERY, {
    id,
    quality: 7,
    format: 'OGG',
  });
  const url = (signed.data as { track: { id: string; url: string } }).track.url;
  expect(url).toMatchInlineSnapshot(
    `"/play/774fda3d1cf3cbbbf6751d4806e79f67298d088febd94ce68eb7ea5aedbf21eb/f:ogg/q:7/01934567-89ab-7cde-8123-456789abcdef"`,
  );
});

test('Query.track returns null when id is unknown', async () => {
  const res = await gqlRequest(app, TRACK_QUERY, {
    id: '00000000-0000-0000-0000-000000000000',
  });
  expect(res.errors).toBeUndefined();
  expect((res.data as { track: GqlTrack | null }).track).toBeNull();
});

test('Track.url rejects quality outside 0–10', async () => {
  await seed([
    { artist: 'A', album: 'A1', discNumber: 1, trackNumber: 1, title: 'only', format: 'mp3', codec: 'mp3', durationSeconds: 60 },
  ]);
  const list = await gqlRequest(app, TRACKS_QUERY, { first: 1 });
  const id = (list.data as { tracks: GqlConnection }).tracks.edges[0]!.node.id;

  const res = await gqlRequest(app, TRACK_URL_QUERY, { id, quality: 99, format: null });
  expect(res.errors?.[0]?.message).toMatch(/between 0 and 10/);
});
