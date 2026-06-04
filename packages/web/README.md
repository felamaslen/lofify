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

- **Quality** — three modes. `Adaptive` transcodes to a lossy tier whose
  bitrate is chosen automatically from the measured connection speed,
  switching tiers on the fly mid-track. `Original` asks for the best
  representation of the source the browser can play (lossless or a copy
  where possible) and assumes the connection can sustain it. `Smart` (the
  default) follows `Adaptive` for lossless sources but lets a lossy source
  the browser can play through **verbatim** — like `Original`, so it's never
  re-compressed — falling back to an adaptive transcode for a lossy source
  the browser can't play. Its purpose is to avoid double-lossy playback
  wherever possible. The wire protocol is unchanged — `Original` requests the
  `MAX` tier, `Adaptive` and `Smart` request one of
  `MIN`/`LOW`/`MEDIUM`/`HIGH` picked at runtime; `Smart` additionally sets the
  `autoPassthrough` flag, which the server honours by copying a playable lossy
  source through at full quality rather than transcoding it to that tier. The
  player then reads back `delivery.isPassthrough` to know when a track came
  through untouched and stops adapting it (a verbatim copy has a fixed bitrate
  — there's no tier to climb).

  In `Adaptive` (and a `Smart` track being transcoded), a bitrate step is a
  same-codec change, so it applies **live mid-track**: the new bitrate splices
  into the existing buffer with no gap, and already-buffered audio ahead of
  the playhead is re-fetched at the new tier in the background (overwriting in
  place, so playback never stalls) rather than waiting for the old buffer to
  drain. Switching mode can cross a codec boundary, so the player reloads at
  the current playback position.

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
  (Adaptive; a lossy source in Original or Smart with no matching copy; or a
  lossless source in Smart): `Opus` or `MP3`. In Original, sources are copied
  without re-encoding where possible; in Adaptive everything is transcoded to
  this codec; Smart copies a playable lossy source and transcodes the rest.

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
popover on touchscreens). A leading icon names the active quality policy
(`Gauge` for Adaptive, `Wand2` for Smart, `Disc3` for Original), so
the badge says both _what_ is playing and _why_. When `delivery.isMultiLossy`
is set — a lossy source re-encoded to a lossy output — a small amber warning
triangle is overlaid on the policy icon's bottom-right corner, flagging the extra
generation of compression loss. MSE failures or unreachable endpoints raise a
toast.

Each playback range response carries an `X-Quality` header naming the
tier its bytes were encoded at. The player records it per fetched chunk
and exposes the value under the playhead as `playingQuality`. The format
badge shows this effective tier (falling back to `requestedTier` before
the first chunk reports), and fades while the two disagree — i.e. during
an on-the-fly switch whose old-quality buffer hasn't drained yet. A
passthrough copy is exempt: the server serves it as `MAX` while the request
carried a ladder tier, so the two never converge and that's the resting
state, not a switch. (The backend must expose `X-Quality` via CORS
`exposedHeaders` for cross-origin reads.)

Fetched chunk bytes are cached in IndexedDB (`lib/chunk-cache.ts`), so
replays, seek-backs and fresh PWA launches don't re-download audio. The
browser's HTTP cache can't do this natively — it never stores the route's
`206 Partial Content` responses, and it can only answer a `Range` request
by slicing a complete cached body, which never exists because the player
only ever fetches ranges. Entries are keyed by signed URL + byte range
(so each tier caches separately), only responses the server marks
`immutable` are stored, and the cache is capped at 250 MB with
oldest-first eviction. A cache hit produces no ABR transfer sample — a
disk read would register as near-infinite bandwidth — so adaptation only
reacts to real network fetches.

## Visualiser

A waveform button (`AudioLines`) sits in the playback bar's transport row,
just after previous / play-pause / next. Toggling it swaps the track list
for a full-bleed **aurora visualiser** of the playing track
(`components/visualiser.tsx`): a soft glowing blob, drawn on a `<canvas>`
each animation frame, built from **composable, simultaneously-visible
layers** so different music looks different and layered music looks
layered. Eight log-spaced frequency bands each drive their own low-order angular
harmonic of the rim, so it stays rounded while coexisting timbres swell it
together. The fill is a simple two-stop radial gradient — a `from` colour at
the core to a `to` colour at the rim — taken from a palette that the overall
timbre (brightness) **rotates**, so different tracks land on very different
colour schemes. On top of that: it punches with each bass kick; spectral
flatness (noisy vs tonal) roughens the edge only for noisy material; spectral
flux (how fast the spectrum moves) sets the swirl speed; treble energy flings
additive sparks off the rim; and a detected bass onset fires an expanding
ring. The active state lives in `state/visualiser.tsx` (`VisualiserProvider`
/ `useVisualiser`) and is ephemeral — a view mode, not a saved preference.

