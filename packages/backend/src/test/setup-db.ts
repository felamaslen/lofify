import pg from 'pg';

/** Kept in sync with `global-setup.ts`. */
const TEMPLATE_SUFFIX = '_test_template';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL is required for tests');

const workerId = process.env.VITEST_POOL_ID ?? '0';

const target = new URL(baseUrl);
const devDbName = target.pathname.replace(/^\//, '');
const templateName = `${devDbName}${TEMPLATE_SUFFIX}`;
const workerDb = `${devDbName}_test_${workerId}`;

const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
// Clone from the migration-baked template DB — not the live dev DB — so
// the running backend container can keep its connections open without
// blocking `CREATE DATABASE ... TEMPLATE`.
await admin.query(
  'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
  [workerDb],
);
await admin.query(`DROP DATABASE IF EXISTS "${workerDb}"`);
await admin.query(`CREATE DATABASE "${workerDb}" TEMPLATE "${templateName}"`);
await admin.end();

target.pathname = `/${workerDb}`;
process.env.DATABASE_URL = target.toString();

afterAll(async () => {
  const { app } = await import('../app.js');
  await app.close();
});
