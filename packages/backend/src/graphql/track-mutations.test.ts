import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(tracks);
});

const id = '01934567-89ab-7cde-8123-456789abcdef';

async function seedOne() {
  await db.insert(tracks).values({
    id,
    title: 'Scanned Title',
    trackNumber: 3,
    discNumber: 1,
    artist: 'Scanned Artist',
    album: 'Scanned Album',
    year: '1999',
    format: 'mp3',
    codec: 'mp3',
    bitRate: null,
    sampleRate: 44_100,
    isLossless: false,
    file: '/library/scanned.mp3',
    sizeBytes: 1024,
    durationSeconds: 60,
    sourceMtime: new Date(0),
  });
}

const TrackUpdateMutation = graphql(`
  mutation TrackUpdate(
    $id: ID!
    $title: String
    $artist: String
    $album: String
    $trackNumber: Int
    $discNumber: Int
    $year: String
  ) {
    trackUpdate(
      id: $id
      title: $title
      artist: $artist
      album: $album
      trackNumber: $trackNumber
      discNumber: $discNumber
      year: $year
    ) {
      id
      title
      artist
      album
      trackNumber
      discNumber
      year
    }
  }
`);

const TrackQuery = graphql(`
  query Track($id: ID!) {
    track(id: $id) {
      title
      artist
      album
      trackNumber
      discNumber
      year
    }
  }
`);

test('Mutation.trackUpdate overrides supplied tags and leaves omitted ones scanned', async () => {
  await seedOne();

  const { data } = await gqlRequest(app)
    .mutate(TrackUpdateMutation)
    .variables({ id, title: 'New Title', artist: 'New Artist', trackNumber: 7 })
    .expectNoErrors();

  expect(data.trackUpdate).toMatchInlineSnapshot(`
    {
      "album": "Scanned Album",
      "artist": "New Artist",
      "discNumber": 1,
      "id": "01934567-89ab-7cde-8123-456789abcdef",
      "title": "New Title",
      "trackNumber": 7,
      "year": "1999",
    }
  `);
});

test('Mutation.trackUpdate with explicit null clears an override back to the scanned tag', async () => {
  await seedOne();

  await gqlRequest(app)
    .mutate(TrackUpdateMutation)
    .variables({ id, artist: 'Overridden' })
    .expectNoErrors();

  const { data: cleared } = await gqlRequest(app)
    .mutate(TrackUpdateMutation)
    .variables({ id, artist: null })
    .expectNoErrors();

  expect(cleared.trackUpdate.artist).toBe('Scanned Artist');
});

test('Mutation.trackUpdate persists overrides across a fresh read', async () => {
  await seedOne();

  await gqlRequest(app)
    .mutate(TrackUpdateMutation)
    .variables({ id, album: 'Override Album', year: '2020' })
    .expectNoErrors();

  const { data } = await gqlRequest(app).query(TrackQuery).variables({ id }).expectNoErrors();
  expect(data.track).toMatchObject({ album: 'Override Album', year: '2020' });
});

test('Mutation.trackUpdate throws for an unknown track', async () => {
  const { errors } = await gqlRequest(app)
    .mutate(TrackUpdateMutation)
    .variables({ id: '00000000-0000-0000-0000-000000000000', title: 'x' })
    .expectErrors();
  expect(errors[0]?.message).toMatch(/Unknown track/);
});
