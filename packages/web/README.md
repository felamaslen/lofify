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

## Appearance

The colour scheme is a three-way toggle in Settings — `System`, `Light`,
`Dark` (icon buttons) — defaulting to `System`, which follows the
browser's `prefers-color-scheme` and re-resolves live when the OS
preference flips. The choice is held in `state/theme.tsx`
(`ThemeProvider` / `useTheme`) and persisted in `localStorage`
(`lofify.app.theme`). It toggles a `dark` class on `<html>` (Tailwind's
`darkMode: 'class'`); `styles.css` defines the light palette on `:root`
and the dark overrides under `.dark`, both as HSL CSS variables. An inline
script in `index.html` applies the class before first paint to avoid a
flash of the wrong theme, and the `theme-color` meta tag is kept in sync
with the active background.

## Playback

Playback is MSE-only. A gear button in the playback bar's right section
opens a settings dialog holding the appearance, library rescan, quality
and preferred format controls (the latter two are pill toggles —
`ToggleGroup`):

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

  The adaptation is best-fit (`state/player.tsx`): downloads are timed
  body-only (first-byte→last-byte, excluding TTFB — the `/play` route blocks
  on encode before sending, so TTFB is encode-wait not line speed), and the
  controller sizes that **current observed speed** against each tier's
  _advertised_ bitrate (`delivery.tiers`), jumping **straight to the best
  fit** rather than stepping one tier at a time. There's no moving average:
  line speed is bursty (a 5G→LTE handover is a step-change a smoothed
  estimate would lag), so the controller reacts to the latest observation and
  leans on hysteresis (an up/down factor) plus a cooldown to stay stable. The
  last-used tier is remembered (per session), so a track cold-starts where
  the previous left off.

  The two directions are split by urgency, so each is checked where it can
  act in time — every switch logged to the console as `[abr] [upscale]` /
  `[abr] [downscale]` with its reason:
  - **Downscaling** is time-critical (a stall looms), so it's driven by the
    download that's **still in flight** rather than the completed fetch: the
    reconcile loop stops fetching once the forward buffer is full, and a
    completed-fetch sample lands too late — by then a collapsed link has
    drained the buffer. The player samples the open response body as it
    streams; the moment the live speed can't sustain the current tier it
    drops straight to the highest tier that fits, aborting the doomed
    high-bitrate fetch.
  - **Upscaling** happens only on a completed fetch, where there's a full,
    confident sample and the buffer headroom to justify climbing — it can't
    sensibly abort a healthy in-flight download to go up.

- **Codec** — a _preference_ used only when the server has to transcode
  (Adaptive, or a lossy source in Original with no matching copy): `Opus`
  or `MP3`. In Original, sources are copied without re-encoding where
  possible; in Adaptive everything is transcoded to this codec.

`capabilities.ts` probes `MediaSource.isTypeSupported` once per page load
and exposes the supported formats as the preference-ordered
`losslessFormats` / `lossyFormats` MIME lists. The player sends these
plus the requested tier as the `TrackFormat`, and reads `Track.delivery` back —
`{ url, mimeType, isPassthrough, isMultiLossy, description, tiers }` — so it
learns the SourceBuffer MIME type and a tooltip-ready summary in one query,
then streams chunk byte ranges via the `trackManifest` subscription (see the
backend README). The format badge by the track title shows the resolved
codec, distinguishing a copy (no re-encode) from a transcode, with
`description` revealed by a `Hint` (hover tooltip on pointer devices, tap
popover on touchscreens). When `delivery.isMultiLossy` is set — a lossy
source re-encoded to a lossy output — an amber warning triangle sits to its
left, flagging the extra generation of compression loss. MSE failures or
unreachable endpoints raise a toast.

Each playback range response carries an `X-Quality` header naming the
tier its bytes were encoded at. The player records it per fetched chunk
and exposes the value under the playhead as `playingQuality`. The format
badge shows this effective tier (falling back to `requestedTier` before
the first chunk reports), and fades while the two disagree — i.e. during
an on-the-fly switch whose old-quality buffer hasn't drained yet.
(The backend must expose `X-Quality` via CORS `exposedHeaders` for
cross-origin reads.)

## PWA & background playback

