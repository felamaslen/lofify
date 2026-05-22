# @lofify/web

Vite + React web client for Lofify. Single-route SPA built with TanStack
Router, TanStack Query, and TanStack Virtual; GraphQL operations are
typed with [`gql.tada`](https://gql-tada.0no.co/).

## Scripts

| Script            | What it does                                    |
| ----------------- | ----------------------------------------------- |
| `dev`             | Vite dev server on port 5173                    |
| `build`           | `tsc --noEmit` + `vite build`                   |
| `preview`         | Serve the built bundle locally                  |
| `typecheck`       | `tsc --noEmit`                                  |
| `lint`            | ESLint over `src`                               |
| `download-schema` | Pull the live SDL from the backend              |
| `gql:generate`    | Regenerate the gql.tada introspection output    |

## GraphQL typings

Operations are written with [`gql.tada`](https://gql-tada.0no.co/), driven
by the SDL checked in at `schema.graphql`. To refresh it against a running
backend:

```sh
pnpm download-schema   # GETs /graphql/schema.graphql from the backend
pnpm gql:generate      # rewrites src/graphql-env.d.ts
```

Set `SCHEMA_URL` to point at a non-default backend (defaults to
`http://localhost:4000/graphql/schema.graphql`).

## Env

| Variable                  | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `VITE_GRAPHQL_URL`        | Backend GraphQL endpoint (default `/graphql`) |
| `VITE_GRAPHQL_STREAM_URL` | SSE endpoint (default `/graphql/stream`)      |
