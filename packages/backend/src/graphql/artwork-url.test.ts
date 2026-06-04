import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { albumArt, tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

// The network edge is intercepted by msw, so the real ky client (redirects, headers, abort
// behaviour) runs against declarative per-test handlers. Anything unhandled is a hard error.
const server = setupServer();
let requestCount = 0;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  server.events.on('request:start', () => {
    requestCount += 1;
  });
});
afterAll(() => server.close());

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  await db.delete(tracks);
  await db.delete(albumArt);
  server.resetHandlers();
  requestCount = 0;
});

const trackId = '01934567-89ab-7cde-8123-456789abcdef';

async function seedTrack() {
  await db.insert(tracks).values({
    id: trackId,
    title: 'One',
    artist: 'Some Artist',
    albumArtist: 'Album Artist',
    album: 'The Album',
    format: 'mp3',
    codec: 'mp3',
    sampleRate: 44_100,
    isLossless: false,
    file: '/library/one.mp3',
    sizeBytes: 1024,
    durationSeconds: 60,
    sourceMtime: new Date(0),
  });
}

const ArtworkFromUrlMutation = graphql(`
  mutation TrackArtworkFromUrl($id: ID!, $artworkUrl: String) {
    trackUpdate(id: $id, artworkUrl: $artworkUrl) {
      artwork {
        __typename
        ... on Artwork {
          isManual
        }
      }
    }
  }
`);

test('trackUpdate downloads an artwork URL and stores it as manual artwork', async () => {
  await seedTrack();
  server.use(
    http.get('https://covers.example.com/album.png', () =>
      HttpResponse.arrayBuffer(PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength), {
        headers: { 'content-type': 'image/png' },
      }),
    ),
  );

  const { data } = await gqlRequest(app)
    .mutate(ArtworkFromUrlMutation)
    .variables({ id: trackId, artworkUrl: 'https://covers.example.com/album.png' })
    .expectNoErrors();
  expect(data.trackUpdate.artwork).toEqual({ __typename: 'Artwork', isManual: true });
  expect(requestCount).toBe(1);

  // The bytes landed in the artwork store and serve like any upload.
  const [row] = await db.select().from(albumArt);
  expect(row).toMatchObject({ status: 'SUCCEEDED', isManual: true });
  const served = await app.inject({ method: 'GET', url: `/artwork/${row!.id}` });
  expect(served.rawPayload).toEqual(PNG);
});

test('redirects are followed', async () => {
  await seedTrack();
  server.use(
    http.get('https://covers.example.com/album.png', () =>
      HttpResponse.redirect('https://cdn.example.com/album.png', 302),
    ),
    http.get('https://cdn.example.com/album.png', () => new HttpResponse(PNG)),
  );

  const { data } = await gqlRequest(app)
    .mutate(ArtworkFromUrlMutation)
    .variables({ id: trackId, artworkUrl: 'https://covers.example.com/album.png' })
    .expectNoErrors();
  expect(data.trackUpdate.artwork).toMatchObject({ __typename: 'Artwork' });
});

test('invalid URLs are rejected without fetching', async () => {
  await seedTrack();

  const artworkUrl = 'not a url';
  const { errors } = await gqlRequest(app)
    .mutate(ArtworkFromUrlMutation)
    .variables({ id: trackId, artworkUrl })
    .expectErrors();
  expect(errors[0]?.message).toMatchInlineSnapshot(`"Artwork URL is invalid."`);
  expect(requestCount).toBe(0);
});

test('non-http URLs are rejected without fetching', async () => {
  await seedTrack();

  const artworkUrl = 'ftp://covers.example.com/album.png';
  const { errors } = await gqlRequest(app)
    .mutate(ArtworkFromUrlMutation)
    .variables({ id: trackId, artworkUrl })
    .expectErrors();
  expect(errors[0]?.message).toMatchInlineSnapshot(`"Artwork URL must be http(s)."`);
  expect(requestCount).toBe(0);
});