The client is an installable PWA. `vite-plugin-pwa` (configured in
`vite.config.ts`, `generateSW` mode) emits the `manifest.webmanifest`,
icons (`public/icon-{192,512}.png`, `public/maskable-512.png`,
`public/apple-touch-icon.png`, all rasterised from the SVG logo) and a
Workbox service worker that precaches the **app shell only** — JS, CSS,
HTML and icons. Audio ranges and GraphQL are deliberately excluded: they're
large and dynamic, and the player streams them itself. The SW registers on
load with `registerType: 'autoUpdate'`, so a new build is picked up silently
on the next visit.

Playback keeps going when the tab is backgrounded or the screen locks
because audio runs through a single `<audio>` element (`lib/audio-element.ts`)
fed by MSE — there's no `AudioContext`, which browsers suspend when hidden.
The `Player` (`state/player.tsx`) wires `navigator.mediaSession` so the OS
treats us like a media app: it publishes track metadata (title, artist,
album, with the app icon as stand-in artwork), keeps `playbackState` and the
lock-screen scrub position in sync, and handles the hardware/lock-screen
`play`/`pause`/`previoustrack`/`nexttrack`/`seekto` controls. The Media
Session handlers are what stop mobile platforms (iOS especially) from
pausing hidden web audio.

## Search

The search box in the header runs `Query.search` as you type (debounced),
showing a keyboard-navigable dropdown grouped into artists, albums, and
tracks (↑/↓ to move, Enter to choose, Esc to close). Choosing a track
plays it; choosing an artist or album sets a library filter — held in a
`LibraryFilterProvider` context that the track list reads into its
`tracks(filterArtistIn:/filterAlbumIn:)` query. Choosing an album pins
its artist only when the album is credited to exactly one. The active
filter is mirrored into the URL (`?artist=` / `?album=`, alongside the
player's `track`/`t` params) so a refresh or shared link restores it,
and shows as a chip beside the search box; click it to clear.

## Track list scrolling

The list is window-virtualised (the page scrolls, not an inner box) and
loaded by **index**, not cursor: it fetches only the index-pages covering
the visible range via `tracks(offset:)`, so jumping anywhere loads just
that window instead of paging through the gap. `tracks` still reports
`totalCount`, which sizes the scrollbar to the whole library up front;
unloaded rows render as placeholders until their window arrives.

An A–Z **letter scrubber** is pinned to the right edge (`LetterScrubber`).
It reads `Query.artistIndex` for each first-letter bucket's starting
index: the active letter updates as you scroll, and tapping or dragging
(mouse or touch) jumps to that letter's offset. Letters with no tracks
are dimmed and snap to the next populated bucket.

## Duplicates

By default the list shows only the canonical (highest-quality) copy of
each duplicated recording; the **Show duplicate tracks** tickbox in
Settings reveals the rest. The preference lives in `localStorage`
(`useShowDuplicates`) and is passed as `includeDuplicates` to every list
query and the player's next/previous walk, so playback skips hidden
copies too.

The trailing column is an **info** button (replacing the old source
badge) opening a popover (`TrackInfoButton`) with the source codec and
quality (bitrate or sample rate / bit depth, channels, codec profile),
the list of duplicate sources, and when the track was scanned and last
updated.

## Tag editing

Rows in the track list are selectable: click to select one, cmd/ctrl-click
to toggle, shift-click to extend a range. Right-clicking opens a context
menu with **Edit tags**, which opens a dialog over the selection. Editing a
single track exposes every tag; with multiple tracks selected the dialog
restricts to the album-shared tags (artist, album, CD, year) and leaves any
blank field unchanged. Saving issues one `trackUpdate` mutation per selected
track and refetches the list. Clearing a field on a single track reverts it
to the tag scanned from the file.

When every selected track shares one artist, the dialog also lists that
artist's search **synonyms** with inline add/rename/remove. These apply
immediately via `artistSynonym{Create,Update,Delete}` (independently of the
tag form's Save); the section is hidden when the selection spans more than
one artist.

## Env

| Variable                  | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `VITE_GRAPHQL_URL`        | Backend GraphQL endpoint (default `/graphql`) |
| `VITE_GRAPHQL_STREAM_URL` | SSE endpoint (default `/graphql/stream`)      |
