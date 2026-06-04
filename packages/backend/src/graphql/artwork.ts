import type { AlbumArt } from '../db/schema/index.js';
import { Image, type Media } from './media.js';

/**
 * A successfully downloaded album-art image.
 *
 * @gqlType
 */
export class Artwork {
  constructor(
    /** Album the image was found for. @gqlField */
    public album: string,
    /** Album artist the image was found for. @gqlField */
    public albumArtist: string,
    private id: string,
  ) {}

  /** @gqlField */
  media(): Media {
    return Image.fromApiPath(`/artwork/${this.id}`);
  }
}

/**
 * The state of an album-art download that has not (yet) produced an image.
 *
 * @gqlType
 */
export class ArtworkStatus {
  constructor(inProgress: boolean, message: string) {
    this.inProgress = inProgress;
    this.message = message;
  }

  /** Whether the download is queued or running. False means it failed and may be retried with `artworkDownload`. @gqlField */
  inProgress: boolean;

  /** Why the download failed, or an empty string while it is in progress. @gqlField */
  message: string;
}

/**
 * Album art for a track: the downloaded image, or the state of a download that has not produced one.
 *
 * @gqlUnion
 */
export type TrackArtwork = Artwork | ArtworkStatus;

export function toTrackArtwork(row: AlbumArt): TrackArtwork {
  switch (row.status) {
    case 'SUCCEEDED':
      return new Artwork(row.album, row.albumArtist, row.id);
    case 'FAILED':
      return new ArtworkStatus(false, row.error ?? 'Artwork download failed.');
    default:
      return new ArtworkStatus(true, '');
  }
}
