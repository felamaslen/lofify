import { eq, inArray } from 'drizzle-orm';
import type { ID, Int } from 'grats';
import { LRUCache } from 'lru-cache';
import { v4 as uuidv4 } from 'uuid';

import { db } from '../db/client.js';
import { tracks as tracksTable } from '../db/schema/index.js';
import { toGqlTrack } from './track.js';
import {
  clampLimit,
  DEFAULT_PAGE_SIZE,
  queryTrackPage,
  type TrackConnection,
  type TrackEdge,
} from './track-queries.js';
import type { Void } from './types.js';

/** Hard cap on entries per queue, guarding the in-memory store against runaway appends. */
const MAX_QUEUE_LENGTH = 500;
/** Queues are dropped after a day without a write (reads don't extend the lifetime of nothing — `updateAgeOnGet` keeps an actively-played queue alive), and the store holds at most this many before the least-recently-used goes. */
const MAX_QUEUES = 100;
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

/** Every live queue's track-id list, keyed by queue id. In-memory by design: a queue is session-scale state, recreated by the next append if lost. */
const queues = new LRUCache<string, string[]>({
  max: MAX_QUEUES,
  ttl: QUEUE_TTL_MS,
  updateAgeOnGet: true,
});

/**
 * The play order: any explicitly queued tracks, followed by the library continuing in its active order. The queued portion may be empty — a queue is only created by the first append and addressed by `id` from then on; one left unwritten for a day may expire, and appending with an expired or unknown id revives it, empty, under that same id.
 *
 * @gqlType
 */
export type PlaybackQueue = {
  /** Identifier to pass to the queue mutations and `Query.playbackQueue`. Null until a mutation first writes to the queue. @gqlField */
  id: ID | null;
  trackIds: string[];
};

/**
 * The play queue addressed by `id`, or an empty unidentified queue when `id` is omitted or doesn't address one.
 * @gqlQueryField
 * @gqlAnnotate semanticNonNull
 */
export function playbackQueue(id?: ID | null): PlaybackQueue | null {
  const stored = id != null ? queues.get(id) : undefined;
  return id != null && stored ? { id, trackIds: [...stored] } : { id: null, trackIds: [] };
}

