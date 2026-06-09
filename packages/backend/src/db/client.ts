import { type Logger } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { env } from '../env.js';
import { logger } from '../logger.js';
import * as schema from './schema/index.js';

const pool = new pg.Pool(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : undefined);

/** Routes Drizzle's query log through the application logger when `DB_QUERY_LOG` is set. */
const queryLogger: Logger = {
  logQuery(query, params) {
    logger.info('sql query', { query, params });
  },
};

export const db = drizzle(pool, { schema, logger: env.DB_QUERY_LOG ? queryLogger : false });
export type Db = typeof db;
