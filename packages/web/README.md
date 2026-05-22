# @lofify/web

Vite + React web client for Lofify. Single-route SPA built with TanStack
Router, TanStack Query, and TanStack Virtual.

## Scripts

| Script      | What it does                          |
| ----------- | ------------------------------------- |
| `dev`       | Vite dev server on port 5173          |
| `build`     | `tsc --noEmit` + `vite build`         |
| `preview`   | Serve the built bundle locally        |
| `typecheck` | `tsc --noEmit`                        |
| `lint`      | ESLint over `src`                     |

## Env

| Variable                  | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `VITE_GRAPHQL_URL`        | Backend GraphQL endpoint (default `/graphql`) |
| `VITE_GRAPHQL_STREAM_URL` | SSE endpoint (default `/graphql/stream`)      |
