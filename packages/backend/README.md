# @lofify/backend

The TypeScript monolith. Hosts the GraphQL API, the playback HTTP
endpoint, the library scanner, and the database schema + migrations.

## Layout

```
src/
  db/
    schema/         Drizzle schema (source of truth)
    migrations/     Plain SQL migrations (created by drizzle-pgkit-migrator)
    __generated__/  schema.sql output of `generate-schema` (gitignored)
  scanner/          Library walk + chokidar watch + music-metadata parse
                    (lands in chunk 4 — not yet present)
```

Other top-level modules (GraphQL server, playback route, OTel bootstrap)
arrive in later chunks; see [`../../plan.md`](../../plan.md).

## Scripts

| Script               | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `codegen`            | Run all code generators (currently just `db:generate`) |
| `db:generate`        | Drizzle schema → `src/db/__generated__/schema.sql`    |
| `db:migrate`         | Apply pending migrations                              |
| `db:migrate:create`  | Diff schema vs. applied migrations, write new SQL     |
| `db:migrate:list`    | Show migration history                                |
| `db:migrate:pending` | Show pending migrations                               |
| `typecheck`          | `tsc --noEmit`                                        |

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
