# @lofify/backend

The TypeScript monolith. Hosts the GraphQL API, the playback HTTP
endpoint, the library scanner, and the database schema + migrations.

## Layout

```
src/
  app.ts        buildApp(): Fastify with /healthz, /graphql,
                /graphql/stream. No listener bound — used by tests.
  config.ts     Static code-level constants (chunk duration, etc.).
  disk-cache.ts Disk-cache root layout (transcode/ + artwork/ under
                DISK_CACHE_DIR), startup writability check, and the
                one-time legacy-entry move into transcode/.
  graphql/      GraphQL schema (grats source) and resolvers.
  db/           Drizzle schema, migrations, and shared pg pool.
  scanner/      Library scan + chokidar watcher (in-process). A scan
                walks every library root, classifies discovered files
                against `Tracks` in batches, and feeds a priority queue:
                new files are parsed first, changed files next, and
                unchanged files are skipped. Files that failed a previous
                read are recorded in `ScanErrors` and skipped until
                retried by hand; `force` re-attempts them.
  playback/     `/play/...` HTTP route, HMAC-signed URLs, unified
                per-entry encoded cache (.bin + .idx live-tail), and
                ffmpeg encoder.
  artwork/      `/artwork/:id` HTTP route serving downloaded album-art
                images from the disk cache.
  test/         Vitest behavioural tests driven by fastify.inject.
```

## Scripts

| Script               | What it does                                            |
| -------------------- | ------------------------------------------------------- |
| `dev`                | `tsx watch src/index.ts` — boots the server             |
| `start`              | Production-style boot (no watch)                        |
| `test`               | `vitest run` (behavioural tests via fastify.inject)     |
| `typecheck`          | `tsc --noEmit`                                          |
| `codegen`            | All code generators (`db:generate`, `gql:generate`)     |
| `db:generate`        | Drizzle schema → `src/db/__generated__/schema.sql`      |
| `gql:generate`       | grats → `src/graphql/__generated__/schema.{ts,graphql}` |
| `db:migrate`         | Apply pending migrations                                |
| `db:migrate:create`  | Diff schema vs. applied migrations, write new SQL       |
| `db:migrate:list`    | Show migration history                                  |
| `db:migrate:pending` | Show pending migrations                                 |

## Adding a migration

```sh
pnpm db:generate
pnpm db:migrate:create --name <descriptive_name>
pnpm db:migrate
```

The Drizzle schema is the single source of truth — there is no journal.
`create` diffs the desired schema against a throwaway DB built from the
existing migrations.

## Schema conventions

- Document every column/table with JSDoc unless the purpose is obvious
  from the name. No newlines inside JSDoc except to separate paragraphs.
- Tables use PascalCase identifiers (e.g. `Tracks`); columns use
  camelCase.
- Primary keys: `uuid` with `default uuidv7()` (built into Postgres 18).

## GraphQL

