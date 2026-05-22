import { copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { env } from '../env.js';
import { graphql, type ResultOf } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scanner/__fixtures__',
);

async function clearLibrary() {
  for (const entry of await readdir(env.LIBRARY_PATH)) {
    await rm(path.join(env.LIBRARY_PATH, entry), {
      recursive: true,
      force: true,
    });
  }
}

beforeEach(async () => {
  await db.delete(tracks);
  await clearLibrary();
});

afterEach(async () => {
  await clearLibrary();
  await db.delete(tracks);
});

const LibraryScanStartMutation = graphql(`
  mutation LibraryScanStart {
    libraryScanStart {
      id
      filesTotal
      scannedTotal
      errorsTotal
    }
  }
`);

const LibraryScanSubscription = graphql(`
  subscription LibraryScan($id: ID!) {
    libraryScan(id: $id) {
      id
      filesTotal
      scannedTotal
      errorsTotal
    }
  }
`);

type Frame = NonNullable<ResultOf<typeof LibraryScanSubscription>>['libraryScan'];

async function drainScanStream(scanId: string): Promise<Frame[]> {
  const frames: Frame[] = [];
  for await (const event of gqlRequest(app)
    .subscribe(LibraryScanSubscription)
    .variables({ id: scanId })) {
    if (event.data?.libraryScan) frames.push(event.data.libraryScan);
  }
  return frames;
}

test('Mutation.libraryScanStart returns immediately with filesTotal: null', async () => {
  await copyFile(path.join(fixturesDir, 'sample.mp3'), path.join(env.LIBRARY_PATH, 'one.mp3'));
  await copyFile(path.join(fixturesDir, 'sample.flac'), path.join(env.LIBRARY_PATH, 'two.flac'));

  const { data } = await gqlRequest(app)
    .mutate(LibraryScanStartMutation)
    .expectNoErrors();
  const scan = data.libraryScanStart;
  expect(typeof scan.id).toBe('string');
  expect(scan.filesTotal).toBeNull();
  expect(scan.scannedTotal).toBe(0);
  expect(scan.errorsTotal).toBe(0);

  await drainScanStream(scan.id);
});

test('Subscription.libraryScan emits progress and terminates', async () => {
  await copyFile(path.join(fixturesDir, 'sample.mp3'), path.join(env.LIBRARY_PATH, 'one.mp3'));

  const { data } = await gqlRequest(app)
    .mutate(LibraryScanStartMutation)
    .expectNoErrors();
  const { id, filesTotal } = data.libraryScanStart;
  expect(filesTotal).toBeNull();

  const frames = await drainScanStream(id);
  expect(frames.length).toBeGreaterThan(0);
  const last = frames.at(-1)!;
  expect(last.id).toBe(id);
  expect(last.filesTotal).toBe(1);
  expect(last.scannedTotal).toBe(1);
});
