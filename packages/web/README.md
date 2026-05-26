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

## Playback

The quality picker in the header maps to a coarse preset:

| Choice          | What the player does                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Max (lossless)  | Sends `Accept: audio/flac, <fallback>`. Server passes the source through when it's already FLAC, otherwise encodes the first fallback at the highest preset. Bare `<audio>` plays the FLAC blob; no MSE. Disabled when the browser cannot decode FLAC. |
| High / Med / Low | Sends `Accept: <encoded-formats>` and the matching `quality` GraphQL enum. The server picks the first acceptable container (mp4/opus or mp3) and chunks it; the player consumes the chunks via MSE.                                  |

`Accept` is derived once per page load from `MediaSource.isTypeSupported`
checks and `<audio>.canPlayType('audio/flac')`. MSE failures or
unreachable endpoints raise a toast.

## Tag editing

Rows in the track list are selectable: click to select one, cmd/ctrl-click
to toggle, shift-click to extend a range. Right-clicking opens a context
menu with **Edit tags**, which opens a dialog over the selection. Editing a
single track exposes every tag; with multiple tracks selected the dialog
restricts to the album-shared tags (artist, album, CD, year) and leaves any
blank field unchanged. Saving issues one `trackUpdate` mutation per selected
track and refetches the list. Clearing a field on a single track reverts it
to the tag scanned from the file.

## Env

| Variable                  | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `VITE_GRAPHQL_URL`        | Backend GraphQL endpoint (default `/graphql`) |
| `VITE_GRAPHQL_STREAM_URL` | SSE endpoint (default `/graphql/stream`)      |