The spectrum comes from a Web Audio `AnalyserNode` (`lib/audio-analyser.ts`),
created lazily the first time the visualiser is opened. Crucially it taps a
**parallel `captureStream()`** of the `<audio>` element rather than
`createMediaElementSource`: the element keeps playing straight to the
output untouched, so opening the visualiser causes no audible break and
playback never depends on the context (a suspended context just freezes the
bars). The context is created suspended and resumed inside the toggle's
click gesture. The button is feature-gated (`isVisualiserSupported`) to
non-touch devices with `captureStream` — i.e. desktop Chromium/Firefox, not
Safari.

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
fed by MSE, straight to the output — never through an `AudioContext`, which
browsers suspend when hidden. (The visualiser's analyser context is a
parallel tap that carries no audio, so it doesn't change this.)
The `Player` (`state/player.tsx`) wires `navigator.mediaSession` so the OS
treats us like a media app: it publishes track metadata (title, artist,
album, with the track's downloaded cover as artwork — the app icon when
there is none), keeps `playbackState` and the lock-screen scrub position in
sync, and handles the hardware/lock-screen
`play`/`pause`/`previoustrack`/`nexttrack`/`seekto` controls. The Media
Session handlers are what stop mobile platforms (iOS especially) from
pausing hidden web audio.

## Album art

`components/track-artwork.tsx` owns the artwork UI: a colocated
`TrackArtwork` fragment, a `useTrackArtwork` hook and the `ArtworkTile`
renderer (cover image, spinner while a download runs, and a warning
triangle on failure — the reason rides the tooltip, and clicking
retries). A never-requested track is requested automatically the
moment its artwork is previewed; only a FAILED row waits for a manual
retry. Either way the hook calls `Mutation.artworkDownload` and polls
`Track.artwork` every 2s until the row resolves, sharing one TanStack
Query key per track so no two consumers poll the same track twice.

Everything rendered (tiles and the Media Session cover alike) uses
`media.preview(size: SQUARE_500).src` — the immutably-cached AVIF
square from the API's `/asset` route. The original `media.url` is
served no-store and is never used for display.

While a track with a cover plays, the favicon becomes the cover, with
the app icon as a badge in the lower-right corner (`lib/favicon.ts`
composites them on a canvas and swaps the `<link rel="icon">` to a
data URL; stopping playback restores the original icon). Artwork loads
with `crossOrigin: anonymous` so the canvas stays exportable.

Artwork can also be set by hand: dropping an image onto the tile (in
any state — replacing an existing cover included) uploads it via
`Mutation.trackUpdate`'s `artwork` argument as a GraphQL multipart
request (`gqlUpload` in `lib/gql-request.ts`), and the album's art
swaps to the dropped image. An image dragged from another browser tab
arrives as a URL rather than a file; the server downloads it
(`trackUpdate`'s `artworkUrl` argument — client-side fetching would be
blocked by CORS on most image hosts) and stores it exactly like an
upload, with the same size cap and magic-byte sniffing. A manually set
cover shows a bin button on hover in the info popover; clicking it
(`Mutation.artworkClear`) removes the image and requeues an automatic
download.

It surfaces in two places. The playback bar shows a 40px thumbnail next
to the playing track's title (seeded by the fragment riding the
player's track fetch, so the common case costs no extra request) and
feeds the resolved cover to the Media Session as it lands. The track
info popover shows a full-width preview, fetched lazily on open rather
than carried by the list fragment — embedding artwork there would fan
the resolver out to every visible row.

## Update indicator

`autoUpdate` swaps in a fresh service worker on the next visit, but a
long-lived tab can drift behind a live deployment. `UpdateIndicator`
(`components/update-indicator.tsx`) closes that gap. It owns an `UpdateIndicator`
fragment on `Query` (`isUpdateAvailable(version: $appVersion)`) that the home
bootstrap query (`HomeDocument` in `routes/home.tsx`) spreads alongside the
initial track window, so the flag arrives with the first paint. The indicator
seeds its initial value from that cached result and, kept never-stale
(`staleTime: Infinity`), defers its own first request to the first poll a minute
later. When the server reports a newer build it shows a small pulsing dot in
the top-right of the header; clicking it reloads the page, letting the service
worker pick up the new app shell. In development `VITE_GIT_SHA` is `dev` (see
`lib/version.ts`) and the server suppresses the prompt, so the dot never appears.

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
blank field unchanged. The form is built on TanStack Form: per-field
touched state drives both the `(multiple values)` placeholder and which
fields a multi-edit submits. Saving issues one `trackUpdate` mutation per
selected track and refetches the list. Clearing a field on a single track
reverts it to the tag scanned from the file.

When every selected track shares one artist, the dialog also lists that
artist's search **synonyms** with inline add/rename/remove. These apply
immediately via `artistSynonym{Create,Update,Delete}` (independently of the
tag form's Save); the section is hidden when the selection spans more than
one artist.

## Env

| Variable                  | Purpose                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_GRAPHQL_URL`        | Backend GraphQL endpoint (default `/graphql`)                                                                                                                                              |
| `VITE_GRAPHQL_STREAM_URL` | SSE endpoint (default `/graphql/stream`)                                                                                                                                                   |
| `VITE_GIT_SHA`            | Git commit this bundle was built from, baked in at build time (default `dev`). Sent to `Query.isUpdateAvailable` to detect a newer deployment — see [Update indicator](#update-indicator). |
