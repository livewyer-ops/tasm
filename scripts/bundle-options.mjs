export const browserOptions = { bundle: true, format: 'esm', target: 'es2022', loader: { '.sql': 'text' } };

export const coreOptions = {
  ...browserOptions,
  // PGlite disables "module" in browsers but uses the prefixed spelling in its Node-only branch.
  alias: { 'node:module': 'data:text/javascript,export{}' },
};
