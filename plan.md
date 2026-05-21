# Lofify — Build Plan

A music player with library scanning, transcoding playback, and a web UI.
This document is the source of truth for scope and build order. Each chunk is
independently buildable; check items off as they land. Current state: nothing
built yet — empty repo.

---

## Conventions (apply to every chunk)

- **Package manager**: pnpm workspaces (monorepo).
- **Language**: TypeScript everywhere except the scanner (Rust).
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

- [ ] `pnpm-workspace.yaml` with `packages/*`.
- [ ] Root `package.json` with shared scripts (`lint`, `typecheck`, `test`,
      `dev`, `build`).
- [ ] Shared TS config (`tsconfig.base.json`) + per-package extends.
- [ ] ESLint + Prettier config at root.
- [ ] `.gitignore`, `.editorconfig`, `.nvmrc`.
- [ ] `Dockerfile` (multi-stage, builds backend + UI).
- [ ] `docker-compose.dev.yml` — Postgres, otel-lgtm, backend in watch mode,
      UI dev server, scanner in watch/dev mode.
- [ ] `docker-compose.prod.yml` — Postgres, otel-lgtm, backend, UI (built
      static), scanner.
- [ ] `.env.example` documenting every env var the system reads.

State after chunk: `docker compose -f docker-compose.dev.yml up` boots an
empty stack.

---

## Chunk 2 — Database + migrations

Goal: Postgres reachable, Drizzle schema compiled, migrations run.

- [ ] `packages/db` — Drizzle schema package.
- [ ] Postgres enum `TrackFormat` (flac, ogg, mp3, wma, …).
- [ ] Table `Tracks` (all columns per spec, see below).
- [ ] Indexes on `artist`, `album`.
- [ ] Unique index on `file`.
- [ ] Migration runner wired to
      [drizzle-pg-kit-migrator](https://github.com/felamaslen/drizzle-pg-kit-migrator).
- [ ] `pnpm db:migrate` script.

`Tracks` columns: `id` (uuidv7 PK), `createdAt`, `updatedAt`, `scannedAt`,
`title`, `trackNumber`, `discNumber`, `artist`, `album`, `year`, `format`
(enum), `codec`, `bitRate` (nullable → VBR), `sampleRate`, `isLossless`,
`file` (unique, absolute path), `sizeBytes`, `durationSeconds`.

---

## Chunk 3 — Backend skeleton (fastify + grats + apollo)

Goal: GraphQL server reachable, healthcheck green, otel exporting.

- [ ] `packages/backend` — fastify app.
- [ ] grats configured; generated schema checked in or built on prepare.
- [ ] Apollo server wired into fastify at `POST /graphql`.
- [ ] SSE endpoint stub at `GET /graphql/stream` (used later for
      subscriptions).
- [ ] Healthcheck `GET /healthz`.
- [ ] OpenTelemetry SDK initialised; OTLP exporter pointing at otel-lgtm.
- [ ] `Void` type defined.
- [ ] `@gqlDirective` infrastructure for `@constraint(min, max)` — directive
      defined and enforced at resolver entry.
- [ ] Test harness: fastify built without `listen`, `fastify.inject` helper
      exposed for tests.

---

## Chunk 4 — Scanner package (Rust)

Goal: standalone Rust binary that can scan a library and watch it.

- [ ] `packages/scanner` with a `package.json` exposing `build` / `start` /
      `dev` scripts that shell into `cargo`.
- [ ] Rust crate with two binaries (or subcommands):
  - [ ] `scan <library-path>` — kicks off a one-shot rescan, prints a
        scan-id, exits (background job continues in the watcher process, see
        below) **or** runs in-process and exposes status via local IPC. Pick
        one and document here once decided.
  - [ ] `status <scan-id>` — returns `{ filesTotal, scannedTotal,
        errorsTotal, errors[] }`. State lives in memory only; wiped on
        completion.
  - [ ] `watch <library-path>` — long-running. On add: parse + upsert. On
        delete: remove by `file`. On change: re-parse + upsert.
- [ ] Audio metadata parsing (symphonia or lofty) → fills every `Tracks`
      column.
- [ ] DB writes go through the same Postgres the backend uses (shared
      connection string via env).
- [ ] No cron inside scanner — orchestration is external.

Open question to settle in this chunk: process model for `scan` + `status`.
Likely a single long-running scanner daemon with a small HTTP/Unix-socket
control plane that the backend calls into, so `status` can read live
in-memory progress. **Update this section once decided.**

---

## Chunk 5 — Library scan GraphQL surface

Goal: backend can trigger and observe scans.

- [ ] `Mutation.libraryScan: LibraryScan!` — calls scanner control plane,
      returns initial `LibraryScan`.
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
