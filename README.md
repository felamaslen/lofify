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
`docker-compose.prod.yml`; in prod the backend serves the built web
client itself as a catch-all SPA route, so there is no separate web
container.

## Deploy

```sh
cp .env.example .env.production   # then edit secrets
scripts/deploy.sh --host my-server --nfs-host 10.0.0.2 --nfs-path /srv/dockercache
```

`scripts/deploy.sh` builds and pushes `felamaslen/lofify:latest`, copies
`docker-compose.prod.yml` to `{directory}/docker-compose.yml` on the
remote (default `/opt/lofify`), and copies `.env.production` to
`{directory}/.env`. Backend listens on host port `4002`. Postgres data
persists at `{directory}/var/db`. `.env.production` is git-ignored.

The playback cache is an NFS-backed Docker volume. `--nfs-host` and
`--nfs-path` (both required) name the NFS server and exported directory;
the deploy splices them into the compose file before copying. Docker
creates the volume from those options on first `up` — to repoint it at a
different server later, remove the `playback-cache` volume on the remote
(`docker volume rm <project>_playback-cache`) before redeploying. The
share root is mounted at `/playback-cache`; the backend writes into the
`lofify` subdirectory (`PLAYBACK_CACHE_DIR`), which it creates on first
use, so the export can be shared with other consumers.

## Root scripts

| Script              | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `lint`              | ESLint across every package                     |
| `typecheck`         | `tsc --noEmit` across every package             |
| `test`              | Per-package test runner                         |
| `dev`               | Watch-mode dev across every package             |
| `build`             | Production build                                |
| `codegen`           | Run all code generators across every package    |
| `db:generate`       | Drizzle schema → `schema.sql`                   |
| `db:migrate`        | Apply pending Postgres migrations               |
| `db:migrate:create` | Regenerate `schema.sql` + write a new migration |
| `format`            | Prettier write                                  |

## Config

Every environment variable the system reads is documented in
[`.env.example`](./.env.example). Only `DATABASE_URL` is exposed; the
compose stack hardcodes the Postgres bootstrap credentials.
