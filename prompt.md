I want to build a music player. Let's not build anything yet, but add a plan file in plan.md. The plan should be readable
  by claude and separated into buildable chunks, documenting current state. I'm thinking:

  - Scaffold: pnpm monorepo. Dockerfile with docker-compose (separate prod and dev docker compose files).
  - Code guidelines:
    - Always document DB schema written in TS, using jsdoc, unless purpose is obvious.
    - Do not put new lines inside jsdoc comments, except to separate paragraphs.
    - Always document graphql schema written with grats, using jsdoc, unless purpose is obvious. Never reference implementation details or anything that the client doesn't need to know about.
    - Tests: use fastify inject to run tests on graphql operations. Do NOT import implementations; tests should be behavioural in general. E.g. pass a GraphQL query into fastify inject, assert on observable response only.
    - GraphQL: mutations always return non-null type, queries always return nullable type
    - Authorisation: out of scope for MVP.
  - Backend package:
    - Postgres DB
    - Drizzle schema (typescript code-first schema)
    - Migrations: use https://github.com/felamaslen/drizzle-pg-kit-migrator
    - API: fastify + graphql using apollo and grats
  - Observability: otel-lgtm container for local dev. Otel config on backend service.
  - Music library:
    - Table in database: `Tracks`:
      - id uuidv7 PK
      - createdAt date
      - updatedAt date
      - scannedAt date # updates whenever track is re-scanned
      - title text
      - trackNumber int
      - discNumber int
      - artist text index
      - album text index
      - year text
      - format enum (pg TrackFormat enum, defines supported mime types for raw source files. E.g. flac, ogg, mp3, wma)
      - codec text (e.g. vorbis, opus, aac)
      - bitRate int (e.g. 192, 320, null implies vbr)
      - sampleRate int (in Hz, e.g. 44100)
      - isLossless bool
      - file text unique (absolute path to file on disk)
      - sizeBytes int
      - durationSeconds int
    - scanner: separate package written in rust (can have a pnpm package.json to have build/start commands but the logic
  should be in rust):
      - Exposes command to rescan entire library (library passed as an argument, refers to a directory on disk)
        - Command returns a unique (per-scan) ephemeral ID
        - Expose another command to get status of an existing scan (including progress: number of files scanned, left to do, list of errors. This state should all live in memory and be wiped after the scan is complete.)
      - Runs long-running process to watch library directories for changes
        - Additions: scan file and upsert into Tracks
        - Deletions: remove from Tracks if present
        - Changes (if possible): scan and upsert
      - Rescan can be scheduled using cron running the rescan command (the scanner package is explicitly not responsible for
  this)
    - API:
      - GraphQL type Void { _: Boolean } (returned by mutations which are noops)
      - Mutation.libraryScan: LibraryScan!
      - type LibraryScan { id: ID!, scannedTotal: Int!, errorsTotal: Int!, filesTotal: Int! }
      - Subscription.libraryScan(id: ID!): LibraryScan
        - Sends updates (set this up using SSE on `GET /graphql/stream`) every second while scan is in progress
      - Query.tracks(first, last, before, after): TrackConnection
        - Use full relay connection, sort by artist/album/disc number/track number
      - Query.track(id: ID!): Track
      - type Track {
        id: ID!
        url(
          "Normalised quality value. 10 always means original assuming `format` matches (passthrough). 0 is lowest."
          quality: Int @constraint(min: 0, max: 10) # add constraint directive using @gqlDirective
          "Specify format for streaming. If using `ORIGINAL`, it is up to the client to ensure it supports the original file format."
          format: Format # gql enum. Allowed values: ORIGINAL, AUTO_HI, AUTO_LO, AAC, OGG, WEBM, FLAC
        ): String! # signed URL for playback
        title: String!
        artist: String
        album: String
        year: String
        duration: Duration! # new type. It should be constructed using number of seconds, and expose this value as well as a formatted value like 05:32 as a different field like Duration.formatted
        isLossless: Boolean!
        format: String! # map db format + codec to string value. E.g. "ogg vorbis", "mp3", "webm opus" etc
      }
      - Playback: `GET /play/{signature}/{options}/{id}`
        - options: passed like `f:aac:q:7` (e.g. to specify aac format, normalised quality 7)
          - all options are optional and the field can be empty. Parse it with zod
        - id: Track.id as returned in graphql
        - signature is hmac of `{options}/{id}` signed with secret on the backend (so client cannot change the options in the URL without getting new URL from server)
        - support 206 partial content requests
        - return Content-type header with mime and codec e.g. `audio/ogg; codecs=vorbis`
        - behaviour when requesting file with a format matching the source format, and no quality options (i.e. passthrough):
          - get the size of the file to set content-length. If a Range request, support 206 partial content and read the requested range from disk, streaming that to the client. Otherwise stream the whole file.
        - behaviour when specifying a quality value, or format other than the source format:
          - transcode with ffmpeg
          - stream directly from ffmpeg where possible
          - keep LRU cache (ttl + max size set in env) with all recently created ffmpeg streams.
          - range requests should hit the LRU cache and serve 206 partial content. This should be possible even before ffmpeg has fully streamed the result. Use a semaphore or similar to ensure at most one ffmpeg process for a given set of args can exist at once, and at most X ffmpeg processes can run in parallel (X set in env).
        - auto formats:
          - auto hi rules:
            - if source is lossless, choose flac
            - if source is lossy, choose original (passthrough)
          - auto lo rules:
            - always choose webm/opus with sane vbr quality level
    - UI:
        - tanstack router web app
        - simple view on /:
          - infinitely scrolling list of tracks (virtualise this with tanstack virtual)
          - tracks show disc/track/title/duration/artist/album/year columns
          - format picker (for now just support auto (hi), auto (lo), flac and webm)
          - double clicking a track in the list triggers a request for its `url` and for it to then start playing
          - playback bar: play/pause, next track, previous track, playback gutter, info of current song
            - next/prev track can use `Query.tracks(first: 1, after: {currentlyPlayingId}) { edges { node { url(...) } } }` etc.
            - playback gutter can show playhead regardless of whether ffmpeg has finished streaming, since we know the playback duration.
