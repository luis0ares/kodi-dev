// Board-local Vitest config. These are node-fs unit/integration tests over the
// KODI-009 read path (status-index resolver, frontmatter projector, board
// assembler, and the `getBoard()` server-action seam) — no DOM, so the `node`
// environment is used deliberately (no jsdom). The `@/*` alias mirrors
// tsconfig.json `paths` so `app/actions/board.ts`'s `@/lib/...` imports resolve
// under vitest without an extra tsconfig-paths plugin.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const config = defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

export default config;
