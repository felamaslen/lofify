import { app } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';

await app.listen({ host: env.BACKEND_HOST, port: env.BACKEND_PORT });
logger.info(`backend listening on http://${env.BACKEND_HOST}:${env.BACKEND_PORT}`);
