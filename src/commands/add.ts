import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * A skill-pack is a bundle of skills for a (stack + role) plus a thin manifest.
 * `kodi add` copies its skills into `.claude/skills/`, merges the manifest's
 * CLAUDE.md fragment into the thin root CLAUDE.md, and records the pack. It is an
 * explicit action — nothing is auto-recommended or auto-installed.
 */
export const PackManifestSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  framework: z.string().optional(),
  language: z.string().optional(),
  /** Fragment merged into the thin root CLAUDE.md (stack line, gate commands, …). */
  claude_md: z.string().optional(),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

/** Where bundled packs would live (none shipped yet — community registry deferred). */
function bundledPacksDir(): string {
  return fileURLToPath(new URL('../packs/', import.meta.url));
}

/** Resolve a pack reference: an existing directory path, or a bundled pack name. */
export function resolvePackDir(ref: string): string {
  if (existsSync(ref) && statSync(ref).isDirectory()) return ref;
  const bundled = join(bundledPacksDir(), ref);
  if (existsSync(bundled)) return bundled;
  throw new Error(
    `skill-pack "${ref}" not found. Pass a path to a pack directory (no bundled packs yet).`,
  );
}

function copyTree(src: string, dest: string, force: boolean): string[] {
  const written: string[] = [];
  const walk = (s: string, d: string) => {
    for (const entry of readdirSync(s)) {
      const sp = join(s, entry);
      const dp = join(d, entry);
      if (statSync(sp).isDirectory()) walk(sp, dp);
      else {
        if (existsSync(dp) && !force) continue;
        mkdirSync(dirname(dp), { recursive: true });
        copyFileSync(sp, dp);
        written.push(dp);
      }
    }
  };
  if (existsSync(src)) walk(src, dest);
  return written;
}

/** Idempotently merge a pack's CLAUDE.md fragment inside a managed marker block. */
export function mergeClaudeMd(existing: string, name: string, fragment: string): string {
  const open = `<!-- kodi-pack:${name} -->`;
  const close = `<!-- /kodi-pack:${name} -->`;
  const block = `${open}\n${fragment.trim()}\n${close}`;
  const re = new RegExp(`${open}[\\s\\S]*?${close}`);
  if (re.test(existing)) return existing.replace(re, block);
  const base = existing.trimEnd();
  return (base ? base + '\n\n' : '') + block + '\n';
}

export interface AddResult {
  name: string;
  skills: string[];
  claudeMdMerged: boolean;
}

export function installPack(root: string, packDir: string, force = false): AddResult {
  const manifest = PackManifestSchema.parse(
    parseYaml(readFileSync(join(packDir, 'manifest.yaml'), 'utf-8')),
  );

  const skills = copyTree(join(packDir, 'skills'), join(root, '.claude', 'skills'), force);

  let claudeMdMerged = false;
  if (manifest.claude_md) {
    const claudeMdPath = join(root, 'CLAUDE.md');
    const current = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : '';
    writeFileSync(claudeMdPath, mergeClaudeMd(current, manifest.name, manifest.claude_md), 'utf-8');
    claudeMdMerged = true;
  }

  // record the installed pack (non-secret)
  const packsPath = join(root, '.claude', 'kodi', 'packs.yaml');
  const installed: string[] = existsSync(packsPath)
    ? (parseYaml(readFileSync(packsPath, 'utf-8'))?.installed ?? [])
    : [];
  if (!installed.includes(manifest.name)) installed.push(manifest.name);
  mkdirSync(dirname(packsPath), { recursive: true });
  writeFileSync(packsPath, `installed:\n${installed.map((p) => `  - ${p}`).join('\n')}\n`, 'utf-8');

  return { name: manifest.name, skills: skills.map((s) => basename(s)), claudeMdMerged };
}

export function registerAddCommand(program: Command) {
  program
    .command('add <pack>')
    .description('Install a skill-pack (bundle of skills + CLAUDE.md fragment) — explicit only')
    .option('-d, --dir <path>', 'target project directory', process.cwd())
    .option('--force', 'overwrite existing skills', false)
    .action((pack, o) => {
      const res = installPack(String(o.dir), resolvePackDir(pack), o.force);
      process.stdout.write(
        `Installed skill-pack "${res.name}"\n` +
          `  skills: ${res.skills.length ? res.skills.join(', ') : '(none new)'}\n` +
          `  CLAUDE.md: ${res.claudeMdMerged ? 'merged fragment' : 'no fragment'}\n`,
      );
    });
}
