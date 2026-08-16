import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { slugForStatus } from './providers/status-index.js';
import type { TicketStatus } from './templates/ticket.js';

export type ProviderName = 'local' | 'github' | 'azure';

/** Where documentation artifacts (PRDs, ADRs, security, plans, diagrams, …) live. */
export type DocsProviderName = 'local' | 'azure-wiki';

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
   * Docs backend, chosen at `kodi init` (or `kodi docs migrate`). Absent/undefined
   * behaves as `'local'` (back-compat with projects configured before this field
   * existed). The azure-wiki provider reuses `organization`/`project` above — it
   * has no separate org/project pair of its own.
   */
  docsProvider?: DocsProviderName;
  /** Azure wiki name/id. Defaults to `${project}.wiki` (Azure's own project-wiki
   * naming convention) when unset. Only meaningful for `docsProvider: 'azure-wiki'`. */
  docsWiki?: string;
  /**
   * The project's registered doc types (e.g. `['prd', 'adr', 'security', 'plan',
   * 'diagrams']`) — the ONLY source of truth for what `kodi docs create <type>` /
   * `list <type>` accept. Never a fixed enum in code: edit via `kodi docs types
   * add/remove`, seeded at `kodi init` time.
   */
  docsTypes?: string[];
}

const DEFAULTS: BoardConfig = { provider: 'local', prefix: 'KODI' };

/** The doc types `kodi init`/`installHarness` seed a fresh project with — the same
 * 5 folders the docs scaffold has always created. Editable afterward via
 * `kodi docs types add/remove`; never a fixed enum anywhere else in the code. */
export const DEFAULT_DOC_TYPES = ['prd', 'adr', 'security', 'plan', 'diagrams'];

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
