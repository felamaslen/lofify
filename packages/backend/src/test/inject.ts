import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { FastifyInstance } from 'fastify';
import { type DocumentNode, print } from 'graphql';
import { createClient } from 'graphql-sse';

type GqlError = { message: string };
type Result<TResult> = { data?: TResult; errors?: GqlError[] };
type ResultWithData<TResult> = { data: TResult; errors?: GqlError[] };
type ResultWithErrors<TResult> = { data?: TResult; errors: GqlError[] };

type AnyDocument<TResult, TVars> = TypedDocumentNode<TResult, TVars> | DocumentNode | string;
type Expect = 'any' | 'no-errors' | 'errors';

class GqlBuilder<TResult, TVars, TOut = Result<TResult>>
  implements PromiseLike<TOut>
{
  private vars?: TVars;
  private headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  private expect: Expect = 'any';

  constructor(
    private app: FastifyInstance,
    private document: AnyDocument<TResult, TVars>,
  ) {}

  variables(v: TVars): this {
    this.vars = v;
    return this;
  }

  set(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  expectNoErrors(): GqlBuilder<TResult, TVars, ResultWithData<TResult>> {
    this.expect = 'no-errors';
    return this as unknown as GqlBuilder<TResult, TVars, ResultWithData<TResult>>;
  }

  expectErrors(): GqlBuilder<TResult, TVars, ResultWithErrors<TResult>> {
    this.expect = 'errors';
    return this as unknown as GqlBuilder<TResult, TVars, ResultWithErrors<TResult>>;
  }

  private async send(): Promise<TOut> {
    const query =
      typeof this.document === 'string' ? this.document : print(this.document);
    const res = await this.app.inject({
      method: 'POST',
      url: '/graphql',
      headers: this.headers,
      payload: JSON.stringify({ query, variables: this.vars }),
    });
    const body = res.json() as Result<TResult>;
    if (this.expect === 'no-errors' && body.errors && body.errors.length > 0) {
      throw new Error(
        `expected no GraphQL errors, got: ${body.errors.map((e) => e.message).join('; ')}`,
      );
    }
    if (this.expect === 'errors' && (!body.errors || body.errors.length === 0)) {
      throw new Error('expected GraphQL errors, but the response contained none');
    }
    return body as TOut;
  }

  then<TFulfilled = TOut, TRejected = never>(
    onFulfilled?:
      | ((value: TOut) => TFulfilled | PromiseLike<TFulfilled>)
      | null,
    onRejected?:
      | ((reason: unknown) => TRejected | PromiseLike<TRejected>)
      | null,
  ): PromiseLike<TFulfilled | TRejected> {
    return this.send().then(onFulfilled, onRejected);
  }
}

class GqlSubscriptionBuilder<TResult, TVars>
  implements AsyncIterable<Result<TResult>>
{
  private vars?: TVars;
  private headers: Record<string, string> = {};

  constructor(
    private app: FastifyInstance,
    private document: AnyDocument<TResult, TVars>,
  ) {}

  variables(v: TVars): this {
    this.vars = v;
    return this;
  }

  set(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Result<TResult>> {
    let addr = this.app.server.address();
    if (!addr || typeof addr === 'string') {
      await this.app.listen({ port: 0, host: '127.0.0.1' });
      addr = this.app.server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('gqlRequest.subscribe(): failed to start app listener');
      }
    }
    const url = `http://127.0.0.1:${addr.port}/graphql/stream`;
    const headers = { ...this.headers };
    const client = createClient({ url, headers });
    const query =
      typeof this.document === 'string' ? this.document : print(this.document);

    const queue: Result<TResult>[] = [];
    let streamError: unknown = null;
    let streamDone = false;
    let wake: (() => void) | null = null;
    const tick = () => {
      const w = wake;
      wake = null;
      w?.();
    };

    const subscribePayload: { query: string; variables?: Record<string, unknown> } = { query };
    if (this.vars !== undefined) {
      subscribePayload.variables = this.vars as Record<string, unknown>;
    }
    const unsubscribe = client.subscribe<TResult>(
      subscribePayload,
      {
        next: (msg) => {
          queue.push(msg as unknown as Result<TResult>);
          tick();
        },
        error: (err) => {
          streamError = err;
          streamDone = true;
          tick();
        },
        complete: () => {
          streamDone = true;
          tick();
        },
      },
    );

    try {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (streamError) throw streamError;
        if (streamDone) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      unsubscribe();
      client.dispose();
    }
  }
}

class GqlEntry {
  constructor(private app: FastifyInstance) {}

  /** Build a `POST /graphql` request that runs the given query document. Pass a `TypedDocumentNode` (typically produced by `gql.tada`) for full result/variable typing, or a raw string/`DocumentNode` to opt out and get an `unknown` payload. */
  query<TResult, TVars>(
    document: TypedDocumentNode<TResult, TVars>,
  ): GqlBuilder<TResult, TVars>;
  query(
    document: string | DocumentNode,
  ): GqlBuilder<unknown, Record<string, unknown>>;
  query<TResult, TVars>(
    document: AnyDocument<TResult, TVars>,
  ): GqlBuilder<TResult, TVars> {
    return new GqlBuilder<TResult, TVars>(this.app, document);
  }

  /** Build a `POST /graphql` request that runs the given mutation document. Behaves identically to `query` — the split exists to make the test's intent obvious. */
  mutate<TResult, TVars>(
    document: TypedDocumentNode<TResult, TVars>,
  ): GqlBuilder<TResult, TVars>;
  mutate(
    document: string | DocumentNode,
  ): GqlBuilder<unknown, Record<string, unknown>>;
  mutate<TResult, TVars>(
    document: AnyDocument<TResult, TVars>,
  ): GqlBuilder<TResult, TVars> {
    return new GqlBuilder<TResult, TVars>(this.app, document);
  }

  /** Open a graphql-sse subscription against the running app. The returned builder is an `AsyncIterable` — drive it with `for await` to consume each frame; the SSE connection is closed automatically when the loop ends, breaks, or throws. The app must already be listening on a real port (e.g. `app.listen({ port: 0 })`). */
  subscribe<TResult, TVars>(
    document: TypedDocumentNode<TResult, TVars>,
  ): GqlSubscriptionBuilder<TResult, TVars>;
  subscribe(
    document: string | DocumentNode,
  ): GqlSubscriptionBuilder<unknown, Record<string, unknown>>;
  subscribe<TResult, TVars>(
    document: AnyDocument<TResult, TVars>,
  ): GqlSubscriptionBuilder<TResult, TVars> {
    return new GqlSubscriptionBuilder<TResult, TVars>(this.app, document);
  }
}

/**
 * Entry point for the GraphQL test client. Returns a chainable builder that drives the Fastify app under test.
 *
 * @example
 * ```ts
 * const { data } = await gqlRequest(app)
 *   .query(MyDocument)
 *   .variables({ id })
 *   .set('Authorization', 'Bearer test')
 *   .expectNoErrors();
 * ```
 *
 * @example
 * ```ts
 * const { errors } = await gqlRequest(app).mutate(MyDocument).expectErrors();
 * ```
 *
 * @example
 * ```ts
 * for await (const frame of gqlRequest(app).subscribe(MySubscription).variables({ id })) {
 *   if (frame.data) frames.push(frame.data);
 * }
 * ```
 *
 * Documents typed with `TypedDocumentNode` (the shape `gql.tada` produces) flow result and variable types end-to-end. Passing a raw string or `DocumentNode` works too but gives up that typing — useful for one-off inline operations.
 */
export function gqlRequest(app: FastifyInstance): GqlEntry {
  return new GqlEntry(app);
}
