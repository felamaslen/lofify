/**
 * IndexedDB-backed cache for fetched audio chunk bytes, keyed by playback URL + byte range.
 *
 * The browser's HTTP cache can't do this natively: it never stores `206 Partial Content` responses from `fetch()`, and it can only answer a `Range` request by slicing a *complete* cached body — which never exists here, because the player only ever requests ranges. So chunk re-use across replays, seek-backs and PWA launches has to happen at this layer.
 *
 * Storage is capped at `MAX_TOTAL_BYTES`; once over budget, the oldest-stored entries are evicted first. A running byte total is kept in a separate `meta` store and updated in the same transaction as every write, so concurrent tabs stay consistent. Every operation is failure-tolerant — an unavailable or broken IndexedDB (private browsing, quota, corruption) degrades to plain network fetches, never an error.
 */

export type CachedChunk = { data: Uint8Array; quality: string | null };

type ChunkRecord = {
  key: string;
  data: Uint8Array;
  /** `X-Quality` of the cached bytes, replayed on hits so the player's quality reporting works without a network response. */
  quality: string | null;
  size: number;
  /** Insertion timestamp driving oldest-first eviction. */
  storedAt: number;
};

const DB_NAME = 'lofify-chunk-cache';
const DB_VERSION = 1;
const CHUNK_STORE = 'chunks';
const META_STORE = 'meta';
const TOTAL_KEY = 'totalBytes';
/** Byte budget for cached chunks — roughly 15–20 hours of audio at typical lossy tiers. */
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const chunks = db.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
        chunks.createIndex('storedAt', 'storedAt');
        db.createObjectStore(META_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Drop the memoised connection when the browser closes it (storage pressure, or another
        // tab upgrading the schema), so the next operation re-opens instead of failing forever.
        db.onclose = () => {
          dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function requested<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function chunkKey(url: string, byteStart: number, byteEnd: number): string {
  return `${url}#${byteStart}-${byteEnd}`;
}

/** Byte ranges (`[byteStart, byteEnd)`) of every chunk stored for `url`, via one keys-only query — no chunk bodies are read. All of a URL's keys share the `${url}#` prefix, so a single key-range scan covers the whole track at that tier. Lets the player light up its cached-regions layer the moment a track loads, instead of discovering entries one by one. */
export async function listCachedRanges(
  url: string,
): Promise<{ byteStart: number; byteEnd: number }[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const prefix = `${url}#`;
    // U+FFFF sorts above every code unit a key suffix can contain, so the bound spans all
    // `${url}#…` keys.
    const keys = (await requested(
      tx.objectStore(CHUNK_STORE).getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`)),
    )) as string[];
    const out: { byteStart: number; byteEnd: number }[] = [];
    for (const key of keys) {
      const m = /#(\d+)-(\d+)$/.exec(key);
      if (m) out.push({ byteStart: Number(m[1]), byteEnd: Number(m[2]) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Cached bytes for `[byteStart, byteEnd)` of `url`, or `null` on a miss (or any IndexedDB failure). */
export async function readCachedChunk(
  url: string,
  byteStart: number,
  byteEnd: number,
): Promise<CachedChunk | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const record = (await requested(
      tx.objectStore(CHUNK_STORE).get(chunkKey(url, byteStart, byteEnd)),
    )) as ChunkRecord | undefined;
    if (!record) return null;
    return { data: record.data, quality: record.quality };
  } catch {
    return null;
  }
}

/** Store `data` for `[byteStart, byteEnd)` of `url`, then evict oldest entries until the cache fits the byte budget. Best-effort: failures are swallowed and just mean a future network fetch. */
export async function storeCachedChunk(
  url: string,
  byteStart: number,
  byteEnd: number,
  data: Uint8Array,
  quality: string | null,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const key = chunkKey(url, byteStart, byteEnd);
    const tx = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
    const chunks = tx.objectStore(CHUNK_STORE);
    const meta = tx.objectStore(META_STORE);
    const [existing, storedTotal] = await Promise.all([
      requested(chunks.get(key)) as Promise<ChunkRecord | undefined>,
      requested(meta.get(TOTAL_KEY)) as Promise<number | undefined>,
    ]);
    let total = (storedTotal ?? 0) - (existing?.size ?? 0) + data.byteLength;
    // Structured clone keeps a view's whole underlying buffer, and consumers append
    // `data.buffer` wholesale — so only store views that exactly span their buffer.
    const exact =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
    const record: ChunkRecord = {
      key,
      data: exact,
      quality,
      size: data.byteLength,
      storedAt: Date.now(),
    };
    await requested(chunks.put(record));
    if (total > MAX_TOTAL_BYTES) {
      await new Promise<void>((resolve, reject) => {
        const cursorReq = chunks.index('storedAt').openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || total <= MAX_TOTAL_BYTES) {
            resolve();
            return;
          }
          const candidate = cursor.value as ChunkRecord;
          if (candidate.key !== key) {
            total -= candidate.size;
            cursor.delete();
          }
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('IndexedDB cursor failed'));
      });
    }
    await requested(meta.put(total, TOTAL_KEY));
  } catch {
    // Cache writes are best-effort; the chunk just stays network-only.
  }
}
