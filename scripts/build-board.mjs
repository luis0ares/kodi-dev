#!/usr/bin/env node
// scripts/build-board.mjs — the "copy" step of the two-step board build (ADR-0002 §2.3).
//
// Assembles a repo-root `board-dist/` from the ALREADY-BUILT Next.js standalone
// output under `board/.next/`. This is a *file-copy import*, not a bundler import:
// the CLI's tsup pipeline never sees the board (C-1). Node built-ins only — no deps.
//
// Security posture (audited):
//   - Destination is the FIXED path `<repoRoot>/board-dist` — never computed from
//     input. It is removed then recreated on every run (idempotent, reproducible).
//   - Copies from an explicit 3-entry allowlist only; never sweeps the board tree,
//     never globs, so `.env*`, `.npmrc`, `.git`, keys, etc. can never be picked up.
//   - Symlinks are preserved verbatim (not dereferenced) so the standalone
//     `node_modules` symlinks are not followed out of the source tree.

import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

// Fixed destination under repo root. Not interpolated, not derived from argv.
const DEST = resolve(repoRoot, 'board-dist');

const standalone = resolve(repoRoot, 'board/.next/standalone');
const staticDir = resolve(repoRoot, 'board/.next/static');
const publicDir = resolve(repoRoot, 'board/public');

function fail(msg) {
  console.error(`\n[build-board] ERROR: ${msg}\n`);
  process.exit(1);
}

// --- Preconditions: step 1 (`next build` standalone) must have run. ---------
if (!existsSync(standalone)) {
  fail(
    `missing ${standalone}\n` +
      `  Run the board build first (pnpm -C board build with output: 'standalone').`,
  );
}
if (!existsSync(staticDir)) {
  fail(
    `missing ${staticDir}\n` +
      `  The Next static assets are absent — did the board build complete?`,
  );
}

// --- Clean destination (fixed path) then recreate. --------------------------
rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

// Guard: every write target must resolve inside DEST.
function destPath(...segments) {
  const p = resolve(DEST, ...segments);
  if (p !== DEST && !p.startsWith(DEST + '/')) {
    fail(`refusing to write outside board-dist: ${p}`);
  }
  return p;
}

const copyOpts = { recursive: true, verbatimSymlinks: true };
const copied = [];

// 1. standalone/* -> board-dist/  (server.js, .next server bundle, node_modules, package.json)
cpSync(standalone, destPath(), copyOpts);
copied.push('board/.next/standalone/ -> board-dist/');

// 2. static -> board-dist/.next/static
cpSync(staticDir, destPath('.next', 'static'), copyOpts);
copied.push('board/.next/static -> board-dist/.next/static');

// 3. public -> board-dist/public  (only if present)
if (existsSync(publicDir)) {
  cpSync(publicDir, destPath('public'), copyOpts);
  copied.push('board/public -> board-dist/public');
} else {
  copied.push('board/public -> (skipped, not present)');
}

console.log('[build-board] assembled board-dist/:');
for (const line of copied) console.log(`  - ${line}`);
