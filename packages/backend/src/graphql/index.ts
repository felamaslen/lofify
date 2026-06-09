import { GraphQLError } from 'graphql';
import Upload from 'graphql-upload/Upload.mjs';

import { getSchema } from './__generated__/schema.js';
import { applyConstraintDirective } from './directives/constraint.js';

/** Returns the executable GraphQL schema with directive enforcement applied. */
export function buildSchema() {
  return applyConstraintDirective(
    getSchema({
      scalars: {
        Upload: {
          // Only the multipart hook can place a value here; anything else is a malformed request.
          parseValue(value: unknown) {
            if (value instanceof Upload) return value;
            throw new GraphQLError('Upload value must come from a multipart request.');
          },
        },
        DateTime: {
          serialize(value: unknown) {
            if (value instanceof Date) return value.toISOString();
            if (typeof value === 'string') return value;
            throw new GraphQLError('DateTime must serialize a Date.');
          },
        },
      },
    }),
  );
}
