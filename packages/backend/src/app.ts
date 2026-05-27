import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ApolloServer } from '@apollo/server';
import fastifyApollo, { fastifyApolloDrainPlugin } from '@as-integrations/fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHandler as createSseHandler } from 'graphql-sse/lib/use/fastify';

import { env, libraryPaths } from './env.js';
import { buildSchema } from './graphql/index.js';
import { defaultCache } from './playback/cache.js';
import { registerPlaybackRoute } from './playback/route.js';
import { startCacheSweepSchedule } from './playback/sweep.js';
import { startScanSchedule } from './scanner/cron.js';
import { watchLibrary } from './scanner/watch.js';

const SCHEMA_SDL_PATH = fileURLToPath(
  new URL('./graphql/__generated__/schema.graphql', import.meta.url),
);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const allow = env.CORS_ALLOW_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(fastifyCors, {
    origin: allow.includes('*') ? true : allow,
    credentials: true,
    // The player reads X-Quality off each playback range response; browsers hide non-safelisted
    // response headers from fetch() unless they're explicitly exposed.
    exposedHeaders: ['X-Quality'],
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

  const webDistPath = env.WEB_DIST_PATH
    ? env.WEB_DIST_PATH
    : fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webDistPath)) {
    await app.register(fastifyStatic, { root: webDistPath, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      const isApi =
        req.url.startsWith('/graphql') ||
        req.url.startsWith('/play') ||
        req.url.startsWith('/healthz');
      if (req.method !== 'GET' || isApi) {
        reply.code(404).send({ error: 'not found' });
        return;
      }
      reply.type('text/html').sendFile('index.html');
    });
  }

  const watcher = watchLibrary(libraryPaths);
  const stopSchedule = startScanSchedule();
  const stopSweep = startCacheSweepSchedule(defaultCache);
  app.addHook('onClose', async () => {
    stopSchedule();
    stopSweep();
    await watcher.close();
  });

  return app;
}

/** The Fastify app with every route wired. Built once at module load; importers share the same instance. */
export const app: FastifyInstance = await buildApp();
