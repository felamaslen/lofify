import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApolloServer } from '@apollo/server';
import fastifyApollo, { fastifyApolloDrainPlugin } from '@as-integrations/fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHandler as createSseHandler } from 'graphql-sse/lib/use/fastify';
import processRequest from 'graphql-upload/processRequest.mjs';

import { registerArtworkRoute } from './artwork/route.js';
import { registerAssetRoute } from './asset/route.js';
import { ensureDiskCacheWritable, migrateDiskCacheLayout } from './disk-cache.js';
import { env, libraryPaths } from './env.js';
import type { GraphQLContext } from './graphql/context.js';
import { buildSchema } from './graphql/index.js';
import { defaultCache } from './playback/cache.js';
import { registerPlaybackRoute } from './playback/route.js';
import { startCacheSweepSchedule } from './playback/sweep.js';
import { startScanSchedule } from './scanner/cron.js';
import { watchLibrary } from './scanner/watch.js';
import { buildShareTrackHtml } from './share/og.js';

const SCHEMA_SDL_PATH = fileURLToPath(
  new URL('./graphql/__generated__/schema.graphql', import.meta.url),
);

/** Fetch a URL as text, or null on any failure — used to pull the dev server's shell for `/share` metadata injection. */
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function buildApp(): Promise<FastifyInstance> {
  await ensureDiskCacheWritable();
  await migrateDiskCacheLayout();

  // trustProxy makes `request.ip` resolve through `X-Forwarded-For`, so analytics record the real
  // client rather than the reverse proxy in front of us.
  const app = Fastify({ logger: false, trustProxy: true });

  const allow = env.CORS_ALLOW_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(fastifyCors, {
    origin: allow.includes('*') ? true : allow,
    credentials: true,
    // The player reads X-Quality and X-Client-Cache off each playback range response; browsers
    // hide non-safelisted response headers from fetch() unless they're explicitly exposed.
    exposedHeaders: ['X-Quality', 'X-Client-Cache'],
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  const schema = buildSchema();
  const apollo = new ApolloServer<GraphQLContext>({
    schema,
    plugins: [fastifyApolloDrainPlugin(app)],
  });
  await apollo.start();

  // GraphQL multipart requests (file uploads, e.g. trackUpdate's artwork). The no-op parser
  // leaves the stream unconsumed so processRequest can read it; the hook swaps the body for the
  // parsed operations with `Upload` instances wired into the mapped variables.
  app.addContentTypeParser('multipart/form-data', (_req, _payload, done) => done(null));
  app.addHook('preValidation', async (req, reply) => {
    if (!req.url.startsWith('/graphql')) return;
    if (!req.headers['content-type']?.startsWith('multipart/form-data')) return;
    req.body = await processRequest(req.raw, reply.raw, {
      maxFileSize: env.UPLOAD_MAX_BYTES,
      maxFiles: 1,
    });
  });

  await app.register(fastifyApollo(apollo), {
    path: '/graphql',
    context: async (request) => ({ clientIp: request.ip }),
  });

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
  await registerArtworkRoute(app);
  await registerAssetRoute(app);

  const webDistPath = env.WEB_DIST_PATH
    ? env.WEB_DIST_PATH
    : fileURLToPath(new URL('../../web/dist', import.meta.url));
  const webDistExists = existsSync(webDistPath);

  // A shared link (`/share/<id>`) is unfurled by chat apps and crawlers that never run the SPA's JS,
  // so its metadata has to be in the served HTML. We own this route in both environments — in dev
  // the client proxies `/share` here — so the Open Graph / Twitter injection lives in one place
  // (`share/og.ts`); the tags' absolute URLs come from `PUBLIC_URL`, so set it to the
  // externally-visible origin (e.g. your tunnel URL) when testing unfurls.
  //
  // The shell injected into differs by environment. `WEB_DEV_SHELL_URL` (set in dev) forces the
  // dev path — fetch the dev server's transformed shell — and takes precedence over any stale local
  // build. Otherwise a built client means prod (serve it as the SPA catch-all and inject into it),
  // and its absence means dev against the conventional local dev-server URL.
  const devShellUrl =
    env.WEB_DEV_SHELL_URL ?? (webDistExists ? null : 'http://localhost:5173/index.html');
  const serveSpa = webDistExists && !devShellUrl;
  const localShell = serveSpa ? await readFile(join(webDistPath, 'index.html'), 'utf8') : null;

  if (devShellUrl || localShell) {
    app.get<{ Params: { id: string } }>('/share/:id', async (req, reply) => {
      const shell = devShellUrl ? await fetchText(devShellUrl) : localShell;
      if (shell == null) {
        return reply.code(502).type('text/plain').send('share shell unavailable');
      }
      const html = (await buildShareTrackHtml(shell, req.params.id)) ?? shell;
      return reply.type('text/html').send(html);
    });
  }

  if (serveSpa) {
    await app.register(fastifyStatic, { root: webDistPath, wildcard: false });

    app.setNotFoundHandler((req, reply) => {
      const isApi =
        req.url.startsWith('/graphql') ||
        req.url.startsWith('/play') ||
        req.url.startsWith('/artwork') ||
        req.url.startsWith('/asset') ||
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
