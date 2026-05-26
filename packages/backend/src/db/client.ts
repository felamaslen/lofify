import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { env } from '../env.js';
import * as schema from './schema/index.js';

const pool = new pg.Pool(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : undefined);

export const db = drizzle(pool, { schema });
export type Db = typeof db;
