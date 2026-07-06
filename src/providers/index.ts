import { loadBoardConfig } from '../config.js';
import { LocalTicketProvider } from './local.js';
import type { TicketProvider } from './types.js';

/**
 * Resolve the active ticket provider from board config. Remote providers
 * (github/azure) are wired in a later phase; for now only `local` is built.
 */
export function resolveProvider(cwd = process.cwd()): TicketProvider {
  const cfg = loadBoardConfig(cwd);
  switch (cfg.provider) {
    case 'local':
      return new LocalTicketProvider(cfg.prefix, cwd);
    case 'github':
    case 'azure':
      throw new Error(
        `provider "${cfg.provider}" is not implemented yet (F4). Use the local provider for now.`,
      );
    default:
      return new LocalTicketProvider(cfg.prefix, cwd);
  }
}

export type { TicketProvider } from './types.js';
