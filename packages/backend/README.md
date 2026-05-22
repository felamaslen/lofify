# @lofify/backend

The TypeScript monolith. Hosts the GraphQL API, the playback HTTP
endpoint, the library scanner, and the database schema + migrations.

## Layout

```
src/
  app.ts        buildApp(): Fastify with /healthz, /graphql,
                /graphql/stream. No listener bound — used by tests.
  graphql/      GraphQL schema (grats source) and resolvers.
  db/           Drizzle schema, migrations, and shared pg pool.
  scanner/      Library scan + chokidar watcher (in-process).
  playback/     `/play/...` HTTP route: HMAC-signed URLs, passthrough
                streaming with Range support, ffmpeg transcoding with a
                bounded LRU cache and a process semaphore.
  test/         Vitest behavioural tests driven by fastify.inject.
```

## Scripts

| Script               | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `dev`                | `tsx watch src/index.ts` — boots the server           |
| `start`              | Production-style boot (no watch)                      |
| `test`               | `vitest run` (behavioural tests via fastify.inject)   |
| `typecheck`          | `tsc --noEmit`                                        |
| `codegen`            | All code generators (`db:generate`, `gql:generate`)   |
| `db:generate`        | Drizzle schema → `src/db/__generated__/schema.sql`    |
| `gql:generate`       | grats → `src/graphql/__generated__/schema.{ts,graphql}` |
| `db:migrate`         | Apply pending migrations                              |
| `db:migrate:create`  | Diff schema vs. applied migrations, write new SQL     |
| `db:migrate:list`    | Show migration history                                |
| `db:migrate:pending` | Show pending migrations                               |

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

## Endpoints

- `GET /healthz` — liveness probe; returns `{ "status": "ok" }`.
- `POST /graphql` — Apollo Server over Fastify (queries + mutations).
- `POST /graphql/stream` — GraphQL subscriptions over SSE via
  [`graphql-sse`](https://github.com/enisdenjo/graphql-sse)
  (distinct-connections mode). Send a `subscription` operation with
  `Accept: text/event-stream`.
- `GET /play/:signature/[q:<l|m|h>/]:id[/:seg]` — stream a track. The URL
  is produced by `Track.url` and HMAC-signed with `PLAYBACK_SIGNING_SECRET`.
  The only signed option is the quality (`q:l`, `q:m`, `q:h`); the
  delivery container is negotiated at request time via the `Accept`
  header, so a single signed URL can be replayed with different `Accept`
  values to switch formats. Supported `Accept` entries: `audio/flac`,
  `audio/mpeg`, `audio/mp4` (plus the standard wildcards). `audio/flac`
  must always be paired with at least one fallback — flac alone returns
  `406`. Resolution:
  - `audio/flac` accepted + flac source → passthrough (whole file with
    `Accept-Ranges: bytes`, `Range` support, `Content-Type: audio/flac`).
  - `audio/flac` accepted + lossy source → encode the first non-flac
    `Accept` entry at the encoder's max preset.
  - `audio/flac` not accepted → encode the first `Accept` entry at the
    requested quality (`low` / `medium` / `high`; defaults to medium).

  Encoded paths kick off (or attach to) a single per-track ffmpeg job.
  `audio/mp4` uses ffmpeg's DASH muxer with fragmented MP4 segments and
  writes `init.mp4` + `chunk-NNNNN.m4s` (Chrome's MSE plays multi-segment
  Opus more cleanly out of fMP4 than out of WebM); `audio/mpeg` uses the
  segment muxer and writes standalone `chunk-NNNNN.mp3` files (no init
  segment — every mp3 frame is self-describing). The trailing `:seg`
  selects the 0-indexed chunk: for mp4, `seg=0` returns the init
  concatenated with chunk 1 and `seg=N>0` returns just chunk `N+1`;
  for mp3, `seg=N` returns chunk `N`
  verbatim. Requests for chunks that aren't on disk yet block until
  ffmpeg writes them. `HEAD` against the same URL returns the meta
  headers (`X-Lofify-Segments`, `X-Lofify-Segment-Duration`,
  `X-Lofify-Duration`, `X-Lofify-Ready-Chunks`) for the client to
  discover the segmented-playback mode. The HMAC signature covers only
  the `options/id` portion of the path — `:seg` is unsigned. Up to
  `TRANSCODE_MAX_PARALLEL` ffmpeg processes run concurrently; jobs are
  LRU-evicted (and their tmpdirs `rm`-ed) under `TRANSCODE_CACHE_*`.
- `subscription transcodeProgress(trackId, acceptHeaderValue, quality)` — emits
  `{ readyChunks, chunkDurationSeconds, isDone }` snapshots throttled
  to ~1 Hz so the playback UI can clamp seeks to the encoded region
  and overlay a "still encoding" stripe on the seek bar.

## Env

| Variable                       | Default               | Notes                |
| ------------------------------ | --------------------- | -------------------- |
| `BACKEND_HOST`                 | `0.0.0.0`             |                      |
| `BACKEND_PORT`                 | `4000`                |                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | `http://otel-lgtm:4318` | OTLP/HTTP base URL |
| `OTEL_SERVICE_NAME`            | `lofify-backend`      |                      |
| `DATABASE_URL`                 | _(unset)_             | Postgres connection string for the Drizzle pool. |
| `LIBRARY_PATH`                 | _required_            | Absolute path to the music library. The chokidar watcher follows it at boot. |
| `SCAN_CONCURRENCY`             | `4`                   | Max files parsed and upserted in parallel by the scanner. |
| `SCAN_CRON`                    | `0 2 * * *`           | Cron expression for the recurring full library scan. Empty disables. |
| `PLAYBACK_SIGNING_SECRET`      | `dev-secret`          | HMAC key used to sign and verify `/play` URLs. |
| `TRANSCODE_MAX_PARALLEL`       | `4`                   | Maximum concurrent ffmpeg transcode processes. |
| `TRANSCODE_CACHE_MAX_BYTES`    | `1073741824` (1 GiB)  | Soft cap on bytes held in the in-memory transcode cache. |
| `TRANSCODE_CACHE_TTL_SECONDS`  | `3600`                | TTL after last access for cached transcodes. |
| `TRANSCODE_TMPDIR`             | `${os.tmpdir()}/lofify-transcode` | Scratch directory for ffmpeg DASH output. Mount as tmpfs in containers (see `docker-compose.yml`). |
