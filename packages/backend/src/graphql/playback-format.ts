/**
 * GraphQL enums + input shared by `Track.url`, the `trackManifest` subscription, and the playback option parser. Kept in a leaf module (no imports from `../playback/`) so the playback layer can re-use the same types without forming a runtime import cycle.
 */

/**
 * Coarse playback quality. `LOW` / `MEDIUM` / `HIGH` map to lossy presets; `MAX` asks for lossless when the source is lossless and the highest lossy preset (in `formatLossy`) when it isn't.
 *
 * @gqlEnum
 */
export enum Quality {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  MAX = 'MAX',
}

/**
 * Codec the lossy delivery path uses.
 *
 * @gqlEnum
 */
export enum FormatLossy {
  OPUS = 'OPUS',
  MP3 = 'MP3',
}

/**
 * How the client wants the track delivered. `formatLossy` is always required — even when `quality: MAX`, the server falls through to a lossy stream for non-lossless sources, so it always needs a codec to fall back to.
 *
 * @gqlInput
 */
export type TrackFormat = {
  quality: Quality;
  formatLossy: FormatLossy;
};
