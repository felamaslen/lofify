import { copyFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { env } from '../env.js';
import { TEST__clearScans } from '../scanner/runner.js';
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
  TEST__clearScans();
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
      isCompleted
      errorMessage
    }
  }
`);

const LibraryScanQuery = graphql(`
  query LibraryScanCurrent {
    libraryScan {
      id
      filesTotal
      scannedTotal
      errorsTotal
      isCompleted
      errorMessage
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
      isCompleted
      errorMessage
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

test('Mutation.libraryScanStart returns immediately with filesTotal: null and isCompleted: false', async () => {
  await copyFile(path.join(fixturesDir, 'sample.mp3'), path.join(env.LIBRARY_PATH, 'one.mp3'));
  await copyFile(path.join(fixturesDir, 'sample.flac'), path.join(env.LIBRARY_PATH, 'two.flac'));

  const { data } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();
  const scan = data.libraryScanStart;
  expect(typeof scan.id).toBe('string');
  expect(scan.filesTotal).toBeNull();
  expect(scan.scannedTotal).toBe(0);
  expect(scan.errorsTotal).toBe(0);
  expect(scan.isCompleted).toBe(false);
  expect(scan.errorMessage).toBeNull();

  await drainScanStream(scan.id);
});

test('Subscription.libraryScan: isCompleted is false until the final frame', async () => {
  await copyFile(path.join(fixturesDir, 'sample.mp3'), path.join(env.LIBRARY_PATH, 'one.mp3'));

  const { data } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();
  const { id, filesTotal } = data.libraryScanStart;
  expect(filesTotal).toBeNull();

  const frames = await drainScanStream(id);
  expect(frames.length).toBeGreaterThan(0);

  for (const frame of frames.slice(0, -1)) {
    expect(frame.isCompleted).toBe(false);
  }

  const last = frames.at(-1)!;
  expect(last.id).toBe(id);
  expect(last.filesTotal).toBe(1);
  expect(last.scannedTotal).toBe(1);
  expect(last.isCompleted).toBe(true);
  expect(last.errorMessage).toBeNull();
});

test('Subscription.libraryScan: errorMessage reports failed files on the final frame', async () => {
  await writeFile(path.join(env.LIBRARY_PATH, 'broken.mp3'), 'not audio');

  const { data } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();
  const { id } = data.libraryScanStart;

  const frames = await drainScanStream(id);
  const last = frames.at(-1)!;
  expect(last.isCompleted).toBe(true);
  expect(last.errorsTotal).toBe(1);
  expect(last.errorMessage).toBe('1 file failed to scan');
});

const LibraryScanCancelMutation = graphql(`
  mutation LibraryScanCancel($id: ID!) {
    libraryScanCancel(id: $id) {
      _
    }
  }
`);

test('Mutation.libraryScanCancel: the subscription emits a final null frame, Query.libraryScan returns null, and a fresh scan can be started', async () => {
  await copyFile(path.join(fixturesDir, 'sample.mp3'), path.join(env.LIBRARY_PATH, 'one.mp3'));

  const { data: started } = await gqlRequest(app)
    .mutate(LibraryScanStartMutation)
    .expectNoErrors();
  const { id } = started.libraryScanStart;

  const framesPromise = (async () => {
    const frames: (Frame | null)[] = [];
    for await (const event of gqlRequest(app)
      .subscribe(LibraryScanSubscription)
      .variables({ id })) {
      frames.push(event.data?.libraryScan ?? null);
    }
    return frames;
  })();

  await gqlRequest(app)
    .mutate(LibraryScanCancelMutation)
    .variables({ id })
    .expectNoErrors();

  const frames = await framesPromise;
  expect(frames.at(-1)).toBeNull();

  const { data: afterCancel } = await gqlRequest(app).query(LibraryScanQuery).expectNoErrors();
  expect(afterCancel.libraryScan).toBeNull();

  const { data: restarted } = await gqlRequest(app)
    .mutate(LibraryScanStartMutation)
    .expectNoErrors();
  expect(restarted.libraryScanStart.id).not.toBe(id);
  await drainScanStream(restarted.libraryScanStart.id);
});

test('Query.libraryScan is null when no scan has run', async () => {
  const { data } = await gqlRequest(app).query(LibraryScanQuery).expectNoErrors();
  expect(data.libraryScan).toBeNull();
});

test('Query.libraryScan exposes the in-progress scan and the completed scan within its grace period', async () => {
  await copyFile(path.join(fixturesDir, 'sample.mp3'), path.join(env.LIBRARY_PATH, 'one.mp3'));

  const { data: started } = await gqlRequest(app)
    .mutate(LibraryScanStartMutation)
    .expectNoErrors();

  const { data: inProgressData } = await gqlRequest(app)
    .query(LibraryScanQuery)
    .expectNoErrors();
  expect(inProgressData.libraryScan).not.toBeNull();
  expect(inProgressData.libraryScan!.id).toBe(started.libraryScanStart.id);

  await drainScanStream(started.libraryScanStart.id);

  const { data: afterData } = await gqlRequest(app).query(LibraryScanQuery).expectNoErrors();
  expect(afterData.libraryScan).not.toBeNull();
  expect(afterData.libraryScan!.id).toBe(started.libraryScanStart.id);
  expect(afterData.libraryScan!.isCompleted).toBe(true);
});
