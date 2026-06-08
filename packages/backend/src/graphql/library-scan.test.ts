import { copyFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { scanErrors, tracks } from '../db/schema/index.js';
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
  await db.delete(scanErrors);
  await clearLibrary();
  TEST__clearScans();
});

afterEach(async () => {
  await clearLibrary();
  await db.delete(tracks);
  await db.delete(scanErrors);
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

const LibraryScanStartForceMutation = graphql(`
  mutation LibraryScanStartForce($force: Boolean) {
    libraryScanStart(force: $force) {
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
    expect(frame!.isCompleted).toBe(false);
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

test('a filename containing a backslash is scanned, not mangled into a missing path', async () => {
  // A literal backslash in a name (Windows-style paths flattened onto the NAS)
  // used to be rewritten to a forward slash by the glob walker, yielding a path
  // that stat() reported as missing. The direct walk preserves the bytes, so the
  // file is found and ingested normally.
  await copyFile(
    path.join(fixturesDir, 'sample.flac'),
    path.join(env.LIBRARY_PATH, 'Artist\\Album.flac'),
  );

  const { data } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();
  const last = (await drainScanStream(data.libraryScanStart.id)).at(-1)!;
  expect(last.filesTotal).toBe(1);
  expect(last.scannedTotal).toBe(1);
  expect(last.errorsTotal).toBe(0);
});

test('a file that fails to scan is recorded once, then skipped on the next scan unless forced', async () => {
  await writeFile(path.join(env.LIBRARY_PATH, 'broken.flac'), 'not audio');

  // First scan: the file fails to parse and is counted as an error, never a track.
  const { data: first } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();
  const firstLast = (await drainScanStream(first.libraryScanStart.id)).at(-1)!;
  expect(firstLast.filesTotal).toBe(1);
  expect(firstLast.scannedTotal).toBe(0);
  expect(firstLast.errorsTotal).toBe(1);

  // Second scan: the recorded error makes the scanner skip the file (counted as
  // scanned, not re-attempted), so no error recurs.
  const { data: second } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();
  const secondLast = (await drainScanStream(second.libraryScanStart.id)).at(-1)!;
  expect(secondLast.filesTotal).toBe(1);
  expect(secondLast.scannedTotal).toBe(1);
  expect(secondLast.errorsTotal).toBe(0);

  // A forced scan bypasses the skip and re-attempts the file, so the error surfaces again.
  const { data: forced } = await gqlRequest(app)
    .mutate(LibraryScanStartForceMutation)
    .variables({ force: true })
    .expectNoErrors();
  const forcedLast = (await drainScanStream(forced.libraryScanStart.id)).at(-1)!;
  expect(forcedLast.errorsTotal).toBe(1);
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

  const { data: started } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();
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

  await gqlRequest(app).mutate(LibraryScanCancelMutation).variables({ id }).expectNoErrors();

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

const TrackUpdateMutation = graphql(`
  mutation TrackUpdate($id: ID!, $title: String) {
    trackUpdate(id: $id, title: $title) {
      id
    }
  }
`);

const TrackTitleQuery = graphql(`
  query TrackTitle($id: ID!) {
    track(id: $id) {
      title
    }
  }
`);

const FirstTrackQuery = graphql(`
  query FirstTrack {
    tracks(first: 1) {
      edges {
        node {
          id
        }
      }
    }
  }
`);

test('a rescan preserves a tag override set between scans', async () => {
  await copyFile(path.join(fixturesDir, 'sample.mp3'), path.join(env.LIBRARY_PATH, 'song.mp3'));

  const { data: first } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();
  await drainScanStream(first.libraryScanStart.id);

  const { data: listed } = await gqlRequest(app).query(FirstTrackQuery).expectNoErrors();
  const id = listed.tracks!.edges[0]!.node.id;

  await gqlRequest(app)
    .mutate(TrackUpdateMutation)
    .variables({ id, title: 'My Override' })
    .expectNoErrors();

  const { data: second } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();
  await drainScanStream(second.libraryScanStart.id);

  const { data } = await gqlRequest(app).query(TrackTitleQuery).variables({ id }).expectNoErrors();
  expect(data.track!.title).toBe('My Override');
});

test('Query.libraryScan exposes the in-progress scan and the completed scan within its grace period', async () => {
  await copyFile(path.join(fixturesDir, 'sample.mp3'), path.join(env.LIBRARY_PATH, 'one.mp3'));

  const { data: started } = await gqlRequest(app).mutate(LibraryScanStartMutation).expectNoErrors();

  const { data: inProgressData } = await gqlRequest(app).query(LibraryScanQuery).expectNoErrors();
  expect(inProgressData.libraryScan).not.toBeNull();
  expect(inProgressData.libraryScan!.id).toBe(started.libraryScanStart.id);

  await drainScanStream(started.libraryScanStart.id);

  const { data: afterData } = await gqlRequest(app).query(LibraryScanQuery).expectNoErrors();
  expect(afterData.libraryScan).not.toBeNull();
  expect(afterData.libraryScan!.id).toBe(started.libraryScanStart.id);
  expect(afterData.libraryScan!.isCompleted).toBe(true);
});
