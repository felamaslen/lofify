import type { TadaDocumentNode } from 'gql.tada';
import { print } from 'graphql';
import { type Client,createClient } from 'graphql-sse';

const STREAM_URL =
  import.meta.env.VITE_GRAPHQL_STREAM_URL ?? '/graphql/stream';

let client: Client | null = null;

function sseClient(): Client {
  if (!client) {
    client = createClient({ url: STREAM_URL });
  }
  return client;
}

export type Sink<T> = {
  next?: (value: T) => void;
  error?: (err: unknown) => void;
  complete?: () => void;
};

export function subscribe<TResult, TVars>(
  document: TadaDocumentNode<TResult, TVars>,
  variables: TVars,
  sink: Sink<TResult>,
): () => void {
  return sseClient().subscribe<TResult>(
    { query: print(document), variables: variables as Record<string, unknown> },
    {
      next: (msg) => {
        if (msg.data) sink.next?.(msg.data);
      },
      error: (err) => sink.error?.(err),
      complete: () => sink.complete?.(),
    },
  );
}
