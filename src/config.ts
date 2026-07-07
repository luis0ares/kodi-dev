import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { slugForStatus } from './providers/status-index.js';
import type { TicketStatus } from './templates/ticket.js';

export type ProviderName = 'local' | 'github' | 'azure';

/** The board column mapping (Azure states / GitHub Projects Status options), discovered/confirmed by `kodi init`. */
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
  /** Repository for PRs (Azure: bare name; GitHub: `owner/repo`, also where issues are created). */
  repository?: string;
  /** GitHub Projects v2 owner login (org or user) that owns the board. */
  projectOwner?: string;
  /** GitHub Projects v2 board number. */
  projectNumber?: number;
  /** Board status→column map (Azure states / GitHub Status options). */
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

/**
 * Local provider storage paths, under the project root's `docs/tickets/`.
 *
 * The status-index model (ADR-0001 §2.2) is the source of truth: `statusYaml`
 * is the authoritative index and `folderFor` resolves one folder per status via
 * the frozen slug map. The two-folder `backlog`/`done` split has been retired
 * (ADR-0001 §2.2). The `index` (`tickets.md`) key is kept for now — it drives
 * the generated human-readable table; its retirement is a separate downstream
 * slice (ADR-0001 §2.5, KODI-005).
 */
export function localPaths(cwd = process.cwd()) {
  const root = join(findProjectRoot(cwd), 'docs', 'tickets');
  return {
    root,
    /** Generated human-readable table (retirement deferred to KODI-005). */
    index: join(root, 'tickets.md'),
    /** Absolute path to the authoritative `status.yaml` index (data-model §2). */
    statusYaml: join(root, 'status.yaml'),
    /** Absolute on-disk folder a ticket in `status` is filed under (data-model §3). */
    folderFor(status: TicketStatus): string {
      return join(root, slugForStatus(status));
    },
  };
}
