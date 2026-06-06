import { randomUUID } from 'node:crypto';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { graphql } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

beforeEach(async () => {
  await db.delete(tracks);
});

const QueueAppendDocument = graphql(`
  mutation QueueAppend($trackId: ID!, $queueId: ID) {
    queueAppend(trackId: $trackId, queueId: $queueId) {
      id
      tracksQueued(first: 100) {
        totalCount
        edges {
          node {
            id
          }
        }
      }
    }
  }
`);

const QueueRemoveDocument = graphql(`
  mutation QueueRemove($id: ID!, $trackId: ID!, $index: Int!) {
    queueRemove(id: $id, trackId: $trackId, index: $index) {
      id
      tracksQueued(first: 100) {
        edges {
          node {
            id
          }
        }
      }
    }
  }
`);

const QueueReorderDocument = graphql(`
  mutation QueueReorder($id: ID!, $trackId: ID!, $fromIndex: Int!, $toIndex: Int!) {
    queueReorder(id: $id, trackId: $trackId, fromIndex: $fromIndex, toIndex: $toIndex) {
      id
      tracksQueued(first: 100) {
        edges {
          node {
            id
          }
        }
      }
    }
  }
`);

const QueueClearDocument = graphql(`
  mutation QueueClear($id: ID!) {
    queueClear(id: $id) {
      _
    }
  }
`);

const PlaybackQueueDocument = graphql(`
  query PlaybackQueueView(
    $id: ID
    $first: Int
    $last: Int
    $after: ID
    $before: ID
    $queuedFirst: Int
    $queuedAfter: ID
  ) {
    playbackQueue(id: $id) {
      id
      tracksQueued(first: $queuedFirst, after: $queuedAfter) {
        totalCount
        pageInfo {
          hasNextPage
          hasPreviousPage
        }
        edges {
          node {
            id
          }
        }
      }
      tracks(first: $first, last: $last, after: $after, before: $before) {
        totalCount
        pageInfo {
          hasNextPage
          hasPreviousPage
        }
        edges {
          node {
            id
          }
        }
      }
    }
  }
`);

async function seed(count: number): Promise<void> {
  await db.insert(tracks).values(
    Array.from({ length: count }, (_, i) => ({
      title: `t${i}`,
      trackNumber: i + 1,
      discNumber: 1,
      artist: 'A',
      album: 'Album',
      year: null,
      format: 'mp3',
      codec: 'mp3',
      bitRate: null,
      sampleRate: 44_100,
      isLossless: false,
      file: `/library/A/Album/t${i}.mp3`,
      sizeBytes: 1024,
      durationSeconds: 100,
      sourceMtime: new Date(0),
    })),
  );
}

async function libraryIds(): Promise<string[]> {
  const { data } = await gqlRequest(app)
    .query(PlaybackQueueDocument)
    .variables({
      id: null,
      first: 100,
      last: null,
      after: null,
      before: null,
      queuedFirst: null,
      queuedAfter: null,
    })
    .expectNoErrors();
  return data.playbackQueue!.tracks.edges.map((e) => e.node.id);
}

async function append(trackId: string, queueId: string | null): Promise<string> {
  const { data } = await gqlRequest(app)
    .query(QueueAppendDocument)
    .variables({ trackId, queueId })
    .expectNoErrors();
  return data.queueAppend.id!;
}

