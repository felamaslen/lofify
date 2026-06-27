import type { ID, Int } from 'grats';

import { db } from '../db/client.js';
import { trackAnalytics } from '../db/schema/index.js';
import type { GraphQLContext } from './context.js';
import type { Void } from './types.js';

/**
 * Record one playback-analytics sample for a track: the seconds actually played since the caller's previous sample (0 when sent at play start), the listener's selected playback mode, and the MIME type of the audio being delivered. Fire-and-forget from the player — a dropped sample never disturbs playback.
 *
 * @gqlMutationField
 */
export async function trackAnalyticsCollect(
  trackId: ID,
  playTimeSeconds: Int,
  /** Playback mode the listener has selected (`SMART`, `ORIGINAL` or `ADAPTIVE`). */
  requestedMode: string,
  /** MIME type of the bytes the player is receiving, which carries the output codec. */
  outputCodec: string,
  ctx: GraphQLContext,
): Promise<Void> {
  await db.insert(trackAnalytics).values({
    trackId,
    clientIp: ctx.clientIp,
    playTimeSeconds,
    requestedMode,
    outputCodec,
  });
  return {};
}
