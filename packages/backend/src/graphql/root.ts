import { env } from '../env.js';
import type { Void } from './types.js';

/**
 * Returns the literal string `"pong"`. Useful as a liveness probe.
 *
 * @gqlQueryField
 */
export function ping(): string | null {
  return 'pong';
}

/**
 * Whether a newer build of the app is live than the one the client is running.
 *
 * The client passes `version`, the git commit SHA its bundle was built from; this returns `true` when the server was built from a different commit, signalling the client should reload to pick up the new deployment. Returns `false` whenever the server's own build SHA is unknown (the development default), so local work is never flagged.
 *
 * @gqlQueryField
 */
export function isUpdateAvailable(version: string): boolean | null {
  if (env.GIT_SHA === 'dev') return false;
  return version !== env.GIT_SHA;
}

/**
 * Does nothing.
 *
 * @gqlMutationField
 */
export function noop(): Void {
  return {};
}
