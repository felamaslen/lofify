import sharp from 'sharp';

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
    updatedAt: new Date(),
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
  expect(data.track?.artwork).toStrictEqual({
    __typename: 'Artwork',
    album: 'The Album',
    albumArtist: 'Album Artist',
    // Stable, version-free: the original URL is served no-store, and previews carry the version.
    media: {
      url: `http://lofify.test/artwork/${row!.id}`,
    },
  });
});

test('Image.preview wraps the original URL behind the asset route', async () => {
  await seedAlbum();
  await gqlRequest(app).mutate(ArtworkDownloadMutation).variables({ trackId }).expectNoErrors();
  const [row] = await db
    .update(albumArt)
    .set({ status: 'SUCCEEDED', file: 'placeholder.jpg', updatedAt: new Date() })
    .returning();

  const PreviewQuery = graphql(`
    query TrackArtworkPreview($id: ID!) {
      track(id: $id) {
        artwork {
          ... on Artwork {
            media {
              __typename
              url
              ... on Image {
                preview(size: SQUARE_500) {
                  url
                }
              }
            }
          }
        }
      }
    }
  `);
  const { data } = await gqlRequest(app)
    .query(PreviewQuery)
    .variables({ id: trackId })
    .expectNoErrors();
  const media =
    data.track?.artwork && 'media' in data.track.artwork ? data.track.artwork.media : null;
  const original = `http://lofify.test/artwork/${row!.id}`;
  expect(media?.url).toBe(original);
  expect(media?.__typename).toBe('Image');
  expect(media?.preview.url).toBe(
    `http://lofify.test/asset/format=avif&size=500&v=${row!.updatedAt.getTime()}/${original}`,
  );
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

// A real 1x1 PNG: the upload path sniffs magic bytes, so the fixture must be a valid image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Hand-rolled GraphQL multipart request (https://github.com/jaydenseric/graphql-multipart-request-spec) driving `trackUpdate` with an `artwork` upload. */
function uploadArtwork(id: string, image: Buffer) {
  const boundary = 'lofify-test-boundary';
  const query = `mutation TrackArtworkUpload($id: ID!, $artwork: Upload) {
    trackUpdate(id: $id, artwork: $artwork) {
      artwork { __typename ... on Artwork { album albumArtist media { url } } }
    }
  }`;
  const operations = JSON.stringify({ query, variables: { id, artwork: null } });
  const map = JSON.stringify({ '0': ['variables.artwork'] });
  const part = (headers: string, body: Buffer | string) =>
    Buffer.concat([
      Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`),
      Buffer.from(body),
      Buffer.from('\r\n'),
    ]);
  const payload = Buffer.concat([
    part('content-disposition: form-data; name="operations"', operations),
    part('content-disposition: form-data; name="map"', map),
    part(
      'content-disposition: form-data; name="0"; filename="art.png"\r\ncontent-type: image/png',
      image,
    ),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: '/graphql',
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      // Apollo's CSRF prevention blocks multipart requests without a preflight-triggering header.
      'x-apollo-operation-name': 'TrackArtworkUpload',
    },
  });
}

test('trackUpdate with an artwork upload stores the image and links the whole album', async () => {
  await seedAlbum();

  const res = await uploadArtwork(trackId, PNG);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.errors).toBeUndefined();
  const artwork = body.data.trackUpdate.artwork;
  expect(artwork).toMatchObject({
    __typename: 'Artwork',
    album: 'The Album',
    albumArtist: 'Album Artist',
  });
  expect(artwork.media.url).toMatch(/^http:\/\/lofify\.test\/artwork\/[0-9a-f-]{36}$/);

  const served = await app.inject({ method: 'GET', url: new URL(artwork.media.url).pathname });
  expect(served.statusCode).toBe(200);
  expect(served.headers['content-type']).toBe('image/png');
  expect(served.rawPayload).toEqual(PNG);

  const { data: sibling } = await gqlRequest(app)
    .query(TrackArtworkQuery)
    .variables({ id: siblingId })
    .expectNoErrors();
  expect(sibling.track?.artwork).toMatchObject({
    __typename: 'Artwork',
    media: { url: artwork.media.url },
  });
});

test('replacing artwork keeps the stable URL serving the new image and busts the preview', async () => {
  await seedAlbum();
  const replacement = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#0c0' },
  })
    .png()
    .toBuffer();

  const first = (await uploadArtwork(trackId, PNG)).json().data.trackUpdate.artwork;
  const second = (await uploadArtwork(trackId, replacement)).json().data.trackUpdate.artwork;
  // Same row, same id, same (no-store) URL — only previews carry the version that moved.
  expect(second.media.url).toBe(first.media.url);

  const rows = await db.select().from(albumArt);
  expect(rows).toHaveLength(1);

  const served = await app.inject({ method: 'GET', url: new URL(second.media.url).pathname });
  expect(served.rawPayload).toEqual(replacement);
});

test('artwork uploads that are not real images are rejected', async () => {
  await seedAlbum();

  const garbage = await uploadArtwork(trackId, Buffer.from('not an image'));
  const body = garbage.json();
  expect(body.errors?.[0]?.message).toMatch(/unsupported image format/i);
});

test('artwork uploads for unknown or album-less tracks are rejected', async () => {
  const unknown = await uploadArtwork('01934567-89ab-7cde-8123-000000000000', PNG);
  expect(unknown.json().errors?.[0]?.message).toMatch(/Unknown track/);

  await db.insert(tracks).values({
    ...trackValues(trackId, '/library/untagged.mp3'),
    artist: 'Some Artist',
  });
  const noAlbum = await uploadArtwork(trackId, PNG);
  expect(noAlbum.json().errors?.[0]?.message).toMatch(/no album/);
});
