import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** Give each vitest worker its own library directory, so workers running scan tests in parallel don't write to and clear each other's files. Mirrors the per-worker database isolation in `setup-db.ts`: the shared base path comes from `LIBRARY_PATH` (set once in `vitest.config.ts`); here we nest a stable per-worker subdir under it and repoint the env before the app — and its `env.ts` — is imported. */
const workerId = process.env.VITEST_POOL_ID ?? '0';
const base = process.env.LIBRARY_PATH;
if (!base) throw new Error('LIBRARY_PATH is required for tests');

const workerLibrary = path.join(base, `worker-${workerId}`);
mkdirSync(workerLibrary, { recursive: true });
process.env.LIBRARY_PATH = workerLibrary;
