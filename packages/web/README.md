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

- **Quality** — two modes. `Adaptive` transcodes to a lossy tier whose
  bitrate is chosen automatically from the measured connection speed,
  switching tiers on the fly mid-track. `Original` asks for the best
  representation of the source the browser can play (lossless or a copy
  where possible) and assumes the connection can sustain it. The wire
  protocol is unchanged — `Original` requests the `MAX` tier, `Adaptive`
  requests one of `MIN`/`LOW`/`MEDIUM`/`HIGH` picked at runtime.

  In `Adaptive`, a bitrate step is a same-codec change, so it applies
  **live mid-track**: the new bitrate splices into the existing buffer
  with no gap, and already-buffered audio ahead of the playhead is
  re-fetched at the new tier in the background (overwriting in place, so
  playback never stalls) rather than waiting for the old buffer to drain.
  Toggling between `Adaptive` and `Original` crosses a codec boundary, so
  the player reloads at the current playback position.

  The adaptation is stepwise (`state/player.tsx` + `lib/bandwidth.ts`):
  each chunk fetch feeds a dual-EWMA throughput estimate that excludes
  TTFB (timed first-byte→last-byte, since the `/play` route blocks on
  encode before sending); the controller compares it against the current
  tier's measured data rate, gated on buffer health and a cooldown, and
  climbs or drops one tier. No bitrate table is kept on the client — only
  the last-used tier is remembered (per session), so a track cold-starts
  where the previous left off.

- **Codec** — a _preference_ used only when the server has to transcode
  (Adaptive, or a lossy source in Original with no matching copy): `Prefer
Opus` or `Prefer MP3`. In Original, sources are copied without re-encoding
  where possible; in Adaptive everything is transcoded to this codec.

`capabilities.ts` probes `MediaSource.isTypeSupported` once per page load
and exposes the supported formats as the preference-ordered
`losslessFormats` / `lossyFormats` MIME lists. The player sends these
plus the requested tier as the `TrackFormat`, and reads `Track.delivery` back —
`{ url, mimeType, isPassthrough, description }` — so it learns the
SourceBuffer MIME type and a tooltip-ready summary in one query, then
streams chunk byte ranges via the `trackManifest` subscription (see the
backend README). The format badge by the track title shows the resolved
codec, distinguishing a copy (no re-encode) from a transcode, with
`description` as its tooltip. MSE failures or unreachable endpoints raise
a toast.

Each playback range response carries an `X-Quality` header naming the
tier its bytes were encoded at. The player records it per fetched chunk
and exposes the value under the playhead as `playingQuality`. The format
badge shows this effective tier (falling back to `requestedTier` before
the first chunk reports), and fades while the two disagree — i.e. during
an on-the-fly switch whose old-quality buffer hasn't drained yet.
(The backend must expose `X-Quality` via CORS `exposedHeaders` for
cross-origin reads.)

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
