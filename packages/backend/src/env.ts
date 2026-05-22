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

  /** Maximum number of concurrent ffmpeg transcode processes. */
  TRANSCODE_MAX_PARALLEL: z.coerce.number().int().positive().default(12),

  /** Soft upper bound on bytes held in the in-memory transcode cache. */
  TRANSCODE_CACHE_MAX_BYTES: z.coerce.number().int().positive().default(1_073_741_824),

  /** How long a cached transcode survives after its last access. */
  TRANSCODE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  /** Scratch directory where ffmpeg writes per-track DASH chunk output. Each cached transcode owns a subdirectory `${trackId}__${target}/` containing `init.mp4` + `chunk-NNNNN.m4s` (opus) or `chunk-NNNNN.mp3`. Override to point at a tmpfs mount in containerised environments. */
  TRANSCODE_TMPDIR: z.string().optional(),

  /** OTLP/HTTP base URL. Receivers expose `/v1/traces`, `/v1/logs`, `/v1/metrics` under it. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://otel-lgtm:4318'),

  /** Service name tagged on every span and log record. */
  OTEL_SERVICE_NAME: z.string().default('lofify-backend'),
});

export const env = Schema.parse(process.env);
export type Env = typeof env;
