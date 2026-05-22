import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { ApolloServer } from '@apollo/server';
import fastifyApollo, { fastifyApolloDrainPlugin } from '@as-integrations/fastify';
import { createHandler as createSseHandler } from 'graphql-sse/lib/use/fastify';
import { env } from './env.js';
import { buildSchema } from './graphql/index.js';
import { registerPlaybackRoute } from './playback/route.js';
import { startScanSchedule } from './scanner/cron.js';
import { watchLibrary } from './scanner/watch.js';

const SCHEMA_SDL_PATH = fileURLToPath(
  new URL('./graphql/__generated__/schema.graphql', import.meta.url),
);

/** Build the Fastify app with all routes wired but no listener bound. */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const allow = env.CORS_ALLOW_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(fastifyCors, {
    origin: allow.includes('*') ? true : allow,
    credentials: true,
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  const schema = buildSchema();
  const apollo = new ApolloServer({
    schema,
    plugins: [fastifyApolloDrainPlugin(app)],
  });
  await apollo.start();

  await app.register(fastifyApollo(apollo), { path: '/graphql' });

  app.get('/graphql/schema.graphql', async (_req, reply) => {
    const sdl = await readFile(SCHEMA_SDL_PATH, 'utf8');
    reply.type('application/graphql; charset=utf-8');
    return sdl;
  });

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
