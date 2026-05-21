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
