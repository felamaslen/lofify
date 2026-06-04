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

  /** A processed render of this image, shaped for an `<img>` element: the original URL behind the API's `/asset/<options>/` processing route. @gqlField */
  preview(size: MediaSize): ImageSource {
    const options = this.version
      ? `${PREVIEW_OPTIONS[size]}&v=${this.version}`
      : PREVIEW_OPTIONS[size];
    return new ImageSource(publicUrl(`/asset/${options}/${this.url}`));
  }
}

/**
 * A render of an image at one logical display size, shaped for an `<img>` element.
 *
 * @gqlType
 */
// Hidpi is additive when wanted: a `srcSet: String!` field carrying server-rendered density variants (each exactly the right pixel size for the logical size, possibly processed differently per density) — clients then spread { src, srcSet } straight onto <img> without ever composing densities themselves.
export class ImageSource {
  constructor(
    /** URL of the render at the logical size. Use as the `src` attribute. @gqlField */
    public src: string,
  ) {}
}
