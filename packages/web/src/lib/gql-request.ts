import type { TadaDocumentNode } from 'gql.tada';
import { print } from 'graphql';

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
  return unwrap<TResult>(res);
}

/**
 * Run an operation whose variables include `File` values, as a [GraphQL multipart request](https://github.com/jaydenseric/graphql-multipart-request-spec). Files are lifted out of the variables into mapped form-data parts; everything else behaves like `gqlRequest`.
 */
export async function gqlUpload<TResult, TVars extends Record<string, unknown>>(
  document: TadaDocumentNode<TResult, TVars>,
  variables: TVars,
  signal?: AbortSignal,
): Promise<TResult> {
  const mapped: Record<string, unknown> = {};
  const files: File[] = [];
  const map: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (value instanceof File) {
      map[String(files.length)] = [`variables.${key}`];
      files.push(value);
      mapped[key] = null;
    } else {
      mapped[key] = value;
    }
  }

  const form = new FormData();
  form.append('operations', JSON.stringify({ query: print(document), variables: mapped }));
  form.append('map', JSON.stringify(map));
  files.forEach((file, i) => form.append(String(i), file, file.name));

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    body: form,
    // Multipart requests don't trigger a CORS preflight on their own; Apollo's CSRF prevention requires a header that does.
    headers: { 'x-apollo-operation-name': 'upload' },
    signal: signal ?? null,
  });
  return unwrap<TResult>(res);
}

async function unwrap<TResult>(res: Response): Promise<TResult> {
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const payload = (await res.json()) as {
    data?: TResult;
    errors?: GraphQLError[];
  };
  if (payload.errors?.length) throw new GraphQLRequestError(payload.errors);
  if (!payload.data) throw new Error('GraphQL response missing data');
  return payload.data;
}
