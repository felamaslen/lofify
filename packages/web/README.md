# @lofify/web

Vite + React web client for Lofify. Single-route SPA built with TanStack
Router, TanStack Query, and TanStack Virtual; GraphQL operations are
typed with [`gql.tada`](https://gql-tada.0no.co/).

## Scripts

| Script            | What it does                                 |
| ----------------- | -------------------------------------------- |
| `dev`             | Vite dev server on port 5173                 |
| `build`           | `tsc --noEmit` + `vite build`                |
| `preview`         | Serve the built bundle locally               |
| `typecheck`       | `tsc --noEmit`                               |
| `lint`            | ESLint over `src`                            |
| `download-schema` | Pull the live SDL from the backend           |
| `gql:generate`    | Regenerate the gql.tada introspection output |

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

Playback is MSE-only. A gear button in the playback bar's right section
opens a settings dialog holding the library rescan, quality and preferred
format controls:

- **Quality** — `Max` asks for the best representation of the source the
  browser can play (lossless or a copy where possible); the lower tiers
  (`High`/`Med`/`Low`/`Min`) force a transcode at an ascending bitrate.
  Changing quality between sub-`Max` tiers applies **live mid-track**: the
  codec is unchanged, so the new bitrate splices into the existing buffer
  with no gap. Changes that cross a codec boundary (to/from `Max`, or
  switching the codec preference) take effect on the next track instead.
- **Codec** — a _preference_ used only when the server has to transcode
  (below Max, or a lossy source at Max with no matching copy): `Prefer
Opus` or `Prefer MP3`. At Max, sources are copied without re-encoding
  where possible; below Max everything is transcoded to this codec.

`capabilities.ts` probes `MediaSource.isTypeSupported` once per page load
and exposes the supported formats as the preference-ordered
`losslessFormats` / `lossyFormats` MIME lists. The player sends these
plus `quality` as the `TrackFormat`, and reads `Track.delivery` back —
`{ url, mimeType, isPassthrough, description }` — so it learns the
SourceBuffer MIME type and a tooltip-ready summary in one query, then
streams chunk byte ranges via the `trackManifest` subscription (see the
backend README). The format badge by the track title shows the resolved
codec, distinguishing a copy (no re-encode) from a transcode, with
`description` as its tooltip. MSE failures or unreachable endpoints raise
a toast.

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
