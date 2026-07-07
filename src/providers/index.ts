import { loadBoardConfig } from '../config.js';
import { AzureTicketProvider } from './azure.js';
import { GithubTicketProvider } from './github.js';
import { LocalTicketProvider } from './local.js';
import type { TicketProvider } from './types.js';

export interface ResolveOptions {
  /** `--yes`: actually execute remote mutations (otherwise dry-run). */
  yes?: boolean;
}

/**
 * Resolve the active ticket provider from board config. Remote mutations are
 * dry-run unless `opts.yes`. The local provider ignores it (local writes are
 * safe and reversible).
 */
export function resolveProvider(cwd = process.cwd(), opts: ResolveOptions = {}): TicketProvider {
  const cfg = loadBoardConfig(cwd);
  switch (cfg.provider) {
    case 'local':
      return new LocalTicketProvider(cfg.prefix, cwd);
    case 'github':
      return new GithubTicketProvider({
        repo: cfg.repository,
        owner: cfg.projectOwner ?? '',
        number: cfg.projectNumber ?? 0,
        columns: cfg.columns,
        dryRun: !opts.yes,
        cwd,
      });
    case 'azure':
      return new AzureTicketProvider({
        organization: cfg.organization,
        project: cfg.project,
        columns: cfg.columns,
        dryRun: !opts.yes,
        cwd,
      });
    default:
      return new LocalTicketProvider(cfg.prefix, cwd);
  }
}

export type { TicketProvider } from './types.js';
