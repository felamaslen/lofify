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

  /** HMAC secret used to sign and verify playback URLs. */
  PLAYBACK_SIGNING_SECRET: z.string().default('dev-secret'),

  /** Maximum number of concurrent ffmpeg transcode processes. */
  TRANSCODE_MAX_PARALLEL: z.coerce.number().int().positive().default(2),

  /** Soft upper bound on bytes held in the in-memory transcode cache. */
  TRANSCODE_CACHE_MAX_BYTES: z.coerce.number().int().positive().default(1_073_741_824),

  /** How long a cached transcode survives after its last access. */
  TRANSCODE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  /** OTLP/HTTP base URL. Receivers expose `/v1/traces`, `/v1/logs`, `/v1/metrics` under it. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://otel-lgtm:4318'),

  /** Service name tagged on every span and log record. */
  OTEL_SERVICE_NAME: z.string().default('lofify-backend'),
});

export const env = Schema.parse(process.env);
export type Env = typeof env;
