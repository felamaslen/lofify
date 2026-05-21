import { execSync } from 'node:child_process';

export default function setup(): void {
  execSync('pnpm db:migrate', {
    stdio: 'inherit',
    env: process.env,
  });
}
