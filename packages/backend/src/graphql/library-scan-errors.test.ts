import { copyFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { scanErrors, tracks } from '../db/schema/index.js';
import { env } from '../env.js';
import { TEST__clearScans } from '../scanner/runner.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scanner/__fixtures__',
);

async function clearLibrary() {
  for (const entry of await readdir(env.LIBRARY_PATH)) {
    await rm(path.join(env.LIBRARY_PATH, entry), { recursive: true, force: true });
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

const StartScan = graphql(`
  mutation StartScan {
    libraryScanStart {
      id
    }
  }
`);

const ScanProgress = graphql(`
  subscription ScanProgress($id: ID!) {
    libraryScan(id: $id) {
      isCompleted
    }
  }
`);

const ScanErrorsQuery = graphql(`
  query ScanErrors($first: Int, $after: ID) {
    libraryScanErrors(first: $first, after: $after) {
      totalCount
      edges {
        cursor
        node {
          id
          filename
          message
          attemptedAt
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`);

const RetryError = graphql(`
  mutation RetryError($id: ID!) {
    libraryScanErrorRetry(id: $id) {
      _
    }
  }
`);

const DismissError = graphql(`
  mutation DismissError($id: ID!) {
    libraryScanErrorDismiss(id: $id) {
      _
    }
  }
`);

const TrackCount = graphql(`
  query TrackCount {
    tracks(first: 50) {
      totalCount
    }
  }
`);

/** Run a full scan to completion. */
async function runScan(): Promise<void> {
  const { data } = await gqlRequest(app).mutate(StartScan).expectNoErrors();
  for await (const event of gqlRequest(app)
    .subscribe(ScanProgress)
    .variables({ id: data.libraryScanStart.id })) {
    void event;
  }
}

test('a failed file is exposed via Query.libraryScanErrors', async () => {
  await writeFile(path.join(env.LIBRARY_PATH, 'broken.flac'), 'not audio');
  await runScan();

  const { data } = await gqlRequest(app).query(ScanErrorsQuery).variables({}).expectNoErrors();
  const conn = data.libraryScanErrors!;
  expect(conn.totalCount).toBe(1);
  expect(conn.edges).toHaveLength(1);
  const node = conn.edges[0]!.node;
  expect(node.filename).toBe(path.join(env.LIBRARY_PATH, 'broken.flac'));
  expect(node.message).toBe('Unknown error');
  expect(node.attemptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('Mutation.libraryScanErrorDismiss removes the error without creating a track', async () => {
  await writeFile(path.join(env.LIBRARY_PATH, 'broken.flac'), 'not audio');
  await runScan();

  const { data: before } = await gqlRequest(app)
    .query(ScanErrorsQuery)
    .variables({})
    .expectNoErrors();
  const id = before.libraryScanErrors!.edges[0]!.node.id;

  await gqlRequest(app).mutate(DismissError).variables({ id }).expectNoErrors();

  const { data: after } = await gqlRequest(app)
    .query(ScanErrorsQuery)
    .variables({})
    .expectNoErrors();
  expect(after.libraryScanErrors!.totalCount).toBe(0);

  const { data: trackData } = await gqlRequest(app).query(TrackCount).expectNoErrors();
  expect(trackData.tracks!.totalCount).toBe(0);
});

test('Mutation.libraryScanErrorRetry clears the error and ingests the file once it is readable', async () => {
  const target = path.join(env.LIBRARY_PATH, 'broken.flac');
  await writeFile(target, 'not audio');
  await runScan();

  const { data: before } = await gqlRequest(app)
    .query(ScanErrorsQuery)
    .variables({})
    .expectNoErrors();
  const id = before.libraryScanErrors!.edges[0]!.node.id;

  // Replace the unreadable file with valid audio, then retry.
  await copyFile(path.join(fixturesDir, 'sample.flac'), target);
  await gqlRequest(app).mutate(RetryError).variables({ id }).expectNoErrors();

  const { data: after } = await gqlRequest(app)
    .query(ScanErrorsQuery)
    .variables({})
    .expectNoErrors();
  expect(after.libraryScanErrors!.totalCount).toBe(0);

  const { data: trackData } = await gqlRequest(app).query(TrackCount).expectNoErrors();
  expect(trackData.tracks!.totalCount).toBe(1);
});

test('Mutation.libraryScanErrorRetry refreshes the error when the file still fails', async () => {
  await writeFile(path.join(env.LIBRARY_PATH, 'broken.flac'), 'not audio');
  await runScan();

  const { data: before } = await gqlRequest(app)
    .query(ScanErrorsQuery)
    .variables({})
    .expectNoErrors();
  const id = before.libraryScanErrors!.edges[0]!.node.id;

  await gqlRequest(app).mutate(RetryError).variables({ id }).expectNoErrors();

  const { data: after } = await gqlRequest(app)
    .query(ScanErrorsQuery)
    .variables({})
    .expectNoErrors();
  expect(after.libraryScanErrors!.totalCount).toBe(1);
  expect(after.libraryScanErrors!.edges[0]!.node.filename).toBe(
    path.join(env.LIBRARY_PATH, 'broken.flac'),
  );
});

test('Query.libraryScanErrors paginates with first/after', async () => {
  for (const name of ['a.flac', 'b.flac', 'c.flac']) {
    await writeFile(path.join(env.LIBRARY_PATH, name), 'not audio');
  }
  await runScan();

  const { data: page1 } = await gqlRequest(app)
    .query(ScanErrorsQuery)
    .variables({ first: 2 })
    .expectNoErrors();
  const conn1 = page1.libraryScanErrors!;
  expect(conn1.totalCount).toBe(3);
  expect(conn1.edges).toHaveLength(2);
  expect(conn1.pageInfo.hasNextPage).toBe(true);

  const { data: page2 } = await gqlRequest(app)
    .query(ScanErrorsQuery)
    .variables({ first: 2, after: conn1.pageInfo.endCursor })
    .expectNoErrors();
  const conn2 = page2.libraryScanErrors!;
  expect(conn2.edges).toHaveLength(1);
  expect(conn2.pageInfo.hasNextPage).toBe(false);

  const ids = new Set([...conn1.edges, ...conn2.edges].map((e) => e.node.id));
  expect(ids.size).toBe(3);
});
