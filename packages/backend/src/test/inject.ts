import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

export async function makeApp(): Promise<FastifyInstance> {
  return buildApp();
}

export async function gql(
  app: FastifyInstance,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: unknown; errors?: Array<{ message: string }> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json();
}