type View = {
  id: string | null;
  queued: string[];
  tracks: string[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

async function view(id: string | null, vars: Partial<Record<string, unknown>> = {}): Promise<View> {
  const { data } = await gqlRequest(app)
    .query(PlaybackQueueDocument)
    .variables({
      id,
      first: 100,
      last: null,
      after: null,
      before: null,
      queuedFirst: 100,
      queuedAfter: null,
      ...vars,
    })
    .expectNoErrors();
  const q = data.playbackQueue!;
  return {
    id: q.id,
    queued: q.tracksQueued.edges.map((e) => e.node.id),
    tracks: q.tracks.edges.map((e) => e.node.id),
    hasNextPage: q.tracks.pageInfo.hasNextPage,
    hasPreviousPage: q.tracks.pageInfo.hasPreviousPage,
  };
}

test('Mutation.queueAppend materialises a queue and grows it', async () => {
  await seed(3);
  const lib = await libraryIds();
  const id = await append(lib[1]!, null);
  expect(id).toBeTruthy();
  await append(lib[2]!, id);
  const v = await view(id);
  expect(v.id).toBe(id);
  expect(v.queued).toEqual([lib[1]!, lib[2]!]);
});

test('Mutation.queueAppend with an unknown queue id revives it under that id', async () => {
  await seed(2);
  const lib = await libraryIds();
  const ghost = randomUUID();
  const id = await append(lib[0]!, ghost);
  expect(id).toBe(ghost);
  expect((await view(ghost)).queued).toEqual([lib[0]!]);
});

test('Mutation.queueAppend rejects an unknown track', async () => {
  await seed(1);
  const { errors } = await gqlRequest(app)
    .query(QueueAppendDocument)
    .variables({ trackId: randomUUID(), queueId: null })
    .expectErrors();
  expect(errors[0]!.message).toContain('Unknown track');
});

test('Mutation.queueAppend caps the queue length', async () => {
  await seed(1);
  const lib = await libraryIds();
  let id: string | null = null;
  for (let i = 0; i < 500; i++) id = await append(lib[0]!, id);
  const { errors } = await gqlRequest(app)
    .query(QueueAppendDocument)
    .variables({ trackId: lib[0]!, queueId: id })
    .expectErrors();
  expect(errors[0]!.message).toContain('at most 500');
});

test('Mutation.queueRemove removes the matching entry and guards the pairing', async () => {
  await seed(3);
  const [a, b] = await libraryIds();
  let id = await append(a!, null);
  id = await append(b!, id);
  id = await append(a!, id);

  const { errors } = await gqlRequest(app)
    .query(QueueRemoveDocument)
    .variables({ id, trackId: b!, index: 0 })
    .expectErrors();
  expect(errors[0]!.message).toContain('is not the given track');

  const { data } = await gqlRequest(app)
    .query(QueueRemoveDocument)
    .variables({ id, trackId: a!, index: 2 })
    .expectNoErrors();
  expect(data.queueRemove.tracksQueued.edges.map((e) => e.node.id)).toEqual([a!, b!]);
});

test('Mutation.queueReorder moves an entry, guards the pairing and bounds, noops in place', async () => {
  await seed(3);
  const [a, b, c] = await libraryIds();
  let id = await append(a!, null);
  id = await append(b!, id);
  id = await append(c!, id);

  const moved = await gqlRequest(app)
    .query(QueueReorderDocument)
    .variables({ id, trackId: c!, fromIndex: 2, toIndex: 0 })
    .expectNoErrors();
  expect(moved.data.queueReorder.tracksQueued.edges.map((e) => e.node.id)).toEqual([c!, a!, b!]);

  const mismatch = await gqlRequest(app)
    .query(QueueReorderDocument)
    .variables({ id, trackId: b!, fromIndex: 0, toIndex: 1 })
    .expectErrors();
  expect(mismatch.errors[0]!.message).toContain('is not the given track');

  const bounds = await gqlRequest(app)
    .query(QueueReorderDocument)
    .variables({ id, trackId: c!, fromIndex: 0, toIndex: 3 })
    .expectErrors();
  expect(bounds.errors[0]!.message).toContain('outside the queue');

  const noop = await gqlRequest(app)
    .query(QueueReorderDocument)
    .variables({ id, trackId: c!, fromIndex: 0, toIndex: 0 })
    .expectNoErrors();
  expect(noop.data.queueReorder.tracksQueued.edges.map((e) => e.node.id)).toEqual([c!, a!, b!]);
});

test('Mutation.queueClear drops the queue and the id stays usable', async () => {
  await seed(2);
  const [a] = await libraryIds();
  const id = await append(a!, null);
  await gqlRequest(app).query(QueueClearDocument).variables({ id }).expectNoErrors();
  const cleared = await view(id);
  expect(cleared.id).toBeNull();
  expect(cleared.queued).toEqual([]);
  expect(await append(a!, id)).toBe(id);
});

test('Query.playbackQueue without an id resolves an empty unidentified queue over the library', async () => {
  await seed(3);
  const lib = await libraryIds();
  const v = await view(null);
  expect(v.id).toBeNull();
  expect(v.queued).toEqual([]);
  expect(v.tracks).toEqual(lib);
});

test('PlaybackQueue.tracks leads with the queue regardless of the cursor', async () => {
  await seed(5);
  const lib = await libraryIds();
  let id = await append(lib[4]!, null);
  id = await append(lib[1]!, id);

  const stepped = await view(id, { first: 1, after: lib[0]! });
  expect(stepped.tracks).toEqual([lib[4]!]);

  const full = await view(id, { first: 100, after: lib[0]! });
  expect(full.tracks).toEqual([lib[4]!, lib[1]!, ...lib.slice(1)]);
  expect(full.hasNextPage).toBe(false);
});

test('PlaybackQueue.tracks drains to the library continuation after the cursor', async () => {
  await seed(4);
  const lib = await libraryIds();
  const id = await append(lib[3]!, null);
  await gqlRequest(app)
    .query(QueueRemoveDocument)
    .variables({ id, trackId: lib[3]!, index: 0 })
    .expectNoErrors();
  const v = await view(id, { first: 1, after: lib[1]! });
  expect(v.tracks).toEqual([lib[2]!]);
});

test('PlaybackQueue.tracks slices across the seam and reports the remainder', async () => {
  await seed(4);
  const lib = await libraryIds();
  let id = await append(lib[0]!, null);
  id = await append(lib[1]!, id);
  id = await append(lib[2]!, id);

  const queueOnly = await view(id, { first: 2 });
  expect(queueOnly.tracks).toEqual([lib[0]!, lib[1]!]);
  expect(queueOnly.hasNextPage).toBe(true);

  const acrossSeam = await view(id, { first: 4, after: lib[2]! });
  expect(acrossSeam.tracks).toEqual([lib[0]!, lib[1]!, lib[2]!, lib[3]!]);
});

test('PlaybackQueue.tracks backward pages continue into the queue tail past the library start', async () => {
  await seed(3);
  const lib = await libraryIds();
  const id = await append(lib[2]!, null);

  const libOnly = await view(id, { first: null, last: 1, before: lib[1]! });
  expect(libOnly.tracks).toEqual([lib[0]!]);
  expect(libOnly.hasPreviousPage).toBe(true);

  const acrossSeam = await view(id, { first: null, last: 2, before: lib[1]! });
  expect(acrossSeam.tracks).toEqual([lib[2]!, lib[0]!]);
  expect(acrossSeam.hasPreviousPage).toBe(false);

  const queueOnly = await view(id, { first: null, last: 1, before: lib[0]! });
  expect(queueOnly.tracks).toEqual([lib[2]!]);
  expect(queueOnly.hasPreviousPage).toBe(false);
});

test('PlaybackQueue.tracks totalCount sums the queue and the library', async () => {
  await seed(3);
  const lib = await libraryIds();
  let id = await append(lib[0]!, null);
  id = await append(lib[0]!, id);
  const { data } = await gqlRequest(app)
    .query(PlaybackQueueDocument)
    .variables({
      id,
      first: 1,
      last: null,
      after: null,
      before: null,
      queuedFirst: 100,
      queuedAfter: null,
    })
    .expectNoErrors();
  expect(data.playbackQueue!.tracks.totalCount).toBe(5);
});

test('PlaybackQueue.tracksQueued paginates the queue, duplicates included', async () => {
  await seed(3);
  const [a, b] = await libraryIds();
  let id = await append(a!, null);
  id = await append(b!, id);
  id = await append(a!, id);

  const all = await view(id);
  expect(all.queued).toEqual([a!, b!, a!]);

  const { data } = await gqlRequest(app)
    .query(PlaybackQueueDocument)
    .variables({
      id,
      first: 1,
      last: null,
      after: null,
      before: null,
      queuedFirst: 2,
      queuedAfter: a!,
    })
    .expectNoErrors();
  const page = data.playbackQueue!.tracksQueued;
  expect(page.edges.map((e) => e.node.id)).toEqual([b!, a!]);
  expect(page.pageInfo.hasPreviousPage).toBe(true);
  expect(page.pageInfo.hasNextPage).toBe(false);
});
