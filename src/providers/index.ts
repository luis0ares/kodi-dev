import { loadBoardConfig } from '../config.js';
import { AzureTicketProvider } from './azure.js';
import { GithubTicketProvider } from './github.js';
import { LocalTicketProvider } from './local.js';
import type { TicketProvider } from './types.js';

export interface ResolveOptions {
  /** `--yes`: actually execute remote mutations (otherwise dry-run). */
  yes?: boolean;
  /**
   * Override the configured `repository` for this one call (`--repository`), so a
   * ticket can be filed somewhere other than the project's own repo. GitHub only:
   * it is the repo issues live in. Azure work items belong to a PROJECT, not a
   * repository, and the local provider has no remote at all — passing it there is
   * rejected rather than silently ignored.
   */
  repository?: string;
  /**
   * Skip attaching a created issue to the Projects v2 board (`--no-project`).
   * Filing into another repository usually means filing outside this project's
   * board; without this the create would fail (or land a foreign issue on the
   * board) right after the issue already exists. GitHub only.
   */
  noProject?: boolean;
}

/**
 * Resolve the active ticket provider from board config. Remote mutations are
 * dry-run unless `opts.yes`. The local provider ignores it (local writes are
 * safe and reversible).
 */
export function resolveProvider(cwd = process.cwd(), opts: ResolveOptions = {}): TicketProvider {
  const cfg = loadBoardConfig(cwd);
  if ((opts.repository || opts.noProject) && cfg.provider !== 'github') {
    const flag = opts.repository ? '--repository' : '--no-project';
    throw new Error(
      `${flag} applies to the github provider only (the active provider is "${cfg.provider}").`,
    );
  }
  switch (cfg.provider) {
    case 'local':
      return new LocalTicketProvider(cfg.prefix, cwd);
    case 'github':
      return new GithubTicketProvider({
        repo: opts.repository ?? cfg.repository,
        owner: cfg.projectOwner ?? '',
        number: cfg.projectNumber ?? 0,
        columns: cfg.columns,
        dryRun: !opts.yes,
        attachToProject: !opts.noProject,
        cwd,
      });
    case 'azure':
      return new AzureTicketProvider({
        organization: cfg.organization,
        project: cfg.project,
        team: cfg.team,
        columns: cfg.columns,
        columnStates: cfg.columnStates,
        dryRun: !opts.yes,
        cwd,
      });
    default:
      return new LocalTicketProvider(cfg.prefix, cwd);
  }
}

export type { TicketProvider } from './types.js';
