import { z } from 'zod';

const Schema = z.object({
  /** Postgres connection string used by the Drizzle pool and migrator. */
  DATABASE_URL: z.string().url().optional(),

  /** Interface the HTTP server binds to. `0.0.0.0` exposes it on all interfaces. */
  BACKEND_HOST: z.string().default('0.0.0.0'),

  /** TCP port the HTTP server listens on. */
  BACKEND_PORT: z.coerce.number().int().positive().default(4000),

  /** Absolute path to the music library root. */
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

  /** Persistent directory where the unified per-entry cache writes `<trackId>-<mtimeMs>/<targetKey>.{bin,idx}`. Survives process restarts; the `.idx` sidecar is the durable manifest. Defaults to `${os.tmpdir()}/lofify-cache`. */
  PLAYBACK_CACHE_DIR: z.string().optional(),

  /** Absolute path to the built web client (`vite build` output). When unset, defaults to the workspace's `packages/web/dist`. The backend serves these as a catch-all SPA route when the directory exists. */
  WEB_DIST_PATH: z.string().optional(),

  /** OTLP/HTTP base URL. Receivers expose `/v1/traces`, `/v1/logs`, `/v1/metrics` under it. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://otel-lgtm:4318'),

  /** Service name tagged on every span and log record. */
  OTEL_SERVICE_NAME: z.string().default('lofify-backend'),
});

export const env = Schema.parse(process.env);
export type Env = typeof env;
