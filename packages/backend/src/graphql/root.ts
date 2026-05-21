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
 * Does nothing.
 *
 * @gqlMutationField
 */
export function noop(): Void {
  return {};
}
