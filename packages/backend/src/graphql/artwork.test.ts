import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { albumArt, tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(tracks);
  await db.delete(albumArt);
});

const trackId = '01934567-89ab-7cde-8123-456789abcdef';
const siblingId = '01934567-89ab-7cde-8123-456789abcde0';
const otherId = '01934567-89ab-7cde-8123-456789abcde1';

function trackValues(id: string, file: string) {
  return {
    id,
    format: 'mp3',
    codec: 'mp3',
    sampleRate: 44_100,
    isLossless: false,
    file,
    sizeBytes: 1024,
    durationSeconds: 60,
    sourceMtime: new Date(0),
  };
}

async function seedAlbum() {
  await db.insert(tracks).values([
    {
      ...trackValues(trackId, '/library/one.mp3'),
      title: 'One',
      artist: 'Some Artist',
      albumArtist: 'Album Artist',
      album: 'The Album',
    },
    {
      ...trackValues(siblingId, '/library/two.mp3'),
      title: 'Two',
      artist: 'Another Artist',
      albumArtist: 'Album Artist',
      album: 'The Album',
    },
    {
      ...trackValues(otherId, '/library/three.mp3'),
      title: 'Three',
      artist: 'Album Artist',
      album: 'A Different Album',
    },
  ]);
}

const ArtworkDownloadMutation = graphql(`
  mutation ArtworkDownload($trackId: ID!) {
    artworkDownload(trackId: $trackId) {
      __typename
      ... on Artwork {
        album
        albumArtist
        media {
          url
        }
      }
      ... on ArtworkStatus {
        inProgress
        message
      }
    }
  }
`);

const TrackArtworkQuery = graphql(`
  query TrackArtwork($id: ID!) {
    track(id: $id) {
      artwork {
        __typename
        ... on Artwork {
          album
          albumArtist
          media {
            url
          }
        }
        ... on ArtworkStatus {
          inProgress
          message
        }
      }
    }
  }
`);

test('Track.artwork is null until artworkDownload is called, then pending for every track of the album', async () => {
  await seedAlbum();

  const { data: before } = await gqlRequest(app)
    .query(TrackArtworkQuery)
    .variables({ id: trackId })
    .expectNoErrors();
  expect(before.track?.artwork).toBeNull();

  const { data } = await gqlRequest(app)
    .mutate(ArtworkDownloadMutation)
    .variables({ trackId })
    .expectNoErrors();
  expect(data.artworkDownload).toMatchInlineSnapshot(`
    {
      "__typename": "ArtworkStatus",
      "inProgress": true,
      "message": "",
    }
  `);

  const { data: sibling } = await gqlRequest(app)
    .query(TrackArtworkQuery)
    .variables({ id: siblingId })
    .expectNoErrors();
  expect(sibling.track?.artwork).toMatchObject({ __typename: 'ArtworkStatus', inProgress: true });

  const { data: other } = await gqlRequest(app)
    .query(TrackArtworkQuery)
    .variables({ id: otherId })
    .expectNoErrors();
  expect(other.track?.artwork).toBeNull();
});

test('Track.artwork resolves to Artwork with a media URL once the download succeeds', async () => {
  await seedAlbum();
  await gqlRequest(app).mutate(ArtworkDownloadMutation).variables({ trackId }).expectNoErrors();

  const [row] = await db
    .update(albumArt)
    .set({ status: 'SUCCEEDED', file: 'placeholder.jpg' })
    .returning();

  const { data } = await gqlRequest(app)
    .query(TrackArtworkQuery)
    .variables({ id: trackId })
    .expectNoErrors();
  expect(data.track?.artwork).toEqual({
    __typename: 'Artwork',
    album: 'The Album',
    albumArtist: 'Album Artist',
    media: { url: `/artwork/${row!.id}` },
  });
});

