// Board-local Vitest config. Two kinds of tests share this project:
//
//  1. KODI-009 read-path unit/integration tests (`test/**/*.test.ts`) — node-fs
//     code, no DOM, so the DEFAULT `node` environment is used deliberately.
//  2. KODI-010 UI component tests (`test/**/*.test.tsx`) — React components that
//     need a DOM. Each `.tsx` test file opts into jsdom with a per-file
//     `// @vitest-environment jsdom` docblock, so the node-env read-path tests
//     above are left untouched.
//
// `esbuild.jsx: 'automatic'` gives the React 19 automatic JSX runtime for the
// `.tsx` component tests without adding a babel/plugin-react dependency (the
// node `.ts` tests carry no JSX and are unaffected). The `@/*` alias mirrors
// tsconfig.json `paths` so `@/lib/...` / `@/app/...` imports resolve under
// vitest without an extra tsconfig-paths plugin.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const config = defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});

export default config;
