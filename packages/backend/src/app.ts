import Fastify, { type FastifyInstance } from 'fastify';
import { ApolloServer } from '@apollo/server';
import fastifyApollo, { fastifyApolloDrainPlugin } from '@as-integrations/fastify';
import { createHandler as createSseHandler } from 'graphql-sse/lib/use/fastify';
import { env } from './env.js';
import { buildSchema } from './graphql/index.js';
import { registerPlaybackRoute } from './playback/route.js';
import { startScanSchedule } from './scanner/cron.js';
import { watchLibrary } from './scanner/watch.js';

/** Build the Fastify app with all routes wired but no listener bound. */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ status: 'ok' }));

  const schema = buildSchema();
  const apollo = new ApolloServer({
    schema,
    plugins: [fastifyApolloDrainPlugin(app)],
  });
  await apollo.start();

  await app.register(fastifyApollo(apollo), { path: '/graphql' });

  const sseHandler = createSseHandler({ schema });
  app.all('/graphql/stream', async (req, reply) => {
    await sseHandler(req, reply);
  });

  await registerPlaybackRoute(app);

  const watcher = watchLibrary(env.LIBRARY_PATH);
  const stopSchedule = startScanSchedule();
  app.addHook('onClose', async () => {
    stopSchedule();
    await watcher.close();
  });

  return app;
}
