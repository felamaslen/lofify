/** Git commit this bundle was built from, baked in at build time; `dev` locally. */
export const GIT_SHA = import.meta.env.VITE_GIT_SHA ?? 'dev';
