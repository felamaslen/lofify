# Lofify — Build Plan

A music player with library scanning, transcoding playback, and a web UI.
This document is the source of truth for scope and build order. Each chunk is
independently buildable; check items off as they land. Current state: nothing
built yet — empty repo.

---

## Conventions (apply to every chunk)

- **Package manager**: pnpm workspaces (monorepo).
- **Language**: TypeScript everywhere.
- **DB schema (Drizzle, TS)**: document every column/table with JSDoc unless
  the purpose is obvious from the name. No newlines inside JSDoc comments
  except to separate paragraphs.
- **GraphQL schema (grats)**: document every type/field/argument with JSDoc
  unless obvious. Never reference implementation details or anything the
  client doesn't need to know.
- **JSDoc paragraph rule**: applies to both DB and GraphQL JSDoc.
- **GraphQL nullability**: mutations always return non-null types, queries
  always return nullable types.
- **Mutation noop return type**: `type Void { _: Boolean }`.
- **Tests**: use `fastify.inject` to drive GraphQL operations end-to-end. Do
  not import implementation modules from tests — assert only on observable
  HTTP/GraphQL responses. Tests are behavioural.
- **Authorisation**: out of scope for MVP.
- **British English** in all prose.

---

## Chunk 1 — Repo scaffold

Goal: empty but bootable monorepo.

- [x] `pnpm-workspace.yaml` with `packages/*`.
- [x] Root `package.json` with shared scripts (`lint`, `typecheck`, `test`,
      `dev`, `build`).
- [x] Shared TS config (`tsconfig.json` + `tsconfig.build.json` which
      excludes tests) — per-package configs extend these.
- [x] ESLint + Prettier config at root.
- [x] `.gitignore`, `.editorconfig`, `.tool-versions` (asdf: nodejs 24,
      pnpm 9).
- [x] `Dockerfile` (multi-stage: backend, ui). Scanner is part of backend.
- [x] `docker-compose.dev.yml` — Postgres (host port 5433), otel-lgtm,
      backend in watch mode, UI dev server. (Scanner runs inside backend;
      no separate service.)
- [x] `docker-compose.prod.yml` — Postgres, otel-lgtm, backend, UI (built
      static).
- [x] `.env.example` documenting every env var the system reads —
      `DATABASE_URL` only (no separate `POSTGRES_*`).

State after chunk: `docker compose -f docker-compose.dev.yml up` boots an
empty stack.

---

## Chunk 2 — Database + migrations

Goal: Postgres reachable, Drizzle schema compiled, migrations run.

- [x] ~~`packages/db`~~ Drizzle schema lives in `packages/backend/src/db/`
      (backend is the only TS consumer).
- [x] ~~Postgres enum `TrackFormat`~~ stored as `text` for now; revisit
      once the scanner is in.
