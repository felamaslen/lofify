import { afterAll, beforeAll, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import gql from 'fake-tag';
import { gqlRequest, makeApp } from './inject.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});

test('Query.ping returns pong', async () => {
  const body = await gqlRequest(app, gql`{ ping }`);
  expect(body).toEqual({ data: { ping: 'pong' } });
});

test('Mutation.noop returns a Void payload', async () => {
  const body = await gqlRequest(app, gql`mutation { noop { _ } }`);
  expect(body.errors).toBeUndefined();
  expect(body.data).toEqual({ noop: { _: null } });
});
