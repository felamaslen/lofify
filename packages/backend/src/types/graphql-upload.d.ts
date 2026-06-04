// graphql-upload v17 publishes JSDoc-typed .mjs files with no .d.ts, so the modules used here are declared by hand.

declare module 'graphql-upload/Upload.mjs' {
  import type { FileUpload } from 'graphql-upload/processRequest.mjs';

  export default class Upload {
    promise: Promise<FileUpload>;
    file: FileUpload | undefined;
  }
}

declare module 'graphql-upload/processRequest.mjs' {
  import type { IncomingMessage, ServerResponse } from 'node:http';
  import type { Readable } from 'node:stream';

  export type FileUpload = {
    filename: string;
    mimetype: string;
    encoding: string;
    createReadStream: () => Readable;
  };

  export default function processRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options?: { maxFieldSize?: number; maxFileSize?: number; maxFiles?: number },
  ): Promise<unknown>;
}
