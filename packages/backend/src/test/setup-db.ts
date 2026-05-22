import pg from 'pg';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL is required for tests');

const workerId = process.env.VITEST_POOL_ID ?? '0';

const target = new URL(baseUrl);
const templateName = target.pathname.replace(/^\//, '');
const workerDb = `${templateName}_test_${workerId}`;

const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(
  'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
  [workerDb],
);
await admin.query(`DROP DATABASE IF EXISTS "${workerDb}"`);
await admin.query(`CREATE DATABASE "${workerDb}" TEMPLATE "${templateName}"`);
await admin.end();

target.pathname = `/${workerDb}`;
process.env.DATABASE_URL = target.toString();

const { app } = await import('../app.js');
afterAll(async () => {
  await app.close();
});
