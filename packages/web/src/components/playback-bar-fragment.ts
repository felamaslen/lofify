import { graphql } from '../lib/gql.ts';
import { TrackArtworkDocument } from './track-artwork.tsx';

/**
 * Fields the playback bar reads off the current track. Lives in its own module (rather than beside the `PlaybackBar` component) so the player — which composes it into `TrackById` and reads track metadata from it — can import it without pulling in `playback-bar.tsx`, which in turn imports the player. Re-exported from `playback-bar.tsx` for colocated consumers.
 */
export const PlaybackBarDocument = graphql(
  `
    fragment PlaybackBar on Track {
      title
      artist
      album
      duration {
        seconds
        formatted
      }
      ...TrackArtwork
    }
  `,
  [TrackArtworkDocument],
);
