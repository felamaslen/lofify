# @lofify/backend

The TypeScript monolith. Hosts the GraphQL API, the playback HTTP
endpoint, the library scanner, and the database schema + migrations.

## Layout

```
src/
  app.ts        buildApp(): Fastify with /healthz, /graphql,
                /graphql/stream. No listener bound — used by tests.
  config.ts     Static code-level constants (chunk duration, etc.).
  graphql/      GraphQL schema (grats source) and resolvers.
  db/           Drizzle schema, migrations, and shared pg pool.
  scanner/      Library scan + chokidar watcher (in-process). A scan
                walks every library root, classifies discovered files
                against `Tracks` in batches, and feeds a priority queue:
                new files are parsed first, changed files next, and
                unchanged files are skipped.
  playback/     `/play/...` HTTP route, HMAC-signed URLs, unified
                per-entry encoded cache (.bin + .idx live-tail), and
                ffmpeg encoder.
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
`artist`, `album`, `year`) has a nullable `*Override` sibling column.
`Mutation.trackUpdate(id, ...)` writes the supplied tags to those
override columns; omit an argument to leave its override untouched, or
pass an explicit `null` to clear it. The scanner only writes the base
columns, so overrides survive rescans. Every read (`Query.track`,
`Query.tracks`, including the pagination sort) returns the effective
value, `coalesce(override, scanned)`.

## Endpoints

- `GET /healthz` — liveness probe; returns `{ "status": "ok" }`.
- `POST /graphql` — Apollo Server over Fastify (queries + mutations).
- `POST /graphql/stream` — GraphQL subscriptions over SSE via
  [`graphql-sse`](https://github.com/enisdenjo/graphql-sse)
  (distinct-connections mode). Send a `subscription` operation with
  `Accept: text/event-stream`.

### Playback

`GET /play/:signature/q:<min|l|m|h|max>/f:<opus|mp3>/:id`

Range-based playback over a single encoded `.bin` per `(track, format,
quality)`. The URL is produced by `Track.url(format: TrackFormat)` and
HMAC-signed with `PLAYBACK_SIGNING_SECRET`. The signature covers
`q:.../f:.../id`; clients send `Range: bytes=START-END` (or
`bytes=START-`) and the server slices the `.bin`. `HEAD` returns
`Content-Type` + `Accept-Ranges`, plus `Content-Length` once the encode
is complete.

Target resolution:

| `quality`                   | source   | served as                                                                                 |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `MAX`                       | lossless | `audio/mp4; codecs="flac"` (passthrough for flac sources, re-encode for ape/alac/wv/etc.) |
| `MAX`                       | lossy    | highest lossy preset in `formatLossy`                                                     |
| `MIN`/`LOW`/`MEDIUM`/`HIGH` | any      | lossy preset in `formatLossy`                                                             |

Each `(track, format, quality)` maps to one cache entry under
`PLAYBACK_CACHE_DIR/<trackId>-<sourceMtimeMs>/<targetKey>.{bin,idx}`.
The `.bin` is what the route streams from; the `.idx` is a
live-updating JSON manifest (chunk byte ranges + cumulative
`endSeconds`) maintained by `live-tail.ts` as ffmpeg writes.

The chunk layout depends on the container — fragmented mp4 (`moof` +
`mdat` fragments) for opus and flac, raw mp3 frame stream for mp3 — but
the route doesn't care; it slices bytes. Up to `TRANSCODE_MAX_PARALLEL`
ffmpeg encodes run concurrently.

### Manifest subscription

`subscription trackManifest(trackId, format: TrackFormat)` — streams
manifest snapshots throttled to ~1 Hz: chunk count, cumulative
duration, per-chunk `{ byteStart, byteEnd, endSeconds }`, optional
init segment range, and a `done` flag. Clients use it to discover
which byte ranges to ask the playback route for, and to map seek
times to chunks. Already-warm cache entries emit a single `done:
true` snapshot and complete.

## Env

| Variable                      | Default                                       | Notes                                                                                                                                       |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKEND_HOST`                | `0.0.0.0`                                     |                                                                                                                                             |
| `BACKEND_PORT`                | `4000`                                        |                                                                                                                                             |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-lgtm:4318`                       | OTLP/HTTP base URL                                                                                                                          |
| `OTEL_SERVICE_NAME`           | `lofify-backend`                              |                                                                                                                                             |
| `DATABASE_URL`                | _(unset)_                                     | Postgres connection string for the Drizzle pool.                                                                                            |
| `LIBRARY_PATH`                | _required_                                    | Comma-separated list of absolute paths to the music library roots. The scanner and chokidar watcher cover every listed directory at boot.   |
| `SCAN_CONCURRENCY`            | `4`                                           | Max files parsed and upserted in parallel by the scanner.                                                                                   |
| `SCAN_CRON`                   | `0 2 * * *`                                   | Cron expression for the recurring full library scan. Empty disables.                                                                        |
| `CORS_ALLOW_ORIGINS`          | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowlist of browser origins. `*` allows any.                                                                               |
| `PLAYBACK_SIGNING_SECRET`     | `dev-secret`                                  | HMAC key used to sign and verify `/play` URLs.                                                                                              |
| `TRANSCODE_MAX_PARALLEL`      | `12`                                          | Maximum concurrent ffmpeg encode processes.                                                                                                 |
| `PLAYBACK_CACHE_DIR`          | `${os.tmpdir()}/lofify-cache`                 | Persistent root for cache entries (`<trackId>-<mtimeMs>/<targetKey>.{bin,idx}`). Survives restarts; point at durable storage in production. |
| `WEB_DIST_PATH`               | `packages/web/dist`                           | Built web client served as an SPA catch-all when present.                                                                                   |
