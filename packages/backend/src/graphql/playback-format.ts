/**
 * GraphQL enums + input shared by `Track.url`, the `trackManifest` subscription, and the playback option parser. Kept in a leaf module (no imports from `../playback/`) so the playback layer can re-use the same types without forming a runtime import cycle.
 */

/**
 * Coarse playback quality. `MIN` / `LOW` / `MEDIUM` / `HIGH` ask for a transcode at an ascending bitrate; `MAX` delivers the best representation of the source the client can play, copying without re-encoding whenever possible.
 *
 * @gqlEnum
 */
export enum Quality {
  MIN = 'MIN',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  MAX = 'MAX',
}

/**
 * How the client wants the track delivered. The client advertises what it can decode as two preference-ordered MIME lists: `losslessFormats` (e.g. `audio/mp4; codecs="flac"`) and `lossyFormats` (e.g. `audio/webm; codecs="opus"`). `lossyFormats` must be non-empty.
 *
 * Below `MAX` the server transcodes into the first `lossyFormats` entry it can encode to (opus or mp3) at the requested bitrate. At `MAX` it picks the best representation of the source the client can play, copying without re-encoding whenever possible.
 *
 * @gqlInput
 */
export type TrackFormat = {
  quality: Quality;
  /** Preference-ordered MIME types the client can play that carry lossless audio. Consulted at `MAX` for lossless sources. */
  losslessFormats?: string[] | null;
  /** Preference-ordered MIME types the client can play that carry lossy audio. At `MAX` the server copies the source into the first one whose codec matches the source, otherwise transcodes into the first it can produce; below `MAX` it transcodes into the first it can produce. Must be non-empty. */
  lossyFormats: string[];
};