The schema is derived from TypeScript via [grats](https://grats.capt.dev/).
Mark roots with `@gqlQueryField` / `@gqlMutationField`, types with
`@gqlType`, and run `pnpm gql:generate` to refresh
`src/graphql/__generated__/`. `nullableByDefault` is off, so the
TypeScript return type determines schema nullability — per project
convention, mutations return non-null (`T`) and queries return nullable
(`T | null`).

The `@constraint(min, max)` directive on argument definitions is
enforced at runtime by `applyConstraintDirective` (called from
`buildSchema`). Out-of-range values fail with `BAD_USER_INPUT` before
the resolver runs.

## Tag overrides

Each editable tag on `Tracks` (`title`, `trackNumber`, `discNumber`,
`artist`, `albumArtist`, `album`, `year`) has a nullable `*Override`
sibling column.
`Mutation.trackUpdate(id, ...)` writes the supplied tags to those
override columns; omit an argument to leave its override untouched, or
pass an explicit `null` to clear it. The scanner only writes the base
columns, so overrides survive rescans. Every read (`Query.track`,
`Query.tracks`, including the pagination sort) returns the effective
value, `coalesce(override, scanned)`.

## Scan errors

A file that throws while being read (during a scan or a watch event) is
recorded in `ScanErrors`, keyed by path, with a human-readable category
and the full stack. A recorded file is **skipped on every subsequent
scan** until it is dealt with by hand, so one broken file never gets
re-attempted endlessly; `force` re-attempts it regardless. The row
clears automatically when the file later scans cleanly or is deleted.

`Query.libraryScanErrors` pages through the recorded errors (newest
first). `Mutation.libraryScanErrorRetry(id)` re-reads the file —
clearing the error on success, refreshing it on repeated failure — and
`Mutation.libraryScanErrorDismiss(id)` drops it from the list without
retrying.

The `message` category is `"Unknown error"` for everything today;
finer categories will be filled in (`scanner/error-category.ts`) as real
failures surface in production.

## Deduplication

The library often holds the same recording several times — a FLAC and an
OGG copy, a 320k and a 96k MP3. A **duplicate group** is every track
sharing a case-folded, trimmed effective `(title, artist, album)`;
untitled tracks are never grouped. Within a group the highest-quality
copy is **canonical**: `compareQuality` (`graphql/quality.ts`) ranks
lossless above lossy, lossless by fidelity (sample rate, then bit depth,
then bitrate) with codec preference only as a tiebreak, and lossy by a
perceptual bitrate normalised across codecs — all from constant tables.

`Tracks.trackIdDeduplicated` points every member at the canonical row
(the canonical points at itself) and `Tracks.priority` ranks within the
group (0 = canonical); both are null for a track with no duplicate. The
columns are recomputed under a per-group advisory lock whenever a row's
tags or files change — scan, watch and `trackUpdate` — clearing the
group before reassigning so no self-FK reference dangles
(`dedup/recompute.ts`).

`Query.tracks` (and `Query.artistIndex`) return only canonical rows by
default; pass `includeDuplicates: true` to include every copy.
`Track.duplicates` lists a track's other copies, best-quality first.

## Search

`Query.search(query)` matches `query` as a case-insensitive prefix
(start of string) against the effective artist, album, and title, and
returns three relay-style connections: `artists`, `albums`, and
`tracks`. Each group is resolved independently and capped (no
pagination — it backs a top-N dropdown). A fourth group,
`tracksByFilename`, matches `query` as a **substring** of the file path
(not a prefix) — surfacing recordings whose tags are missing or wrong
but whose path carries the query — and unlike the others is genuinely
paginated (`first`/`after`, default page size 10), since a substring
path match can be broad. A blank query returns `null`.
An `Album` carries every artist credited across its tracks (`artists`),
so a multi-artist album isn't collapsed to one. `artists` also matches
on registered synonyms (see below), always returning the canonical
artist name.

`Query.tracks` accepts `filterArtistIn` / `filterAlbumIn`: lists of
effective artist/album names that restrict the page and `totalCount`.
Feed them the `name` values returned by `search`.

## Index-addressed scrolling

Cursor pagination only walks relative to a cursor, so it can't jump to an
arbitrary position without paging through the gap. For random access,
`Query.tracks(offset:)` returns an arbitrary window (`first` rows from a
zero-based index) in the same sort order. `Query.artistIndex` returns the
first-letter buckets present in the library (`#` for non-alphabetic),
each with the index it begins at — enough to drive an A–Z scrubber:
highlight the bucket for the current scroll position, or jump to a letter
by feeding its `offset` to `tracks`. Both honour the same filters. The
player keeps using cursor paging for next/previous, which is relative by
nature.

## Play queue and play order

`Query.playbackQueue(id:)` is the play-order surface: its `tracks` field
lists everything to be played, in order — explicitly queued tracks
first, then the library continuing after the cursor in the active order.
It carries the shuffle and repeat arguments (below) alongside the same
filter/duplicate arguments as `Query.tracks`, which itself serves only
list population. The player resolves next/previous exclusively through
`playbackQueue.tracks`; without a queue id it behaves exactly like the
plain library listing.

A queue is created lazily by the first `Mutation.queueAppend` (the
response carries the id to use from then on) and lives server-side, in
memory: at most 500 entries, expiring after a day without a write —
appending with an expired or unknown id revives it, empty, under that
same id. `queueRemove(id, trackId, index)` and
`queueReorder(id, trackId, fromIndex, toIndex)` pair the track with its
index so a concurrent edit can't displace the wrong entry (the same
track may be queued twice); `queueClear` is idempotent. The client
removes the head entry as playback starts on it, so
`PlaybackQueue.tracksQueued` always lists what is still to come.

