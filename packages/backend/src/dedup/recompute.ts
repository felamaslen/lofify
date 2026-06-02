/**
 * Maintains the `trackIdDeduplicated`/`priority` columns that collapse identical recordings to a single canonical source. A duplicate group is every track sharing a case-folded, trimmed `(title, artist, album)`; within a group the highest-quality copy (see `compareQuality`) is canonical at priority 0. Untitled rows are never grouped.
 *
 * Recompute runs whenever a row's tags or files change (scan, watch, tag edit). Each group is recomputed under a per-key advisory lock so concurrent scanner workers can't race, and membership is cleared before it is reassigned so no foreign-key reference to a row dangles mid-update.
 */

import { and, eq, type SQL, sql } from 'drizzle-orm';

import { type Db, db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { compareQuality } from '../graphql/quality.js';

/** A transaction handle, as handed to `db.transaction`'s callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A normalised duplicate-group key. All fields are lower-cased and trimmed; `title` is always non-empty. */
export type DedupKey = { title: string; artist: string; album: string };

/** The row fields needed to derive a dedup key. */
type KeyRow = {
  title: string | null;
  titleOverride: string | null;
  artist: string | null;
  artistOverride: string | null;
  album: string | null;
  albumOverride: string | null;
};

function normalise(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** The duplicate-group key for a row, from its effective (override-aware) tags. Null when the effective title is empty; untitled rows are never grouped. */
export function dedupKeyOf(row: KeyRow): DedupKey | null {
  const title = normalise(row.titleOverride ?? row.title);
  if (title === '') return null;
  return {
    title,
    artist: normalise(row.artistOverride ?? row.artist),
    album: normalise(row.albumOverride ?? row.album),
  };
}

const effTitle = sql`lower(trim(coalesce(${tracks.titleOverride}, ${tracks.title}, '')))`;
const effArtist = sql`lower(trim(coalesce(${tracks.artistOverride}, ${tracks.artist}, '')))`;
const effAlbum = sql`lower(trim(coalesce(${tracks.albumOverride}, ${tracks.album}, '')))`;

/** Rows whose effective tags match `key`. */
function matchKey(key: DedupKey): SQL {
  return and(
    sql`${effTitle} = ${key.title}`,
    sql`${effArtist} = ${key.artist}`,
    sql`${effAlbum} = ${key.album}`,
  )!;
}

/** An unambiguous string form of a key, for deduping keys and as the advisory-lock token. JSON-encodes the fields so distinct keys can't collide by concatenation. */
function keyId(key: DedupKey): string {
  return JSON.stringify([key.title, key.artist, key.album]);
}

/** Hold a transaction-scoped advisory lock for `key`, serialising recomputes of the same group. */
async function lockGroup(tx: Tx, key: DedupKey): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${keyId(key)}, 0))`);
}

/** Null the dedup columns of every member of `key`, dropping all in-group foreign-key references. */
async function clearGroup(tx: Tx, key: DedupKey): Promise<void> {
  await tx.update(tracks).set({ trackIdDeduplicated: null, priority: null }).where(matchKey(key));
}

/** Re-rank the surviving members of `key`: a singleton stays cleared, otherwise the canonical (best) copy takes priority 0 and the rest follow in quality order. Assumes the group was just cleared. */
async function assignGroup(tx: Tx, key: DedupKey): Promise<void> {
  const members = await tx
    .select({
      id: tracks.id,
      codec: tracks.codec,
      isLossless: tracks.isLossless,
      bitRate: tracks.bitRate,
      bitDepth: tracks.bitDepth,
      sampleRate: tracks.sampleRate,
      sizeBytes: tracks.sizeBytes,
      durationSeconds: tracks.durationSeconds,
    })
    .from(tracks)
    .where(matchKey(key));
  if (members.length < 2) return;

  const sorted = members.slice().sort((a, b) => compareQuality(a, b) || a.id.localeCompare(b.id));
  const canonicalId = sorted[0]!.id;
  for (let priority = 0; priority < sorted.length; priority++) {
    await tx
      .update(tracks)
      .set({ trackIdDeduplicated: canonicalId, priority })
      .where(eq(tracks.id, sorted[priority]!.id));
  }
}

/** Distinct non-null keys, in first-seen order. */
function uniqueKeys(keys: (DedupKey | null)[]): DedupKey[] {
  const byId = new Map<string, DedupKey>();
  for (const key of keys) {
    if (key) byId.set(keyId(key), key);
  }
  return [...byId.values()];
}

/** Recompute every distinct group in `keys` within an existing transaction. */
export async function recomputeKeysInTx(tx: Tx, keys: (DedupKey | null)[]): Promise<void> {
  for (const key of uniqueKeys(keys)) {
    await lockGroup(tx, key);
    await clearGroup(tx, key);
    await assignGroup(tx, key);
  }
}

/** Recompute every distinct group in `keys` in its own transaction. */
export async function recomputeDedupGroups(keys: (DedupKey | null)[]): Promise<void> {
  await db.transaction((tx) => recomputeKeysInTx(tx, keys));
}

/** Delete the row keyed by absolute path and re-rank whatever duplicate group it belonged to. Clears the group before deleting so a canonical row referenced by its peers can be removed without a foreign-key violation. */
export async function deleteTrackAndRecompute(file: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        title: tracks.title,
        titleOverride: tracks.titleOverride,
        artist: tracks.artist,
        artistOverride: tracks.artistOverride,
        album: tracks.album,
        albumOverride: tracks.albumOverride,
      })
      .from(tracks)
      .where(eq(tracks.file, file))
      .limit(1);
    const key = rows[0] ? dedupKeyOf(rows[0]) : null;
    if (key) {
      await lockGroup(tx, key);
      await clearGroup(tx, key);
    }
    await tx.delete(tracks).where(eq(tracks.file, file));
    if (key) await assignGroup(tx, key);
  });
}
