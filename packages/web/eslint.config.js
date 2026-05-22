import root from '../../eslint.config.js';
import globals from 'globals';

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
];
