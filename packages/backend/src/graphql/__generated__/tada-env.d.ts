/* eslint-disable */
/* prettier-ignore */

export type introspection_types = {
    'Boolean': unknown;
    'Duration': { kind: 'OBJECT'; name: 'Duration'; fields: { 'formatted': { name: 'formatted'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'String'; ofType: null; }; } }; 'seconds': { name: 'seconds'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'Int'; ofType: null; }; } }; }; };
    'Format': { name: 'Format'; enumValues: 'AAC' | 'AUTO_HI' | 'AUTO_LO' | 'FLAC' | 'OGG' | 'ORIGINAL' | 'WEBM'; };
    'ID': unknown;
    'Int': unknown;
    'LibraryScan': { kind: 'OBJECT'; name: 'LibraryScan'; fields: { 'errorMessage': { name: 'errorMessage'; type: { kind: 'SCALAR'; name: 'String'; ofType: null; } }; 'errorsTotal': { name: 'errorsTotal'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'Int'; ofType: null; }; } }; 'filesTotal': { name: 'filesTotal'; type: { kind: 'SCALAR'; name: 'Int'; ofType: null; } }; 'id': { name: 'id'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'ID'; ofType: null; }; } }; 'isCompleted': { name: 'isCompleted'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'Boolean'; ofType: null; }; } }; 'scannedTotal': { name: 'scannedTotal'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'Int'; ofType: null; }; } }; }; };
    'Mutation': { kind: 'OBJECT'; name: 'Mutation'; fields: { 'libraryScanStart': { name: 'libraryScanStart'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'OBJECT'; name: 'LibraryScan'; ofType: null; }; } }; 'noop': { name: 'noop'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'OBJECT'; name: 'Void'; ofType: null; }; } }; }; };
    'PageInfo': { kind: 'OBJECT'; name: 'PageInfo'; fields: { 'endCursor': { name: 'endCursor'; type: { kind: 'SCALAR'; name: 'ID'; ofType: null; } }; 'hasNextPage': { name: 'hasNextPage'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'Boolean'; ofType: null; }; } }; 'hasPreviousPage': { name: 'hasPreviousPage'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'Boolean'; ofType: null; }; } }; 'startCursor': { name: 'startCursor'; type: { kind: 'SCALAR'; name: 'ID'; ofType: null; } }; }; };
    'Query': { kind: 'OBJECT'; name: 'Query'; fields: { 'libraryScan': { name: 'libraryScan'; type: { kind: 'OBJECT'; name: 'LibraryScan'; ofType: null; } }; 'ping': { name: 'ping'; type: { kind: 'SCALAR'; name: 'String'; ofType: null; } }; 'track': { name: 'track'; type: { kind: 'OBJECT'; name: 'Track'; ofType: null; } }; 'tracks': { name: 'tracks'; type: { kind: 'OBJECT'; name: 'TrackConnection'; ofType: null; } }; }; };
    'String': unknown;
    'Subscription': { kind: 'OBJECT'; name: 'Subscription'; fields: { 'libraryScan': { name: 'libraryScan'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'OBJECT'; name: 'LibraryScan'; ofType: null; }; } }; }; };
    'Track': { kind: 'OBJECT'; name: 'Track'; fields: { 'album': { name: 'album'; type: { kind: 'SCALAR'; name: 'String'; ofType: null; } }; 'artist': { name: 'artist'; type: { kind: 'SCALAR'; name: 'String'; ofType: null; } }; 'discNumber': { name: 'discNumber'; type: { kind: 'SCALAR'; name: 'Int'; ofType: null; } }; 'duration': { name: 'duration'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'OBJECT'; name: 'Duration'; ofType: null; }; } }; 'format': { name: 'format'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'String'; ofType: null; }; } }; 'id': { name: 'id'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'ID'; ofType: null; }; } }; 'title': { name: 'title'; type: { kind: 'SCALAR'; name: 'String'; ofType: null; } }; 'trackNumber': { name: 'trackNumber'; type: { kind: 'SCALAR'; name: 'Int'; ofType: null; } }; 'url': { name: 'url'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'String'; ofType: null; }; } }; 'year': { name: 'year'; type: { kind: 'SCALAR'; name: 'String'; ofType: null; } }; }; };
    'TrackConnection': { kind: 'OBJECT'; name: 'TrackConnection'; fields: { 'edges': { name: 'edges'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'LIST'; name: never; ofType: { kind: 'NON_NULL'; name: never; ofType: { kind: 'OBJECT'; name: 'TrackEdge'; ofType: null; }; }; }; } }; 'pageInfo': { name: 'pageInfo'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'OBJECT'; name: 'PageInfo'; ofType: null; }; } }; 'totalCount': { name: 'totalCount'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'Int'; ofType: null; }; } }; }; };
    'TrackEdge': { kind: 'OBJECT'; name: 'TrackEdge'; fields: { 'cursor': { name: 'cursor'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'SCALAR'; name: 'ID'; ofType: null; }; } }; 'node': { name: 'node'; type: { kind: 'NON_NULL'; name: never; ofType: { kind: 'OBJECT'; name: 'Track'; ofType: null; }; } }; }; };
    'Void': { kind: 'OBJECT'; name: 'Void'; fields: { '_': { name: '_'; type: { kind: 'SCALAR'; name: 'Boolean'; ofType: null; } }; }; };
};

/** An IntrospectionQuery representation of your schema.
 *
 * @remarks
 * This is an introspection of your schema saved as a file by GraphQLSP.
 * It will automatically be used by `gql.tada` to infer the types of your GraphQL documents.
 * If you need to reuse this data or update your `scalars`, update `tadaOutputLocation` to
 * instead save to a .ts instead of a .d.ts file.
 */
export type introspection = {
  name: never;
  query: 'Query';
  mutation: 'Mutation';
  subscription: 'Subscription';
  types: introspection_types;
};

import * as gqlTada from 'gql.tada';

declare module 'gql.tada' {
  interface setupSchema {
    introspection: introspection
  }
}