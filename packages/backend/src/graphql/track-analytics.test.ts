import { desc, eq } from 'drizzle-orm';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { trackAnalytics, tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(tracks);
});

const trackId = '01934567-89ab-7cde-8123-456789abcdef';

async function seedTrack() {
  await db.insert(tracks).values({
    id: trackId,
    title: 'A Track',
    format: 'mp3',
    codec: 'mp3',
    bitRate: null,
    sampleRate: 44_100,
    isLossless: false,
    file: '/library/a.mp3',
    sizeBytes: 1024,
    durationSeconds: 200,
    sourceMtime: new Date(0),
  });
}

const CollectMutation = graphql(`
  mutation Collect(
    $trackId: ID!
    $playTimeSeconds: Int!
    $requestedMode: String!
    $outputCodec: String!
  ) {
    trackAnalyticsCollect(
      trackId: $trackId
      playTimeSeconds: $playTimeSeconds
      requestedMode: $requestedMode
      outputCodec: $outputCodec
    ) {
      _
    }
  }
`);

test('persists a sample, taking the client IP from X-Forwarded-For', async () => {
  await seedTrack();

  await gqlRequest(app)
    .mutate(CollectMutation)
    .variables({
      trackId,
      playTimeSeconds: 15,
      requestedMode: 'SMART',
      outputCodec: 'audio/webm; codecs="opus"',
    })
    .set('x-forwarded-for', '203.0.113.7')
    .expectNoErrors();

  const rows = await db.select().from(trackAnalytics).where(eq(trackAnalytics.trackId, trackId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    trackId,
    clientIp: '203.0.113.7',
    playTimeSeconds: 15,
    requestedMode: 'SMART',
    outputCodec: 'audio/webm; codecs="opus"',
  });
});

test('records every sample of a play, including the zero-second start', async () => {
  await seedTrack();

  for (const playTimeSeconds of [0, 15, 7]) {
    await gqlRequest(app)
      .mutate(CollectMutation)
      .variables({ trackId, playTimeSeconds, requestedMode: 'ORIGINAL', outputCodec: 'audio/flac' })
      .expectNoErrors();
  }

  const rows = await db
    .select({ playTimeSeconds: trackAnalytics.playTimeSeconds })
    .from(trackAnalytics)
    .where(eq(trackAnalytics.trackId, trackId))
    .orderBy(desc(trackAnalytics.createdAt));
  const total = rows.reduce((sum, r) => sum + r.playTimeSeconds, 0);
  expect(rows).toHaveLength(3);
  expect(total).toBe(22);
});
