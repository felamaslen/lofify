import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const graphqlEntry = require.resolve('graphql');

export default defineConfig({
  resolve: {
    alias: {
      graphql: graphqlEntry,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
