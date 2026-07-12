import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  minify: false,
  // node:sqlite is newer than some esbuild builtin lists; keep it external and
  // prefixed so the bundle imports `node:sqlite`, not a bare `sqlite` package.
  external: ['node:sqlite'],
  banner: { js: '#!/usr/bin/env node' },
});
