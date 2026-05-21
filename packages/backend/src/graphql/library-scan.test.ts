import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import gql from 'fake-tag';
import { createClient, type Client } from 'graphql-sse';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { env } from '../env.js';
import { gqlRequest, makeApp } from '../test/inject.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scanner/__fixtures__',
);

let app: FastifyInstance;
let sseClient: Client;

beforeAll(async () => {
  app = await makeApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  sseClient = createClient({ url: `http://127.0.0.1:${addr.port}/graphql/stream` });
});

afterAll(async () => {
  sseClient.dispose();
  await app.close();
});

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

type LibraryScanFrame = {
  id: string;
  filesTotal: number | null;
  scannedTotal: number;
  errorsTotal: number;
};

const LIBRARY_SCAN_MUTATION = gql`
  mutation {
    libraryScan {
      id
      filesTotal
      scannedTotal
      errorsTotal
    }
  }
`;

const LIBRARY_SCAN_SUBSCRIPTION = gql`
  subscription ($id: ID!) {
    libraryScan(id: $id) {
      id
      filesTotal
      scannedTotal
      errorsTotal
    }
  }
`;

async function drainScanStream(scanId: string): Promise<LibraryScanFrame[]> {
  const frames: LibraryScanFrame[] = [];
  await new Promise<void>((resolve, reject) => {
    sseClient.subscribe<{ libraryScan: LibraryScanFrame }>(
      { query: LIBRARY_SCAN_SUBSCRIPTION, variables: { id: scanId } },
      {
        next: (msg) => {
          if (msg.data?.libraryScan) frames.push(msg.data.libraryScan);
        },
        error: reject,
        complete: resolve,
      },
    );
  });
  return frames;
}

test('Mutation.libraryScan returns immediately with filesTotal: null', async () => {
  await copyFile(
    path.join(fixturesDir, 'sample.mp3'),
    path.join(env.LIBRARY_PATH, 'one.mp3'),
  );
  await copyFile(
    path.join(fixturesDir, 'sample.flac'),
    path.join(env.LIBRARY_PATH, 'two.flac'),
  );

  const body = await gqlRequest(app, LIBRARY_SCAN_MUTATION);
  expect(body.errors).toBeUndefined();
  const scan = (body.data as { libraryScan: LibraryScanFrame }).libraryScan;
  expect(typeof scan.id).toBe('string');
  expect(scan.filesTotal).toBeNull();
  expect(scan.scannedTotal).toBe(0);
  expect(scan.errorsTotal).toBe(0);

  await drainScanStream(scan.id);
});

test('Subscription.libraryScan emits progress and terminates', async () => {
  await copyFile(
    path.join(fixturesDir, 'sample.mp3'),
    path.join(env.LIBRARY_PATH, 'one.mp3'),
  );

  const body = await gqlRequest(app, LIBRARY_SCAN_MUTATION);
  expect(body.errors).toBeUndefined();
  const { id, filesTotal } = (body.data as { libraryScan: LibraryScanFrame })
    .libraryScan;
  expect(filesTotal).toBeNull();

  const frames = await drainScanStream(id);
  expect(frames.length).toBeGreaterThan(0);
  const last = frames.at(-1)!;
  expect(last.id).toBe(id);
  expect(last.filesTotal).toBe(1);
  expect(last.scannedTotal).toBe(1);
});
