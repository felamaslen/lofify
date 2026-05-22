import path from 'node:path';

const ROOT = process.cwd();

export default {
  '**/*.{ts,tsx,js,mjs,cjs}': (files) => {
    const cmds = [`eslint --fix --max-warnings=0 --no-warn-ignored ${files.map(quote).join(' ')}`];

    const backendFiles = files.filter((f) => f.startsWith(path.join(ROOT, 'packages/backend/')));
    if (backendFiles.length > 0) {
      const rels = backendFiles
        .map((f) => path.relative(path.join(ROOT, 'packages/backend'), f))
        .map(quote)
        .join(' ');
      cmds.push(
        `pnpm --filter @lofify/backend exec vitest related --run --passWithNoTests ${rels}`,
      );
    }
    return cmds;
  },
};

function quote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