`PlaybackQueue.tracks(shuffleSeed:)` replaces the library sort with a
deterministic pseudo-random permutation (ordering by a seeded hash of
the track id), so the same seed always yields the same order and cursor
paging and stepping stay consistent across requests.
`shuffleInitialTrackId` places one track first in the permutation — the
client pins the track playing when shuffle was enabled, so the whole
remaining library follows it rather than only the tracks that happen to
hash after it. It requires `shuffleSeed`. Filters and duplicate
collapsing compose as usual; `artistIndex` is unaffected (the list view
stays in library order).

`PlaybackQueue.tracks(repeat:)` treats the library portion of the order
as cyclic: a cursor page that runs past either end continues from the
other end (stepping past the last track yields the first and vice
versa), capped at one full lap so a page never repeats a row. With
`repeat`, `pageInfo` reports more pages in both directions whenever any
track matches. Queued tracks are not part of the cycle — each plays
once.

## Artist synonyms

`ArtistSynonyms` maps alternative names (alias, romanisation,
misspelling) to a canonical artist; `(artist, synonym)` is the primary
key. A synonym whose prefix matches a search query surfaces its
canonical `artist` in `Search.artists` — deduped against a direct match
— so `filterArtistIn` is only ever fed real artist names, never
synonyms. `Track.artistSynonyms` lists the synonyms for a track's
effective artist. `Mutation.artistSynonym{Create,Update,Delete}` manage
them; create/update reject blank or colliding pairs, delete is
idempotent.

## Album art

Album art is downloaded on demand, once per album. `Mutation.
artworkDownload(trackId)` upserts an `AlbumArt` row keyed on the
track's effective album artist (falling back to its artist) and album —
re-reading the file's album-artist tag first when the row predates the
`albumArtist` column — and links every track of that album to the row
via `Tracks.albumArtId`. The FK is what ties a track to its art, so
later tag edits never detach it; the `(albumArtist, album)` pair on the
row is only a snapshot of the search terms.

Rows move `PENDING → IN_PROGRESS → SUCCEEDED | FAILED`. An insert or
reset to PENDING fires a `pg_notify` on the `album_art_pending` channel
(trigger `AlbumArt_pending_notify`, declared via `pgCustomSQL` in the
schema) which wakes the artwork worker (`packages/artwork-worker`); the
worker also poll-sweeps, so a missed notification only delays the
download. Successful images land in `DISK_CACHE_DIR/artwork/<id>.jpg`
and are served by `GET /artwork/:id`.

`Track.artwork` resolves the linked row into a `TrackArtwork` union:
`Artwork` (the image) or `ArtworkStatus` (`inProgress`, or a failure
`message` when `inProgress` is false — retry by calling
`artworkDownload` again). Null means art was never requested.

## Playback analytics

The web player reports how much of each track is actually heard.
`Mutation.trackAnalyticsCollect(trackId, playTimeSeconds, requestedMode,
outputCodec)` appends one row to `TrackAnalytics`: `playTimeSeconds` is
the **delta** of real playback since the caller's previous sample (0 for
the sample the player sends at play start), so summing it for a track
gives true total listen time, and counting the zero-second start samples
gives its play count. Each sample also records the listener's playback
mode (`SMART`/`ORIGINAL`/`ADAPTIVE`) and the delivered MIME type (the
output codec). Calls are fire-and-forget — a dropped sample never
disturbs playback.

