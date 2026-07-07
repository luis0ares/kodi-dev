import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type ProviderName = 'local' | 'azure';

export interface BoardConfig {
  provider: ProviderName;
  /** Ticket key prefix for the local provider, e.g. "KODI". */
  prefix: string;
  /** Remote coordinates (github/azure); non-secret. */
  repository?: string;
  organization?: string;
  project?: string;
}

const DEFAULTS: BoardConfig = { provider: 'local', prefix: 'KODI' };

/**
 * Resolve the active board config from `.claude/kodi/board.yaml` (non-secret).
 * Falls back to the local provider so the CLI works with zero configuration.
 */
export function loadBoardConfig(cwd = process.cwd()): BoardConfig {
  const path = join(cwd, '.claude', 'kodi', 'board.yaml');
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = parseYaml(readFileSync(path, 'utf-8')) ?? {};
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Local provider storage paths, all under `docs/tickets/`. */
export function localPaths(cwd = process.cwd()) {
  const root = join(cwd, 'docs', 'tickets');
  return {
    root,
    backlog: join(root, 'backlog'),
    done: join(root, 'done'),
    index: join(root, 'tickets.md'),
  };
}
