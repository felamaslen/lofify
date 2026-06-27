import globals from 'globals';

import root from '../../eslint.config.js';

export default [
  ...root,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // Build tooling that runs in Node (Vite config, dev-server plugins, scripts).
    files: ['*.{ts,js,mjs}', 'scripts/**/*.{ts,js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
