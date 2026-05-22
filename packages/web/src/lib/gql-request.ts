import { print } from 'graphql';
import type { TadaDocumentNode } from 'gql.tada';

const GRAPHQL_URL = import.meta.env.VITE_GRAPHQL_URL ?? '/graphql';

type GraphQLError = { message: string };

export class GraphQLRequestError extends Error {
  constructor(public errors: GraphQLError[]) {
    super(errors.map((e) => e.message).join('; ') || 'GraphQL error');
    this.name = 'GraphQLRequestError';
  }
}

export async function gqlRequest<TResult, TVars>(
  document: TadaDocumentNode<TResult, TVars>,
  variables: TVars,
  signal?: AbortSignal,
): Promise<TResult> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: print(document), variables }),
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const payload = (await res.json()) as {
    data?: TResult;
    errors?: GraphQLError[];
  };
  if (payload.errors?.length) throw new GraphQLRequestError(payload.errors);
  if (!payload.data) throw new Error('GraphQL response missing data');
  return payload.data;
}
