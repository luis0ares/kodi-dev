import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const HOOK_COMMAND = 'kodi hook session-start';
const SESSION_MATCHER = 'startup|resume|clear|compact';

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

/** Idempotently merge the kodi SessionStart hook into a settings.json object. */
export function mergeSessionStartHook(settings: Record<string, any>): boolean {
  settings.hooks ??= {};
  const arr: HookEntry[] = (settings.hooks.SessionStart ??= []);
  const already = arr.some((e) => e.hooks?.some((h) => h.command === HOOK_COMMAND));
  if (already) return false;
  arr.push({ matcher: SESSION_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  return true;
}

/** The packaged assets directory (agents + skills), resolved next to the bundle. */
export function defaultAssetsDir(): string {
  return fileURLToPath(new URL('../assets/', import.meta.url));
}

/**
 * Recursively copy a source tree into a destination, skipping files that already
 * exist unless `force`. Returns the destination-relative paths actually written.
 */
function copyTree(srcRoot: string, destRoot: string, force: boolean, reportBase: string): string[] {
  const written: string[] = [];
  if (!existsSync(srcRoot)) return written;
  const walk = (src: string, dest: string) => {
    for (const entry of readdirSync(src)) {
      const s = join(src, entry);
      const d = join(dest, entry);
      if (statSync(s).isDirectory()) {
        walk(s, d);
      } else {
        if (existsSync(d) && !force) continue;
        mkdirSync(dirname(d), { recursive: true });
        copyFileSync(s, d);
        written.push(join(reportBase, relative(destRoot, d)));
      }
    }
  };
  walk(srcRoot, destRoot);
  return written;
}

/**
 * Copy every `*.md` under `srcRoot` (any depth) into a single flat `destDir`.
 * Agents are organized by phase in the source (assets/agents/<phase>/) but
 * installed flat into `.claude/agents/` so discovery is independent of whether
 * Claude Code scans project-agent subdirectories. `README.md` files (phase docs
 * like the empty ticketing folder) are skipped.
 */
function copyMarkdownFlat(srcRoot: string, destDir: string, force: boolean, reportBase: string): string[] {
  const written: string[] = [];
  if (!existsSync(srcRoot)) return written;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const s = join(dir, entry);
      if (statSync(s).isDirectory()) walk(s);
      else if (entry.endsWith('.md') && entry !== 'README.md') {
        const d = join(destDir, entry);
        if (existsSync(d) && !force) continue;
        mkdirSync(destDir, { recursive: true });
        copyFileSync(s, d);
        written.push(join(reportBase, entry));
      }
    }
  };
  walk(srcRoot);
  return written;
}

export interface InstallOptions {
  force?: boolean;
  assetsDir?: string;
}

/** Install the kodi harness into a target project. Returns what changed. */
export function installHarness(root: string, opts: InstallOptions = {}): string[] {
  const force = opts.force ?? false;
  const assetsDir = opts.assetsDir ?? defaultAssetsDir();
  const claude = join(root, '.claude');
  const changed: string[] = [];

  // 1. SessionStart hook (merge, never clobber other hooks)
  mkdirSync(claude, { recursive: true });
  const settingsPath = join(claude, 'settings.json');
  const settings: Record<string, any> = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, 'utf-8'))
    : {};
  if (mergeSessionStartHook(settings)) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    changed.push('.claude/settings.json (SessionStart hook)');
  }

  // 2. Board config (default local; do not clobber)
  const boardPath = join(claude, 'kodi', 'board.yaml');
  if (!existsSync(boardPath)) {
    mkdirSync(dirname(boardPath), { recursive: true });
    writeFileSync(boardPath, 'provider: local\nprefix: KODI\n', 'utf-8');
    changed.push('.claude/kodi/board.yaml');
  }

  // 3. Skills + agents copied from packaged assets
  changed.push(
    ...copyTree(join(assetsDir, 'skills'), join(claude, 'skills'), force, '.claude/skills'),
    ...copyMarkdownFlat(join(assetsDir, 'agents'), join(claude, 'agents'), force, '.claude/agents'),
  );

  // 4. docs/ scaffold
  for (const sub of ['prd', 'adr', 'diagrams', 'plan', 'tickets', 'security']) {
    mkdirSync(join(root, 'docs', sub), { recursive: true });
  }

  return changed;
}

export function registerInitCommand(program: Command) {
  program
    .command('init')
    .description('Install the kodi harness into this project (SessionStart hook + agents/skills + scaffold)')
    .option('-d, --dir <path>', 'target project directory', process.cwd())
    .option('--force', 'overwrite existing agents/skills', false)
    .action((o) => {
      const changed = installHarness(String(o.dir), { force: o.force });
      process.stdout.write(
        changed.length
          ? `kodi init: installed\n${changed.map((c) => `  + ${c}`).join('\n')}\n\n` +
              `SessionStart wired to \`${HOOK_COMMAND}\` (matchers: ${SESSION_MATCHER}).\n` +
              `Ensure \`kodi\` is on PATH (global install) so the hook resolves.\n`
          : 'kodi init: already installed (nothing to change).\n',
      );
    });
}
