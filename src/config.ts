import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { slugForStatus } from './providers/status-index.js';
import type { TicketStatus } from './templates/ticket.js';

export type ProviderName = 'local' | 'github' | 'azure';

/**
 * The board column mapping — a display column name per logical status. For Azure
 * these are the real BOARD COLUMNS the user sees (which may outnumber the
 * work-item states, since multiple columns can share one state); for GitHub they
 * are the Projects Status options. Discovered/confirmed by `kodi init`.
 */
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
  /** Azure team that owns the board (needed to resolve board columns). */
  team?: string;
  /** Azure board name whose columns kodi drives (e.g. "Issues"). */
  board?: string;
  /**
   * Azure only: chosen board-column name → the work-item state (`System.State`) it
   * maps to. Runtime moves set BOTH the board column and this state so the card
   * lands in the exact column even when several columns share a state. A column
   * absent here maps to itself (boards where column name == state name).
   */
  columnStates?: Record<string, string>;
  /** Repository for PRs (Azure: bare name; GitHub: `owner/repo`, also where issues are created). */
  repository?: string;
  /** GitHub Projects v2 owner login (org or user) that owns the board. */
  projectOwner?: string;
  /** GitHub Projects v2 board number. */
  projectNumber?: number;
  /** Board status→column map (Azure states / GitHub Status options). */
  columns?: ColumnMap;
  /**
   * Default target branch for `kodi pr create` (the branch PRs merge into), chosen
   * from the remote's real branches during `kodi init`. Only set for the github /
   * azure providers. `--target` on the command overrides it.
   */
  prTarget?: string;
  /**
   * Where `kodi tickets start --worktree` creates worktrees, relative to the
   * project root (the directory `.claude/kodi-dev.yaml` lives under). Defaults
   * to {@link DEFAULT_WORKTREES_DIR} when unset.
   */
  worktreesDir?: string;
  /**
   * The branch `kodi tickets start` bases a NEW `slice/kodi-<id>` branch (or
   * worktree) on. Unset means "the current active branch" — the default git
   * behavior of branching from whatever is checked out. Set this to always cut
   * slices from a fixed integration branch (e.g. `develop`) regardless of what
   * happens to be checked out at the time. Ignored when the slice branch already
   * exists (re-running `start` just reuses it).
   */
  sourceBranch?: string;
}

const DEFAULTS: BoardConfig = { provider: 'local', prefix: 'KODI' };

/** Default location for `kodi tickets start --worktree`, relative to the project
 * root — alongside `.claude/kodi-dev.yaml`. Overridable via `worktreesDir` in
 * `kodi-dev.yaml`. */
export const DEFAULT_WORKTREES_DIR = '.claude/worktrees';

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

/** Persist the board config to the project's `.claude/kodi-dev.yaml`. */
export function writeBoardConfig(root: string, config: BoardConfig): string {
  const path = stateFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(config), 'utf-8');
  return path;
}

/**
 * Local provider storage paths, under the project root's `docs/tickets/`.
 *
 * The status-index model (ADR-0001 §2.2) is the source of truth: `statusYaml`
 * is the authoritative index and `folderFor` resolves one folder per status via
 * the frozen slug map. The two-folder `backlog`/`done` split has been retired
 * (ADR-0001 §2.2). The generated `tickets.md` index has been retired
 * (ADR-0001 §2.5): `status.yaml` is the sole authoritative index.
 */
export function localPaths(cwd = process.cwd()) {
  const root = join(findProjectRoot(cwd), 'docs', 'tickets');
  return {
    root,
    /** Absolute path to the authoritative `status.yaml` index (data-model §2). */
    statusYaml: join(root, 'status.yaml'),
    /** Absolute on-disk folder a ticket in `status` is filed under (data-model §3). */
    folderFor(status: TicketStatus): string {
      return join(root, slugForStatus(status));
    },
  };
}
