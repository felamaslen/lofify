import { app } from '../app.js';
import { db } from '../db/client.js';
import { artistSynonyms, tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(artistSynonyms);
  await db.delete(tracks);
});

const CreateMutation = graphql(`
  mutation Create($artist: String!, $synonym: String!) {
    artistSynonymCreate(artist: $artist, synonym: $synonym) {
      artist
      synonym
    }
  }
`);

const UpdateMutation = graphql(`
  mutation Update($artist: String!, $synonym: String!, $newSynonym: String!) {
    artistSynonymUpdate(artist: $artist, synonym: $synonym, newSynonym: $newSynonym) {
      artist
      synonym
    }
  }
`);

const DeleteMutation = graphql(`
  mutation Delete($artist: String!, $synonym: String!) {
    artistSynonymDelete(artist: $artist, synonym: $synonym) {
      _
    }
  }
`);

const TrackSynonymsQuery = graphql(`
  query TrackSynonyms($id: ID!) {
    track(id: $id) {
      artistSynonyms
    }
  }
`);

const SearchArtistsQuery = graphql(`
  query SearchArtists($query: String!) {
    search(query: $query) {
      artists {
        totalCount
        edges {
          node {
            name
          }
        }
      }
    }
  }
`);

const trackId = '01934567-89ab-7cde-8123-456789abcdef';

async function seedTrack(artist: string | null, id = trackId) {
  await db.insert(tracks).values({
    id,
    title: 'T',
    trackNumber: 1,
    discNumber: 1,
    artist,
    album: 'Al',
    year: null,
    format: 'mp3',
    codec: 'mp3',
    bitRate: null,
    sampleRate: 44_100,
    isLossless: false,
    file: `/library/${id}.mp3`,
    sizeBytes: 1024,
    durationSeconds: 60,
    sourceMtime: new Date(0),
  });
}

// The artist's real name is in kanji; the romanisations are registered as synonyms.
const KANJI_ARTIST = '浅川マキ';

test('created synonyms surface on Track.artistSynonyms, alphabetically', async () => {
  await seedTrack(KANJI_ARTIST);
  for (const synonym of ['Maki Asakawa', 'Asakawa Maki']) {
    await gqlRequest(app)
      .mutate(CreateMutation)
      .variables({ artist: KANJI_ARTIST, synonym })
      .expectNoErrors();
  }

  const { data } = await gqlRequest(app)
    .query(TrackSynonymsQuery)
    .variables({ id: trackId })
    .expectNoErrors();
  expect(data.track!.artistSynonyms).toEqual(['Asakawa Maki', 'Maki Asakawa']);
});

test('Track.artistSynonyms is empty for an artist with none and for an untagged track', async () => {
  await seedTrack(null);
  const { data } = await gqlRequest(app)
    .query(TrackSynonymsQuery)
    .variables({ id: trackId })
    .expectNoErrors();
  expect(data.track!.artistSynonyms).toEqual([]);
});

test('artistSynonymCreate rejects a duplicate pair and blank input', async () => {
  await gqlRequest(app)
    .mutate(CreateMutation)
    .variables({ artist: 'A', synonym: 'x' })
    .expectNoErrors();

  const { errors: dup } = await gqlRequest(app)
    .mutate(CreateMutation)
    .variables({ artist: 'A', synonym: 'x' })
    .expectErrors();
  expect(dup[0]?.message).toMatch(/already exists/);

  const { errors: blank } = await gqlRequest(app)
    .mutate(CreateMutation)
    .variables({ artist: 'A', synonym: '   ' })
    .expectErrors();
  expect(blank[0]?.message).toMatch(/non-empty/);
});

test('artistSynonymUpdate renames an existing synonym', async () => {
  await seedTrack('A');
  await gqlRequest(app).mutate(CreateMutation).variables({ artist: 'A', synonym: 'old' });

  const { data } = await gqlRequest(app)
    .mutate(UpdateMutation)
    .variables({ artist: 'A', synonym: 'old', newSynonym: 'new' })
    .expectNoErrors();
  expect(data.artistSynonymUpdate).toEqual({ artist: 'A', synonym: 'new' });

  const { data: track } = await gqlRequest(app)
    .query(TrackSynonymsQuery)
    .variables({ id: trackId })
    .expectNoErrors();
  expect(track.track!.artistSynonyms).toEqual(['new']);
});

test('artistSynonymUpdate rejects an unknown synonym and a clashing rename', async () => {
  await gqlRequest(app).mutate(CreateMutation).variables({ artist: 'A', synonym: 'x' });
  await gqlRequest(app).mutate(CreateMutation).variables({ artist: 'A', synonym: 'y' });

  const { errors: unknown } = await gqlRequest(app)
    .mutate(UpdateMutation)
    .variables({ artist: 'A', synonym: 'nope', newSynonym: 'z' })
    .expectErrors();
  expect(unknown[0]?.message).toMatch(/Unknown synonym/);

  const { errors: clash } = await gqlRequest(app)
    .mutate(UpdateMutation)
    .variables({ artist: 'A', synonym: 'x', newSynonym: 'y' })
    .expectErrors();
  expect(clash[0]?.message).toMatch(/already exists/);
});

test('artistSynonymDelete removes the pair and is idempotent', async () => {
  await seedTrack('A');
  await gqlRequest(app).mutate(CreateMutation).variables({ artist: 'A', synonym: 'x' });

  await gqlRequest(app)
    .mutate(DeleteMutation)
    .variables({ artist: 'A', synonym: 'x' })
    .expectNoErrors();
  // Deleting again is a no-op, not an error.
  await gqlRequest(app)
    .mutate(DeleteMutation)
    .variables({ artist: 'A', synonym: 'x' })
    .expectNoErrors();

  const { data } = await gqlRequest(app)
    .query(TrackSynonymsQuery)
    .variables({ id: trackId })
    .expectNoErrors();
  expect(data.track!.artistSynonyms).toEqual([]);
});

test('Query.search.artists includes artists matched only by a synonym, as the canonical name', async () => {
  await seedTrack(KANJI_ARTIST);
  await gqlRequest(app)
    .mutate(CreateMutation)
    .variables({ artist: KANJI_ARTIST, synonym: 'Maki Asakawa' });

  // "maki" prefixes the romanised synonym; the kanji artist name can't be typed.
  const { data } = await gqlRequest(app)
    .query(SearchArtistsQuery)
    .variables({ query: 'maki' })
    .expectNoErrors();
  expect(data.search!.artists.totalCount).toBe(1);
  expect(data.search!.artists.edges.map((e) => e.node.name)).toEqual([KANJI_ARTIST]);
});

test('Query.search.artists dedupes an artist matched both directly and via a synonym', async () => {
  await seedTrack('Daft Punk');
  await gqlRequest(app)
    .mutate(CreateMutation)
    .variables({ artist: 'Daft Punk', synonym: 'Daft Punkk' });

  const { data } = await gqlRequest(app)
    .query(SearchArtistsQuery)
    .variables({ query: 'daft' })
    .expectNoErrors();
  expect(data.search!.artists.totalCount).toBe(1);
  expect(data.search!.artists.edges.map((e) => e.node.name)).toEqual(['Daft Punk']);
});
