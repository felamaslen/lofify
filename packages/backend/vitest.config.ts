import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const graphqlEntry = require.resolve('graphql');

const libraryPath = mkdtempSync(path.join(tmpdir(), 'lofify-test-library-'));

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://lofify:lofify@localhost:5433/lofify';
process.env.DATABASE_URL = databaseUrl;

export default defineConfig({
  resolve: {
    alias: {
      graphql: graphqlEntry,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    silent: 'passed-only',
    globalSetup: ['src/test/global-setup.ts'],
    setupFiles: ['src/test/setup-db.ts'],
    env: {
      LIBRARY_PATH: libraryPath,
      DATABASE_URL: databaseUrl,
      SCAN_CRON: '',
    },
  },
});
