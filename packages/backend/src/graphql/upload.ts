import type UploadInstance from 'graphql-upload/Upload.mjs';

/**
 * A file sent with the [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec). The multipart hook in `app.ts` replaces the mapped variable with an instance carrying the streamed file; resolvers await its `promise` for the filename, MIME type and stream.
 *
 * @gqlScalar Upload
 */
export type Upload = UploadInstance;