test('fetch failures surface with context', async () => {
  await seedTrack();
  server.use(
    http.get('https://covers.example.com/missing.png', () =>
      HttpResponse.text('not here', { status: 404 }),
    ),
  );

  const { errors } = await gqlRequest(app)
    .mutate(ArtworkFromUrlMutation)
    .variables({ id: trackId, artworkUrl: 'https://covers.example.com/missing.png' })
    .expectErrors();
  expect(errors[0]?.message).toMatchInlineSnapshot(
    `"Could not fetch the artwork URL: Request failed with status code 404 Not Found: GET https://covers.example.com/missing.png"`,
  );
});

test('responses that are not images, empty or oversized are rejected', async () => {
  await seedTrack();
  server.use(
    http.get('https://covers.example.com/page', () =>
      HttpResponse.text('<html>not an image</html>'),
    ),
    http.get('https://covers.example.com/empty.png', () => new HttpResponse(null, { status: 200 })),
    http.get(
      'https://covers.example.com/huge.png',
      () => new HttpResponse(Buffer.alloc(11 * 1024 * 1024)),
    ),
  );

  const garbage = await gqlRequest(app)
    .mutate(ArtworkFromUrlMutation)
    .variables({ id: trackId, artworkUrl: 'https://covers.example.com/page' })
    .expectErrors();
  expect(garbage.errors[0]?.message).toMatchInlineSnapshot(
    `"Unsupported image format — use jpeg, png or webp."`,
  );

  const empty = await gqlRequest(app)
    .mutate(ArtworkFromUrlMutation)
    .variables({ id: trackId, artworkUrl: 'https://covers.example.com/empty.png' })
    .expectErrors();
  expect(empty.errors[0]?.message).toMatchInlineSnapshot(
    `"Could not fetch the artwork URL: the response was empty"`,
  );

  const huge = await gqlRequest(app)
    .mutate(ArtworkFromUrlMutation)
    .variables({ id: trackId, artworkUrl: 'https://covers.example.com/huge.png' })
    .expectErrors();
  expect(huge.errors[0]?.message).toMatchInlineSnapshot(
    `"Could not fetch the artwork URL: the image is too large"`,
  );
});

test('an unbounded download is aborted at the byte cap', async () => {
  await seedTrack();
  // A stream that never ends: the test only completes because the byte counter aborts the
  // transfer once it crosses the cap.
  let pulls = 0;
  server.use(
    http.get(
      'https://covers.example.com/endless.png',
      () =>
        new HttpResponse(
          new ReadableStream({
            pull(c) {
              pulls += 1;
              c.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
        ),
    ),
  );

  const { errors } = await gqlRequest(app)
    .mutate(ArtworkFromUrlMutation)
    .variables({ id: trackId, artworkUrl: 'https://covers.example.com/endless.png' })
    .expectErrors();
  expect(errors[0]?.message).toMatchInlineSnapshot(
    `"Could not fetch the artwork URL: the image is too large"`,
  );
  // 10 MiB cap at 1 MiB per chunk: the abort lands around the 11th chunk, not after gigabytes.
  expect(pulls).toBeLessThan(20);
});

test('passing both artwork upload and artworkUrl is rejected', async () => {
  await seedTrack();
  // artwork is an Upload scalar (multipart-only), so the conflict needs a multipart request with
  // a mapped file plus the artworkUrl variable.
  const boundary = 'lofify-test-boundary';
  const query = `mutation Both($id: ID!, $artwork: Upload, $artworkUrl: String) {
    trackUpdate(id: $id, artwork: $artwork, artworkUrl: $artworkUrl) { id }
  }`;
  const operations = JSON.stringify({
    query,
    variables: { id: trackId, artwork: null, artworkUrl: 'https://covers.example.com/a.png' },
  });
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
      'content-disposition: form-data; name="0"; filename="a.png"\r\ncontent-type: image/png',
      PNG,
    ),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-apollo-operation-name': 'Both',
    },
  });
  expect(res.json().errors?.[0]?.message).toMatchInlineSnapshot(
    `"Pass either artwork or artworkUrl, not both."`,
  );
});
