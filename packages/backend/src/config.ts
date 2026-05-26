/**
 * Static, code-level configuration constants that aren't end-user tunables — kept separate from `env.ts` so they're discoverable without grepping for magic numbers in implementation files.
 */

/** Default nominal duration of a playback chunk in seconds. Used as ffmpeg's `-frag_duration` for fmp4 outputs and as the target window the mp3 scanner aggregates frames into. Clients see this as the approximate seek granularity. */
export const DEFAULT_CHUNK_DURATION_SECONDS = 6;
