import path from 'node:path';

const ROOT = process.cwd();

export default {
  '**/*.{ts,tsx,js,mjs,cjs}': (files) => {
    const quoted = files.map(quote).join(' ');
    // eslint --fix sorts imports; prettier --write owns formatting. Running
    // both here keeps committed code identical to `pnpm format`, which also
    // runs prettier. Prettier honours .prettierignore for these explicit
    // paths, so generated files are left untouched.
    const cmds = [
      `eslint --fix --max-warnings=0 --no-warn-ignored ${quoted}`,
      `prettier --write ${quoted}`,
    ];

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
  '**/*.{json,md,yml,yaml,css,html}': (files) => [`prettier --write ${files.map(quote).join(' ')}`],
};

function quote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