/** Resolve queued ids to edges in queue order, duplicates preserved. An entry whose track no longer exists in the library is omitted. */
async function queuedEdges(ids: string[]): Promise<TrackEdge[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(tracksTable)
    .where(inArray(tracksTable.id, [...new Set(ids)]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const edges: TrackEdge[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) edges.push({ node: toGqlTrack(row), cursor: id });
  }
  return edges;
}

/**
 * The explicitly queued tracks, in play order. The same track may be queued more than once; a cursor addresses its first occurrence.
 *
 * @gqlField
 */
export async function tracksQueued(
  queue: PlaybackQueue,
  first?: Int | null,
  last?: Int | null,
  after?: ID | null,
  before?: ID | null,
): Promise<TrackConnection> {
  if (first != null && last != null) {
    throw new Error('Pass either `first` or `last`, not both.');
  }
  const ids = queue.trackIds;
  const isBackward = last != null;
  const limit = clampLimit(isBackward ? last : first) ?? DEFAULT_PAGE_SIZE;
  const cursor = isBackward ? before : after;
  let cursorIndex = -1;
  if (cursor != null) {
    cursorIndex = ids.indexOf(cursor);
    if (cursorIndex < 0) throw new Error('Unknown cursor.');
  }
  const start = isBackward
    ? Math.max(0, (cursor != null ? cursorIndex : ids.length) - limit)
    : cursor != null
      ? cursorIndex + 1
      : 0;
  const end = isBackward ? (cursor != null ? cursorIndex : ids.length) : start + limit;
  const edges = await queuedEdges(ids.slice(start, end));
  return {
    edges,
    pageInfo: {
      hasNextPage: end < ids.length,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
    totalCount: ids.length,
  };
}

/**
 * Every track to be played, in order: the explicitly queued tracks lead, then the library continues in its active order. The filter, duplicate, shuffle, and repeat arguments shape only the library portion; queued tracks always lead a forwards page regardless of `after`, which addresses where the library portion picks up. Backwards pages (`last`/`before`) walk the library back from the cursor and continue into the queued tracks once the start of the library order is reached.
 *
 * @gqlField
 */
export async function tracks(
  queue: PlaybackQueue,
  first?: Int | null,
  last?: Int | null,
  after?: ID | null,
  before?: ID | null,
  /** Restrict the library portion to tracks whose effective artist shares a synonym group with one of these names. Each name may be a canonical artist or any of its registered synonyms; either way the whole group's tracks are returned. An empty or omitted list applies no filter. */
  filterArtistIn?: string[] | null,
  /** Restrict the library portion to tracks whose effective album is one of these names. An empty or omitted list applies no filter. */
  filterAlbumIn?: string[] | null,
  /** Include every duplicate copy of a recording in the library portion. By default only the canonical (highest-quality) copy of each duplicate group is returned. */
  includeDuplicates?: boolean | null,
  /** Seed for a deterministic pseudo-random ordering of the library portion. The same seed always produces the same permutation. */
  shuffleSeed?: string | null,
  /** Track to place first in the shuffled library portion. Requires `shuffleSeed`. */
  shuffleInitialTrackId?: ID | null,
  /** Treat the library portion as cyclic: a page that runs past either end continues from the other end, capped at one full lap. `pageInfo` then reports more pages in both directions whenever any track matches. Queued tracks are not part of the cycle — each plays once. */
  repeat?: boolean | null,
): Promise<TrackConnection> {
  if (first != null && last != null) {
    throw new Error('Pass either `first` or `last`, not both.');
  }
  const libraryOpts = {
    after,
    before,
    filterArtistIn,
    filterAlbumIn,
    includeDuplicates,
    shuffleSeed,
    shuffleInitialTrackId,
    repeat,
  };
  if (last != null) {
    const limit = clampLimit(last) ?? DEFAULT_PAGE_SIZE;
    const page = await queryTrackPage({ ...libraryOpts, last });
    // The queued tracks precede the library in the order, so a backwards page that exhausts the
    // library's start continues into the queue's tail.
    const need = limit - page.edges.length;
    const tailIds = need > 0 ? queue.trackIds.slice(Math.max(0, queue.trackIds.length - need)) : [];
    const edges = [...(await queuedEdges(tailIds)), ...page.edges];
    return {
      edges,
      pageInfo: {
        hasNextPage: page.pageInfo.hasNextPage,
        hasPreviousPage: tailIds.length < queue.trackIds.length || page.pageInfo.hasPreviousPage,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges.at(-1)?.cursor ?? null,
      },
      totalCount: queue.trackIds.length + page.totalCount,
    };
  }
  const limit = clampLimit(first) ?? DEFAULT_PAGE_SIZE;
  const taken = queue.trackIds.slice(0, limit);
  const head = await queuedEdges(taken);
  const library = await queryTrackPage({ ...libraryOpts, first: limit - taken.length });
  const edges = [...head, ...library.edges];
  return {
    edges,
    pageInfo: {
      hasNextPage: taken.length < queue.trackIds.length || library.pageInfo.hasNextPage,
      hasPreviousPage: library.pageInfo.hasPreviousPage,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
    totalCount: queue.trackIds.length + library.totalCount,
  };
}

/**
 * Append a track to the end of a queue. Omitting `queueId` creates a queue; the returned `id` addresses it from then on. An expired or unknown `queueId` revives that queue, empty, under the same id.
 *
 * @gqlMutationField
 */
export async function queueAppend(trackId: ID, queueId?: ID | null): Promise<PlaybackQueue> {
  const exists = await db
    .select({ id: tracksTable.id })
    .from(tracksTable)
    .where(eq(tracksTable.id, trackId))
    .limit(1);
  if (exists.length === 0) throw new Error('Unknown track.');
  const id = queueId ?? uuidv4();
  const ids = queues.get(id) ?? [];
  if (ids.length >= MAX_QUEUE_LENGTH) {
    throw new Error(`A queue holds at most ${MAX_QUEUE_LENGTH} tracks.`);
  }
  const next = [...ids, trackId];
  queues.set(id, next);
  return { id, trackIds: next };
}

/**
 * Remove the queue entry at `index`, which must currently hold `trackId` — the pairing guards against removing a different entry when the queue changed since it was last read.
 *
 * @gqlMutationField
 */
export function queueRemove(id: ID, trackId: ID, index: Int): PlaybackQueue {
  const ids = queues.get(id) ?? [];
  if (ids[index] !== trackId) {
    throw new Error(`The queue entry at index ${index} is not the given track.`);
  }
  const next = [...ids.slice(0, index), ...ids.slice(index + 1)];
  queues.set(id, next);
  return { id, trackIds: next };
}

/**
 * Move the queue entry at `fromIndex`, which must currently hold `trackId`, to `toIndex`. Errors when `toIndex` falls outside the queue; a move onto its own position is a no-op.
 *
 * @gqlMutationField
 */
export function queueReorder(id: ID, trackId: ID, fromIndex: Int, toIndex: Int): PlaybackQueue {
  const ids = [...(queues.get(id) ?? [])];
  if (ids[fromIndex] !== trackId) {
    throw new Error(`The queue entry at index ${fromIndex} is not the given track.`);
  }
  if (toIndex < 0 || toIndex >= ids.length) {
    throw new Error('`toIndex` falls outside the queue.');
  }
  if (toIndex !== fromIndex) {
    ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, trackId);
    queues.set(id, ids);
  }
  return { id, trackIds: ids };
}

/**
 * Drop every entry of the queue. Idempotent; the id remains usable for later appends.
 *
 * @gqlMutationField
 */
export function queueClear(id: ID): Void {
  queues.delete(id);
  return {};
}
