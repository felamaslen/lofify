import { z } from 'zod';

const Schema = z.object({
  /** Postgres connection string used by the Drizzle pool and migrator. */
  DATABASE_URL: z.string().url().optional(),

  /** Interface the HTTP server binds to. `0.0.0.0` exposes it on all interfaces. */
  BACKEND_HOST: z.string().default('0.0.0.0'),

  /** TCP port the HTTP server listens on. */
  BACKEND_PORT: z.coerce.number().int().positive().default(4000),

  /** Comma-separated list of absolute paths to the music library roots. The scanner and chokidar watcher cover every listed directory; a single path (no comma) is the common case. */
  LIBRARY_PATH: z.string(),

  /** Maximum number of files the scanner parses and upserts in parallel. */
  SCAN_CONCURRENCY: z.coerce.number().int().positive().default(4),

  /** Cron expression for the scheduled full library scan. Empty disables the schedule (manual `Mutation.libraryScan` still works). */
  SCAN_CRON: z.string().default('0 2 * * *'),

  /** Comma-separated allowlist of origins for browser CORS. `*` allows any. Default permits the Vite dev server. */
  CORS_ALLOW_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),

  /** HMAC secret used to sign and verify playback URLs. */
  PLAYBACK_SIGNING_SECRET: z.string().default('dev-secret'),

  /** Maximum number of concurrent ffmpeg encode processes. */
  TRANSCODE_MAX_PARALLEL: z.coerce.number().int().positive().default(12),

  /** Persistent root of the on-disk cache. Playback entries live under `transcode/<trackId>-<mtimeMs>/<targetKey>.{bin,idx}` (the `.idx` sidecar is the durable manifest) and downloaded album art under `artwork/<albumArtId>.jpg`. Survives process restarts. Defaults to `${os.tmpdir()}/lofify-cache`. */
  DISK_CACHE_DIR: z.string().optional(),

  /** Soft byte budget for the on-disk playback cache. When set, completed entries are swept least-recently-accessed-first once total usage exceeds this value. Unset disables sweeping, leaving the cache unbounded. */
  DISK_CACHE_MAX_BYTES: z.coerce.number().int().positive().optional(),

  /** Maximum size of a file sent with a GraphQL multipart request (e.g. `trackUpdate`'s artwork upload). Defaults to 10 MiB — generous for an album cover. */
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),

  /** Public base URL of the API (e.g. `https://music.example.com`), used to build absolute `Media.url` values. */
  PUBLIC_URL: z.string().url(),

  /** Cron expression for the periodic cache sweep. Empty disables the schedule (the post-transcode and ENOSPC sweeps still run). Has no effect unless `DISK_CACHE_MAX_BYTES` is set. */
  DISK_CACHE_SWEEP_CRON: z.string().default('*/15 * * * *'),

  /** Grace window, in seconds, during which a recently-accessed cache entry is never evicted even when over budget. Protects entries an in-flight playback session still depends on (the on-disk files outlive the in-memory handle). Must exceed the 60s access-write throttle. */
  DISK_CACHE_SWEEP_GRACE_SECONDS: z.coerce.number().int().positive().default(300),

  /** Absolute path to the built web client (`vite build` output). When unset, defaults to the workspace's `packages/web/dist`. The backend serves these as a catch-all SPA route when the directory exists. */
  WEB_DIST_PATH: z.string().optional(),

  /** OTLP/HTTP base URL. Receivers expose `/v1/traces`, `/v1/logs`, `/v1/metrics` under it. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://otel-lgtm:4318'),

  /** Service name tagged on every span and log record. */
  OTEL_SERVICE_NAME: z.string().default('lofify-backend'),

  /** Git commit SHA this server was built from, baked in at image build time. Compared against the client's build SHA by `Query.isUpdateAvailable`. The `dev` default means "unknown", which suppresses the client's update prompt during local development. */
  GIT_SHA: z.string().default('dev'),
});

export const env = Schema.parse(process.env);
export type Env = typeof env;

/** The configured music library roots, parsed from the comma-separated `LIBRARY_PATH`. */
export const libraryPaths: string[] = env.LIBRARY_PATH.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Resolve an API-served path (e.g. `/artwork/<file>`) against `PUBLIC_URL`, yielding the absolute URL clients use. */
export function publicUrl(path: string): string {
  return new URL(path, env.PUBLIC_URL).toString();
}