`clientIp` is taken from `request.ip`. The app runs with Fastify's
`trustProxy` on, so behind a reverse proxy this is the real client from
`X-Forwarded-For` rather than the proxy address — set the proxy to send
a trustworthy `X-Forwarded-For`.

## Endpoints

- `GET /healthz` — liveness probe; returns `{ "status": "ok" }`.
- `POST /graphql` — Apollo Server over Fastify (queries + mutations).
- `POST /graphql/stream` — GraphQL subscriptions over SSE via
  [`graphql-sse`](https://github.com/enisdenjo/graphql-sse)
  (distinct-connections mode). Send a `subscription` operation with
  `Accept: text/event-stream`.
- `GET /artwork/:id` — downloaded album-art image for an `AlbumArt`
  row, served from `DISK_CACHE_DIR/artwork/<id>.jpg` with an immutable
  cache header (a new download is a new row, hence a new URL). 404 for
  ids with no image yet.

### Playback

`GET /play/:signature/c:<container>/a:<codec>/q:<min|l|m|h|max>/:id`

Range-based playback over a single encoded `.bin` per `(track,
container, codec, quality)`. The URL bakes a **fully-resolved** target
(container + codec + quality) rather than the client's request — format
resolution depends on client capabilities the stateless route never
sees, so it runs once in `Track.url`/`Track.delivery` and the route just
decodes the result. The URL is HMAC-signed with
`PLAYBACK_SIGNING_SECRET` (signature covers `c:.../a:.../q:.../id`);
clients send `Range: bytes=START-END` (or `bytes=START-`) and the server
slices the `.bin`. Every response carries an `X-Quality` header naming
the resolved tier of its bytes (exposed to browser `fetch()` via CORS
`exposedHeaders` in `app.ts`), which the web player reads to report the
tier actually playing during an on-the-fly bitrate switch. `HEAD`
returns `Content-Type` + `Accept-Ranges` (and `X-Quality`), plus
`Content-Length` once the encode is complete.

Cacheability follows finality of the served bytes, not the encode's
progress: the `.bin` is append-only and the signed URL is deterministic
with no expiry, so a **closed**-range response (`bytes=START-END`) is
`public, max-age=31536000, immutable` even mid-encode — the route only
replies once the file covers the range, so those bytes can never
change. Responses whose body depends on the still-growing total — full
bodies, open-ended ranges (`bytes=START-`), HEAD — are `no-store` until
the encode is done. Every final response is `public`, so a CDN in front
edge-caches everything. Separately from HTTP caching, the
`X-Client-Cache` header (exposed via CORS alongside `X-Quality`) tells
the web player whether it may store the bytes in its IndexedDB chunk
cache: `1` for lossy deliveries, `0` for lossless (FLAC) ones, which
would churn the player's cache budget. The player stores a chunk only
when it sees `immutable` plus `X-Client-Cache: 1`, so the storability
decision lives entirely server-side.

**Format resolution** (`resolve.ts`) maps a client `TrackFormat` —
preference-ordered `losslessFormats` / `lossyFormats` MIME lists, a
`quality`, and an optional `autoPassthrough` flag — to that concrete target,
copying without re-encoding whenever possible:

| `quality`                        | source                 | served as                                                                                                                                                                                                                                         |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX`                            | lossless               | first supported `losslessFormats` entry — `audio/mp4; codecs="flac"` (copy for flac, re-encode otherwise)                                                                                                                                         |
| `MAX`                            | lossy                  | first `lossyFormats` entry whose codec matches the source (a **copy**: aac→mp4, vorbis→webm, opus→mp4/webm, mp3→mp3); else transcode to the first encodable entry                                                                                 |
| `MIN`/`LOW`/`MEDIUM`/`HIGH`      | any                    | transcode to the first `lossyFormats` entry the server can encode (opus or mp3) at the preset bitrate                                                                                                                                             |
| `MIN`–`HIGH` + `autoPassthrough` | lossy (codec playable) | **copy** the source verbatim at its original quality — resolves exactly as the `MAX` lossy row, rather than transcoding to the tier (Smart's no-double-lossy upgrade); lossless sources and unplayable lossy codecs ignore the flag and transcode |

Each target maps to one cache entry under
`DISK_CACHE_DIR/transcode/<trackId>-<sourceMtimeMs>/<targetKey>.{bin,idx}`
(`targetKey` includes the container, so `mp4/opus` and `webm/opus` don't
collide). The `.bin` is what the route streams from; the `.idx` is a
live-updating JSON manifest (chunk byte ranges + cumulative
`endSeconds`) maintained by `live-tail.ts` as ffmpeg writes.

The chunk layout depends on the container — fragmented mp4 (`moof` +
`mdat` fragments) for opus/flac/aac, WebM (`Cluster` elements) for
opus/vorbis, raw mp3 frame stream for mp3 — each with its own
`Scanner` (`scan-mp4`/`scan-webm`/`scan-mp3`), but the route doesn't
care; it slices bytes. A "copy" is always a container remux (e.g.
Vorbis-in-Ogg → Vorbis-in-WebM): the codec packets are untouched but the
output bytes differ from the source, so the remuxed `.bin` is still
generated and cached. Up to `TRANSCODE_MAX_PARALLEL` ffmpeg encodes run
concurrently.

The in-memory layer is an LRU over live handles; evicting one keeps the
`.bin`/`.idx` on disk for a future warm load, so the on-disk footprint
grows unbounded by default. Set `DISK_CACHE_MAX_BYTES` to bound it:
once usage exceeds the budget, completed entries are deleted
least-recently-**accessed** first. Recency and size live in the
`PlaybackCacheAccess` table (one row per entry dir), so a sweep is a
query — read the entries oldest-access-first, pick enough to drop under
budget, delete those dirs — not a disk scan; files on disk with no row
(orphaned partials) are ignored. The `lastAccess` write is bumped on
every request (throttled per entry so a streamed track doesn't write
per range request) which keeps a popular track from ageing out; an
entry with no row yet sorts oldest (evict-first). The sweep runs after
each transcode, on `DISK_CACHE_SWEEP_CRON`, and — as a backstop
that should rarely fire — when a write hits `ENOSPC`. Entries currently
mid-encode are never evicted. Crucially, neither are entries accessed
within `DISK_CACHE_SWEEP_GRACE_SECONDS`: a playback session is many
independent range requests against the on-disk `.bin`, and the entry's
in-memory handle churns out of the LRU long before the session ends, so
recency — not LRU membership — is what stops the sweep deleting a file
mid-stream. If everything is within the grace window we stay over
budget rather than evict something in use.

`Mutation.trackClearTranscodeCache(id)` discards every cached target for
one track — all formats and qualities, across every source-mtime
generation — killing any in-progress encode, removing the entry dirs,
and dropping their `PlaybackCacheAccess` rows. The next `delivery`
request re-encodes from source. It's the recovery path for a track whose
cached bytes are unplayable (e.g. a source whose metadata produced a
container a browser refuses to decode); the web client wires it to the
playback error toast's retry button.

`Track.delivery(format)` returns the resolved `{ url, mimeType,
isPassthrough, isMultiLossy, description, tiers }` in one field, so a client
gets the SourceBuffer MIME type and a tooltip-ready description without a
probe request. `isMultiLossy` is true when a lossy source is re-encoded to a
lossy output (not a verbatim copy) — a second generation of compression loss
the client can flag. `tiers` lists the expected bitrate of each adaptive tier
(MIN–HIGH) for the resolved lossy codec, so the adaptive controller can size
the connection against the ladder and jump straight to the best-fitting tier.

### Manifest subscription

`subscription trackManifest(trackId, format: TrackFormat)` — streams
manifest snapshots throttled to ~1 Hz: chunk count, cumulative
duration, per-chunk `{ byteStart, byteEnd, endSeconds }`, optional
init segment range, and a `done` flag. Clients use it to discover
which byte ranges to ask the playback route for, and to map seek
times to chunks. Already-warm cache entries emit a single `done:
true` snapshot and complete.

## Env

| Variable                         | Default                                       | Notes                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKEND_HOST`                   | `0.0.0.0`                                     |                                                                                                                                                                                                               |
| `BACKEND_PORT`                   | `4000`                                        |                                                                                                                                                                                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT`    | `http://otel-lgtm:4318`                       | OTLP/HTTP base URL                                                                                                                                                                                            |
| `OTEL_SERVICE_NAME`              | `lofify-backend`                              |                                                                                                                                                                                                               |
| `DATABASE_URL`                   | _(unset)_                                     | Postgres connection string for the Drizzle pool.                                                                                                                                                              |
| `LIBRARY_PATH`                   | _required_                                    | Comma-separated list of absolute paths to the music library roots. The scanner and chokidar watcher cover every listed directory at boot.                                                                     |
| `SCAN_CONCURRENCY`               | `4`                                           | Max files parsed and upserted in parallel by the scanner.                                                                                                                                                     |
| `SCAN_CRON`                      | `0 2 * * *`                                   | Cron expression for the recurring full library scan. Empty disables.                                                                                                                                          |
| `CORS_ALLOW_ORIGINS`             | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowlist of browser origins. `*` allows any.                                                                                                                                                 |
| `PLAYBACK_SIGNING_SECRET`        | `dev-secret`                                  | HMAC key used to sign and verify `/play` URLs.                                                                                                                                                                |
| `TRANSCODE_MAX_PARALLEL`         | `12`                                          | Maximum concurrent ffmpeg encode processes.                                                                                                                                                                   |
| `DISK_CACHE_DIR`                 | `${os.tmpdir()}/lofify-cache`                 | Persistent root of the on-disk cache: playback entries under `transcode/`, album art under `artwork/`. Survives restarts; point at durable storage in production. Startup crashes if it is not writable.      |
| `DISK_CACHE_MAX_BYTES`           | _(unset)_                                     | Soft byte budget for the on-disk cache. When set, completed entries are swept least-recently-accessed-first once usage exceeds it. Unset leaves the cache unbounded.                                          |
| `UPLOAD_MAX_BYTES`               | `10485760`                                    | Maximum size of a file sent with a GraphQL multipart request (e.g. `trackUpdate`'s artwork upload).                                                                                                           |
| `PUBLIC_URL`                     | _(required)_                                  | Public base URL of the API (e.g. `https://music.example.com`), used to build absolute `Media.url` values.                                                                                                     |
| `DISK_CACHE_SWEEP_CRON`          | `*/15 * * * *`                                | Cron expression for the periodic cache sweep. Empty disables the schedule (the post-transcode and ENOSPC sweeps still run). No effect unless `DISK_CACHE_MAX_BYTES` is set.                                   |
| `DISK_CACHE_SWEEP_GRACE_SECONDS` | `300`                                         | Grace window during which a recently-accessed entry is never evicted, even when over budget — protects entries an in-flight playback session still depends on. Must exceed 60s.                               |
| `WEB_DIST_PATH`                  | `packages/web/dist`                           | Built web client served as an SPA catch-all when present.                                                                                                                                                     |
| `GIT_SHA`                        | `dev`                                         | Git commit the image was built from (baked in by the Dockerfile, not set by hand). Backs `Query.isUpdateAvailable`, which the client polls to detect a newer deployment. `dev` suppresses the prompt locally. |
| `DB_QUERY_LOG`                   | _(unset)_                                     | Set to `true`/`1` to log every SQL statement Drizzle issues, with bound parameters, through the application logger. For local debugging; leave unset in production.                                           |
