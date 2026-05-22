import { graphql } from './gql.ts';

export const TracksQuery = graphql(`
  query Tracks(
    $first: Int
    $last: Int
    $after: String
    $before: String
    $format: Format
    $quality: Int
  ) {
    tracks(first: $first, last: $last, after: $after, before: $before) {
      totalCount
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      edges {
        cursor
        node {
          id
          title
          trackNumber
          discNumber
          artist
          album
          year
          format
          duration {
            seconds
            formatted
          }
          url(format: $format, quality: $quality)
        }
      }
    }
  }
`);

export const LibraryScanQuery = graphql(`
  query LibraryScanCurrent {
    libraryScan {
      id
      filesTotal
      scannedTotal
      errorsTotal
      isCompleted
      errorMessage
    }
  }
`);

export const StartLibraryScanMutation = graphql(`
  mutation StartLibraryScan {
    libraryScanStart {
      id
      filesTotal
      scannedTotal
      errorsTotal
      isCompleted
      errorMessage
    }
  }
`);

export const LibraryScanSubscription = graphql(`
  subscription LibraryScan($id: ID!) {
    libraryScan(id: $id) {
      id
      filesTotal
      scannedTotal
      errorsTotal
      isCompleted
      errorMessage
    }
  }
`);

export const TrackByIdQuery = graphql(`
  query TrackById($id: ID!, $format: Format, $quality: Int) {
    track(id: $id) {
      id
      title
      trackNumber
      discNumber
      artist
      album
      year
      format
      duration {
        seconds
        formatted
      }
      url(format: $format, quality: $quality)
    }
  }
`);
