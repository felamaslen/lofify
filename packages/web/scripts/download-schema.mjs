#!/usr/bin/env node
// Pulls the live GraphQL SDL from the backend and writes it next to
// the source so gql.tada / graphqlsp can type-check operations.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const url =
  process.env.SCHEMA_URL ?? 'http://localhost:4000/graphql/schema.graphql';

const dest = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema.graphql',
);

const res = await fetch(url);
if (!res.ok) {
  console.error(`failed to fetch ${url}: ${res.status}`);
  process.exit(1);
}
const sdl = await res.text();
await writeFile(dest, sdl, 'utf8');
console.log(`wrote ${dest} (${sdl.length} bytes) from ${url}`);
