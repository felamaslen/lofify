import { publicUrl } from '../env.js';

/**
 * A renderable media resource.
 * @gqlInterface
 */
export interface Media {
  /** Absolute URL of the original resource. @gqlField */
  url: string;
}

/**
 * Pre-defined rendered sizes for media previews.
 *
 * @gqlEnum
 */
export type MediaSize = 'SQUARE_500';

/** The `/asset` route options each preview size renders with. */
const PREVIEW_OPTIONS: Record<MediaSize, string> = {
  SQUARE_500: 'format=avif&size=500',
};

/**
 * A renderable image resource.
 * @gqlType
 */
export class Image implements Media {
  private constructor(
    /** Absolute URL of the original resource. @gqlField */
    public url: string,
    /** Version of the resource behind `url`. The original URL is stable (and served no-store); previews carry this as a `v=` option, making every revision a distinct, immutably-cacheable URL. */
    private version: string | null,
  ) {}

  /** Serve an image whose original URL is available by a request to the API */
  static fromApiPath(path: string, version?: string): Image {
    return new Image(publicUrl(path), version ?? null);
  }

  /** A processed render of this image: the original URL behind the API's `/asset/<options>/` processing route. @gqlField */
  preview(size: MediaSize): Image {
    const options = this.version
      ? `${PREVIEW_OPTIONS[size]}&v=${this.version}`
      : PREVIEW_OPTIONS[size];
    return new Image(publicUrl(`/asset/${options}/${this.url}`), null);
  }
}
