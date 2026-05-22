# Lofify

Self-hosted music player: scans a library on disk, serves a GraphQL API
and a transcoding playback endpoint, and ships a small web UI on top.

See [`CLAUDE.md`](./CLAUDE.md) for repo conventions that apply to every
change.

## Layout

```
packages/
  backend/   TypeScript monolith: GraphQL API, playback, scanner, db schema
  web/       Vite + React + TanStack Router web client
```

The scanner lives inside `packages/backend` — it is not a separate
package or service.

## Toolchain

- Node 24, pnpm 9 (managed with `asdf`; see `.tool-versions`).
- Postgres 18 (Docker, dev exposed on host port `5433`).
- TypeScript everywhere; Drizzle for schema + migrations via
  [`drizzle-pgkit-migrator`](https://github.com/felamaslen/drizzle-pgkit-migrator).

## Dev

```sh
pnpm install
docker compose up        # postgres, otel-lgtm, backend, web
pnpm db:migrate          # apply migrations
```

`docker compose` reads `docker-compose.yml`. Production uses
`docker-compose.prod.yml`.

## Root scripts

| Script           | What it does                                       |
| ---------------- | -------------------------------------------------- |
| `lint`           | ESLint across every package                        |
| `typecheck`      | `tsc --noEmit` across every package                |
| `test`           | Per-package test runner                            |
| `dev`            | Watch-mode dev across every package                |
| `build`          | Production build                                   |
| `codegen`        | Run all code generators across every package       |
| `db:generate`    | Drizzle schema → `schema.sql`                      |
| `db:migrate`     | Apply pending Postgres migrations                  |
| `db:migrate:create` | Regenerate `schema.sql` + write a new migration |
| `format`         | Prettier write                                     |

## Config

Every environment variable the system reads is documented in
[`.env.example`](./.env.example). Only `DATABASE_URL` is exposed; the
compose stack hardcodes the Postgres bootstrap credentials.