test('a FAILED download surfaces its message and a retry resets it to pending', async () => {
  await seedAlbum();
  await gqlRequest(app).mutate(ArtworkDownloadMutation).variables({ trackId }).expectNoErrors();
  await db.update(albumArt).set({ status: 'FAILED', error: 'no cover found' });

  const { data: failed } = await gqlRequest(app)
    .query(TrackArtworkQuery)
    .variables({ id: trackId })
    .expectNoErrors();
  expect(failed.track?.artwork).toEqual({
    __typename: 'ArtworkStatus',
    inProgress: false,
    message: 'no cover found',
  });

  const { data: retried } = await gqlRequest(app)
    .mutate(ArtworkDownloadMutation)
    .variables({ trackId })
    .expectNoErrors();
  expect(retried.artworkDownload).toMatchObject({ __typename: 'ArtworkStatus', inProgress: true });
});

test('artworkDownload leaves an already-pending row untouched instead of re-queueing it', async () => {
  await seedAlbum();
  await gqlRequest(app).mutate(ArtworkDownloadMutation).variables({ trackId }).expectNoErrors();
  await db.update(albumArt).set({ status: 'IN_PROGRESS' });

  await gqlRequest(app).mutate(ArtworkDownloadMutation).variables({ trackId }).expectNoErrors();

  const rows = await db.select().from(albumArt);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe('IN_PROGRESS');
});

test('artworkDownload falls back to the track artist when no album artist is set', async () => {
  await seedAlbum();
  const { data } = await gqlRequest(app)
    .mutate(ArtworkDownloadMutation)
    .variables({ trackId: otherId })
    .expectNoErrors();
  expect(data.artworkDownload).toMatchObject({ __typename: 'ArtworkStatus', inProgress: true });

  const rows = await db.select().from(albumArt);
  expect(rows[0]).toMatchObject({ albumArtist: 'Album Artist', album: 'A Different Album' });
});

test('artworkDownload throws for a track with no album', async () => {
  await db.insert(tracks).values({
    ...trackValues(trackId, '/library/untagged.mp3'),
    artist: 'Some Artist',
  });
  const { errors } = await gqlRequest(app)
    .mutate(ArtworkDownloadMutation)
    .variables({ trackId })
    .expectErrors();
  expect(errors[0]?.message).toMatch(/no album/);
});

test('editing the album after linking does not detach the artwork', async () => {
  await seedAlbum();
  await gqlRequest(app).mutate(ArtworkDownloadMutation).variables({ trackId }).expectNoErrors();

  const TrackUpdateMutation = graphql(`
    mutation ArtworkTrackUpdate($id: ID!, $album: String) {
      trackUpdate(id: $id, album: $album) {
        id
      }
    }
  `);
  await gqlRequest(app)
    .mutate(TrackUpdateMutation)
    .variables({ id: trackId, album: 'Renamed Album' })
    .expectNoErrors();

  const { data } = await gqlRequest(app)
    .query(TrackArtworkQuery)
    .variables({ id: trackId })
    .expectNoErrors();
  expect(data.track?.artwork).toMatchObject({ __typename: 'ArtworkStatus', inProgress: true });
});

test('GET /artwork/:id serves the downloaded image immutably and 404s otherwise', async () => {
  const id = '01934567-89ab-7cde-8123-456789abcd99';
  // Mirrors the production layout: the worker writes <id>.jpg under <DISK_CACHE_DIR>/artwork.
  const artworkDir = path.join(process.env.DISK_CACHE_DIR!, 'artwork');
  await mkdir(artworkDir, { recursive: true });
  await writeFile(path.join(artworkDir, `${id}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const hit = await app.inject({ method: 'GET', url: `/artwork/${id}` });
  expect(hit.statusCode).toBe(200);
  expect(hit.headers['content-type']).toBe('image/jpeg');
  expect(hit.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(hit.rawPayload).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const miss = await app.inject({
    method: 'GET',
    url: '/artwork/01934567-89ab-7cde-8123-000000000000',
  });
  expect(miss.statusCode).toBe(404);

  const invalid = await app.inject({ method: 'GET', url: '/artwork/not-a-uuid' });
  expect(invalid.statusCode).toBe(404);
});
