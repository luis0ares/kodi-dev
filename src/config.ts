import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type ProviderName = 'local' | 'azure';

/** The Azure board column mapping, discovered/confirmed by `kodi init`. */
export interface ColumnMap {
  /** Column a new issue lands in (e.g. "To Do"). */
  todo: string;
  inProgress?: string;
  toReview?: string;
  done?: string;
}

export interface BoardConfig {
  provider: ProviderName;
  /** Ticket key prefix for the local provider, e.g. "KODI". */
  prefix: string;
  /** Azure org URL (e.g. https://dev.azure.com/org). */
  organization?: string;
  /** Azure project name. */
  project?: string;
  /** Azure repository name (for PRs). */
  repository?: string;
  /** Azure board status→column map. */
  columns?: ColumnMap;
}

const DEFAULTS: BoardConfig = { provider: 'local', prefix: 'KODI' };

/** The kodi state file name (per-project, non-secret). */
export const STATE_FILE = 'kodi-dev.yaml';

/** Path to the state file inside a project root. */
export function stateFilePath(root: string): string {
  return join(root, '.claude', STATE_FILE);
}

/**
 * Find the project root by walking up from `cwd` for a `.claude/kodi-dev.yaml`.
 * Falls back to `cwd` when none is found (fresh project / local default), so the
 * CLI works from any subdirectory of a configured project.
 */
export function findProjectRoot(cwd = process.cwd()): string {
  let dir = cwd;
  while (true) {
    if (existsSync(stateFilePath(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/**
 * Resolve the active board config from `.claude/kodi-dev.yaml` (searched upward
 * from cwd). Falls back to the local provider so the CLI works unconfigured.
 */
export function loadBoardConfig(cwd = process.cwd()): BoardConfig {
  const path = stateFilePath(findProjectRoot(cwd));
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = parseYaml(readFileSync(path, 'utf-8')) ?? {};
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Local provider storage paths, under the project root's `docs/tickets/`. */
export function localPaths(cwd = process.cwd()) {
  const root = join(findProjectRoot(cwd), 'docs', 'tickets');
  return {
    root,
    backlog: join(root, 'backlog'),
    done: join(root, 'done'),
    index: join(root, 'tickets.md'),
  };
}
