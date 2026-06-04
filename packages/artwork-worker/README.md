# artwork-worker

Rust service that downloads album covers for the backend's `AlbumArt`
queue using [sacad](https://github.com/desbma/sacad) (v3, the Rust
rewrite) consumed as a library. sacad documents its library API as
internal to its own binaries, so the dependency is pinned to an exact
version; bump it deliberately and re-check `search_and_download`.

This is a Cargo project, not a pnpm workspace package; build it with
`cargo build --release` or via its Dockerfile.

## How it works

1. At startup, rows left `IN_PROGRESS` by a previous run are requeued
   (this worker is the only claimer, so they can only be crash
   orphans), and the artwork directory is probe-written — the process
   exits non-zero if it cannot write, rather than claiming rows it
   would only fail.
2. A `LISTEN album_art_pending` subscription wakes the worker the
   moment the backend inserts or retries a row; a poll tick
   (`ARTWORK_POLL_SECONDS`) catches anything a dropped connection
   missed.
3. Pending rows are claimed oldest-first with
   `FOR UPDATE SKIP LOCKED`, marked `IN_PROGRESS`, and downloaded via
   sacad's `search_and_download` (album artist + album, across the
   configured cover sources) — up to `ARTWORK_MAX_PARALLEL` at a time.
4. A successful download lands in
   `$DISK_CACHE_DIR/artwork/<id>.jpg` and resolves the row to
   `SUCCEEDED`; a `NotFound` result, error or timeout resolves it to
   `FAILED` with the reason recorded for the UI. Either resolution
   clears `isManual` — the row's image (or lack of one) is automatic
   from then on. Failed rows are retried only when the user asks
   (`Mutation.artworkDownload`).

## Env

| Variable                      | Default                        | Meaning                                                                                                                                                      |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                | _required_                     | Postgres connection string                                                                                                                                   |
| `DISK_CACHE_DIR`              | _required_                     | Shared disk-cache root; images go in `artwork/`                                                                                                              |
| `ARTWORK_SIZE`                | `600`                          | Cover size in pixels passed to sacad                                                                                                                         |
| `ARTWORK_COVER_SOURCES`       | `deezer,discogs,itunes,lastfm` | Comma-separated sacad cover sources. `coverartarchive` is excluded by default — its MusicBrainz lookups are rate-limited to 1 req/s and add ~10s+ per search |
| `ARTWORK_MAX_PARALLEL`        | `2`                            | Concurrent sacad downloads                                                                                                                                   |
| `ARTWORK_POLL_SECONDS`        | `30`                           | Fallback poll interval for missed notifications                                                                                                              |
| `ARTWORK_TIMEOUT_SECONDS`     | `120`                          | Per-download timeout before the row is failed                                                                                                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(unset)_                      | OTLP base URL for trace export (e.g. `http://otel-lgtm:4318`). Unset disables tracing entirely; export failures never block downloads                        |
| `RUST_LOG`                    | `info`                         | Log/span filter, e.g. `info,sacad=debug` to see per-source search detail                                                                                     |

Each processed row emits one trace: `artwork.process` (with album,
album artist and queue-wait attributes) wrapping
`sacad.search_and_download` and the `db.*` updates. SIGTERM/SIGINT
shut down gracefully — in-flight downloads finish and pending spans
flush before exit.

## Tests

There are no unit tests in this package: the worker is a thin
orchestration shell around postgres and the sacad library, and is
exercised end-to-end via `docker compose up` (request art in the web
UI and watch the row resolve).