- [x] Table `Tracks` (all columns per spec, see below).
- [x] Indexes on `artist`, `album`.
- [x] Unique index on `file`.
- [x] Migration runner wired to
      [drizzle-pgkit-migrator](https://github.com/felamaslen/drizzle-pgkit-migrator).
- [x] `pnpm db:migrate` script (delegates to `@lofify/backend`).

`Tracks` columns: `id` (uuidv7 PK, defaults to `uuidv7()` — built-in in
PG18), `createdAt`, `updatedAt`, `scannedAt`, `title`, `trackNumber`,
`discNumber`, `artist`, `album`, `year`, `format` (text — was planned as
enum), `codec`, `bitRate` (nullable → VBR), `sampleRate`, `isLossless`,
`file` (unique, absolute path), `sizeBytes` (bigint), `durationSeconds`.

---

## Chunk 3 — Backend skeleton (fastify + grats + apollo)

Goal: GraphQL server reachable, healthcheck green, otel exporting.

- [x] `packages/backend` — fastify app.
- [x] grats configured; generated schema checked in or built on prepare.
- [x] Apollo server wired into fastify at `POST /graphql`.
- [x] SSE endpoint stub at `GET /graphql/stream` (used later for
      subscriptions).
- [x] Healthcheck `GET /healthz`.
- [x] OpenTelemetry SDK initialised; OTLP exporter pointing at otel-lgtm.
- [x] `Void` type defined.
- [x] `@gqlDirective` infrastructure for `@constraint(min, max)` — directive
      defined and enforced at resolver entry.
- [x] Test harness: fastify built without `listen`, `fastify.inject` helper
      exposed for tests.

---

## Chunk 4 — Scanner module (inside backend)

Goal: backend can scan a library and watch it for changes. Lives at
`packages/backend/src/scanner/`. Runs in-process with the GraphQL server,
so `Subscription.libraryScan` reads live in-memory progress directly — no
control-plane RPC.

- [ ] `scanner/runner.ts` — orchestrator. Holds a map of `scanId →
      ScanState { filesTotal, scannedTotal, errorsTotal, errors[] }`.
      State lives in memory only; entries are wiped some grace period
      after completion.
- [ ] `scanner/parse.ts` — audio metadata parsing via
      [`music-metadata`](https://github.com/borewit/music-metadata) →
      fills every `Tracks` column. Use `fs.stat` for `sizeBytes` and
      mime/format detection.
- [ ] `scanner/scan.ts` — `scanLibrary(path)`: walks the library
      (`fast-glob` or `node:fs/promises` recursive read), parses each
      file, upserts into `Tracks` keyed by `file`. Returns a `scanId`
      synchronously; work runs in the background and updates the
      in-memory `ScanState`.
- [ ] `scanner/watch.ts` — long-running watcher via
      [`chokidar`](https://github.com/paulmillr/chokidar). On add: parse
      + upsert. On unlink: delete by `file`. On change: re-parse +
      upsert. Started during backend boot when `LIBRARY_PATH` is set.
- [ ] DB writes use the backend's existing Drizzle connection — no
      separate pool.
- [ ] No cron inside the scanner — orchestration is external (e.g. a
      cron job that calls the `libraryScan` mutation).

---

## Chunk 5 — Library scan GraphQL surface

Goal: backend can trigger and observe scans.

- [ ] `Mutation.libraryScan: LibraryScan!` — invokes
      `scanner.scanLibrary(LIBRARY_PATH)`, returns initial `LibraryScan`.
- [ ] `type LibraryScan { id: ID!, scannedTotal: Int!, errorsTotal: Int!,
      filesTotal: Int! }`.
- [ ] `Subscription.libraryScan(id: ID!): LibraryScan` over SSE on `GET
      /graphql/stream`. Emits every 1s while scan is in progress, completes
      when scan finishes.
- [ ] Behavioural tests via `fastify.inject`:
  - [ ] Mutation returns a scan with positive `filesTotal`.
  - [ ] SSE stream emits progress and terminates.

---

## Chunk 6 — Track queries

Goal: client can list and read tracks.

- [ ] `Query.tracks(first, last, before, after): TrackConnection` — full
      Relay connection. Sort: `artist`, `album`, `discNumber`, `trackNumber`.
- [ ] `Query.track(id: ID!): Track`.
- [ ] `type Track` per spec, including:
  - [ ] `url(quality: Int @constraint(min:0,max:10), format: Format): String!`
        — returns signed playback URL.
  - [ ] `duration: Duration!` — new scalar/object type with `seconds: Int!`
        and `formatted: String!` (e.g. `05:32`).
  - [ ] `format: String!` — derived from db `format` + `codec` (e.g.
        `"ogg vorbis"`, `"mp3"`, `"webm opus"`).
- [ ] `enum Format { ORIGINAL, AUTO_HI, AUTO_LO, AAC, OGG, WEBM, FLAC }`.
- [ ] Tests cover pagination, sort order, `url` signature shape.

---

## Chunk 7 — Playback endpoint

Goal: `GET /play/{signature}/{options}/{id}` streams audio.

- [ ] Route parses `options` with zod. Format: `f:<fmt>:q:<n>`, all fields
      optional, empty string allowed.
- [ ] HMAC verifies `{options}/{id}` against backend secret. Reject on
      mismatch.
- [ ] `Track.url` resolver produces the signed URL.
- [ ] **Passthrough path** (format matches source, no quality override):
  - [ ] Stat file → `Content-Length`.
  - [ ] No `Range` → stream whole file.
  - [ ] With `Range` → 206 partial content from disk.
  - [ ] `Content-Type` set with mime + codec (e.g. `audio/ogg;
        codecs=vorbis`).
- [ ] **Transcode path** (quality set or format differs from source):
  - [ ] Spawn ffmpeg, stream stdout to client.
  - [ ] LRU cache of recent transcoded streams; TTL + max size from env.
  - [ ] Range requests serve from cache, including 206 before ffmpeg has
        finished producing the full output.
  - [ ] Semaphore: at most one ffmpeg process per arg-tuple; at most `N`
        ffmpeg processes in parallel (`N` from env).
- [ ] Auto format rules:
  - [ ] `AUTO_HI`: lossless source → flac; lossy source → original
        passthrough.
  - [ ] `AUTO_LO`: always webm/opus VBR at a sane quality.
- [ ] Behavioural tests for: passthrough full, passthrough range,
      transcode happy path, signature rejection, options parse failure.

---

## Chunk 8 — Web UI

Goal: usable single-page player.

- [ ] `packages/ui` — Vite + React + TanStack Router.
- [ ] Single route `/`.
- [ ] Infinitely scrolling track list, virtualised with TanStack Virtual.
      Columns: disc, track, title, duration, artist, album, year.
- [ ] Format picker: `Auto (hi)`, `Auto (lo)`, `FLAC`, `WebM`.
- [ ] Double-click a row → request `Track.url(quality, format)` →
      `<audio>` element plays it.
- [ ] Playback bar: play/pause, next, previous, scrub gutter, current-track
      info.
- [ ] Next/prev driven by `Query.tracks(first: 1, after: <currentId>)`
      (and `last: 1, before: …`).
- [ ] Scrub gutter advances based on known `duration.seconds` regardless of
      ffmpeg progress.

---

## Chunk 9 — Observability polish

Goal: traces and logs are useful in otel-lgtm.

- [ ] Trace GraphQL operations (operation name as span name).
- [ ] Trace playback requests; tag passthrough vs transcode, cache hit/miss,
      ffmpeg semaphore wait time.
- [ ] Structured logs piped via otel logs exporter.
- [ ] Basic dashboard JSON checked in for the otel-lgtm Grafana.

---

## Out of scope for MVP

- Authorisation / multi-user.
- Playlists, queues beyond next/prev.
- Mobile UI.
- Replay gain, gapless playback.
- Artwork / cover art.
- Lyrics, metadata editing.

Revisit after chunk 9.
