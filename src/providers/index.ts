import { loadBoardConfig } from '../config.js';
import { AzureTicketProvider } from './azure.js';
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
    case 'local':
      return new LocalTicketProvider(cfg.prefix, cwd);
  }
}

export type { TicketProvider } from './types.js';
