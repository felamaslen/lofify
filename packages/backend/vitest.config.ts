import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const graphqlEntry = require.resolve('graphql');

const libraryPath = mkdtempSync(path.join(tmpdir(), 'lofify-test-library-'));
const transcodeTmpdir = mkdtempSync(path.join(tmpdir(), 'lofify-test-transcode-'));
const transcodeBakeDir = mkdtempSync(path.join(tmpdir(), 'lofify-test-bakes-'));
const diskCacheDir = mkdtempSync(path.join(tmpdir(), 'lofify-test-disk-cache-'));

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
    globals: true,
    globalSetup: ['src/test/global-setup.ts'],
    setupFiles: ['src/test/setup-db.ts'],
    env: {
      LIBRARY_PATH: libraryPath,
      DATABASE_URL: databaseUrl,
      SCAN_CRON: '',
      TRANSCODE_TMPDIR: transcodeTmpdir,
      TRANSCODE_BAKE_DIR: transcodeBakeDir,
      DISK_CACHE_DIR: diskCacheDir,
      PUBLIC_URL: 'http://lofify.test',
    },
  },
});
