import Fastify, { type FastifyInstance } from 'fastify';
import { ApolloServer } from '@apollo/server';
import fastifyApollo, { fastifyApolloDrainPlugin } from '@as-integrations/fastify';
import { buildSchema } from './graphql/index.js';

/** Build the Fastify app with all routes wired but no listener bound. */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ status: 'ok' }));

  const apollo = new ApolloServer({
    schema: buildSchema(),
    plugins: [fastifyApolloDrainPlugin(app)],
  });
  await apollo.start();

  await app.register(fastifyApollo(apollo), { path: '/graphql' });

  app.get('/graphql/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    req.raw.on('close', () => {
      reply.raw.end();
    });
  });

  return app;
}
