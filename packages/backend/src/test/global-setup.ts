import { createMigrator } from 'drizzle-pgkit-migrator';
import pg from 'pg';

/** Name suffix appended to the dev DB to produce the template DB used by the test pool. The template is migrated once per `vitest` run and is then `CREATE DATABASE ... TEMPLATE`-cloned per worker — keeping it separate from the live dev DB means the running backend container can stay connected to `lofify` while tests work against `lofify_test_template`. Kept in sync with `setup-db.ts`. */
const TEMPLATE_SUFFIX = '_test_template';

export default async function setup(): Promise<void> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL is required for tests');

  const target = new URL(baseUrl);
  const devDbName = target.pathname.replace(/^\//, '');
  const templateName = `${devDbName}${TEMPLATE_SUFFIX}`;

  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  // Drop+recreate the template every run so its schema is always a fresh
  // product of the migration pipeline (not whatever leftover state a prior
  // run left behind).
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [templateName],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${templateName}"`);
  await admin.query(`CREATE DATABASE "${templateName}"`);
  await admin.end();

  const templateUrl = new URL(baseUrl);
  templateUrl.pathname = `/${templateName}`;

  const migrator = await createMigrator({
    databaseUrl: templateUrl.toString(),
    migrationsDir: 'src/db/migrations',
  });
  try {
    await migrator.up();
  } finally {
    await migrator.client.end();
  }
}
