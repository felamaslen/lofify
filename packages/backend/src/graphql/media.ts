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
 * A renderable image resource.
 * @gqlType
 */
export class Image implements Media {
  private constructor(
    /** Absolute URL of the original resource. @gqlField */
    public url: string,
  ) {}

  /** Serve an image whose original URL is available by a request to the API */
  static fromApiPath(path: string): Image {
    return new Image(publicUrl(path));
  }
}
