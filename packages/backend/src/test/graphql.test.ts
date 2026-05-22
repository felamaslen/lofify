import { app } from '../app.js';
import { graphql } from './gql.js';
import { gqlRequest } from './inject.js';

const PingQuery = graphql(`
  query Ping {
    ping
  }
`);

const NoopMutation = graphql(`
  mutation Noop {
    noop {
      _
    }
  }
`);

test('Query.ping returns pong', async () => {
  const body = await gqlRequest(app).query(PingQuery);
  expect(body).toEqual({ data: { ping: 'pong' } });
});

test('Mutation.noop returns a Void payload', async () => {
  const { data } = await gqlRequest(app).mutate(NoopMutation).expectNoErrors();
  expect(data).toEqual({ noop: { _: null } });
});
