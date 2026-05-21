# @lofify/backend

The TypeScript monolith. Hosts the GraphQL API, the playback HTTP
endpoint, the library scanner, and the database schema + migrations.

## Layout

```
src/
  index.ts          Entrypoint: boots Fastify on BACKEND_HOST:BACKEND_PORT.
  app.ts            buildApp(): Fastify with /healthz, /graphql,
                    /graphql/stream. No listener bound — used by tests.
  instrument.ts     OpenTelemetry SDK bootstrap. Side-effect module
                    preloaded via `tsx --import ./src/instrument.ts`
                    so OTel installs before anything else loads.
  env.ts            zod-parsed view of process.env. Import `env` from
                    here rather than reading process.env directly.
  graphql/
    root.ts         @gqlQueryField / @gqlMutationField resolvers.
    types.ts        Shared types (Void).
    directives/     Directive definitions + runtime enforcement
                    (e.g. constraint.ts for @constraint).
    index.ts        buildSchema(): grats schema + directive wrappers.
    __generated__/  schema.ts + schema.graphql (written by `grats`).
  db/
    schema/         Drizzle schema (source of truth).
    migrations/     Plain SQL migrations.
    __generated__/  schema.sql output of `generate-schema` (gitignored).
  test/             Vitest behavioural tests driven by fastify.inject.
  scanner/          Lands in chunk 4 — not yet present.
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
- `POST /graphql` — Apollo Server over Fastify.
- `GET /graphql/stream` — SSE endpoint (stub; full subscription wiring
  lands in chunk 5).

## Env

| Variable                       | Default               | Notes                |
| ------------------------------ | --------------------- | -------------------- |
| `BACKEND_HOST`                 | `0.0.0.0`             |                      |
| `BACKEND_PORT`                 | `4000`                |                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | `http://otel-lgtm:4318` | OTLP/HTTP base URL |
| `OTEL_SERVICE_NAME`            | `lofify-backend`      |                      |
