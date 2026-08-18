import {
  DEFAULT_DOC_TYPES,
  loadBoardConfig,
  type BoardConfig,
  type DocsProviderName,
} from '../config.js';
import { AzureWikiDocsProvider } from './azure-wiki-docs.js';
import { AzureTicketProvider } from './azure.js';
import { GithubTicketProvider } from './github.js';
import { LocalDocsProvider } from './local-docs.js';
import { LocalTicketProvider } from './local.js';
import type { DocsProvider, TicketProvider } from './types.js';

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

/**
 * Build a docs provider for an EXPLICIT backend name (not necessarily the one
 * `kodi-dev.yaml` currently has configured) — the seam `docs migrate` needs to
 * construct both the source and the target regardless of which one is "active".
 */
export function docsProviderFor(
  name: DocsProviderName,
  cfg: BoardConfig,
  cwd = process.cwd(),
  opts: ResolveOptions = {},
): DocsProvider {
  const docsTypes = cfg.docsTypes ?? DEFAULT_DOC_TYPES;
  if (name === 'azure-wiki') {
    if (!cfg.organization || !cfg.project) {
      throw new Error(
        'docs provider is "azure-wiki" but no Azure organization/project is configured — re-run `kodi init`.',
      );
    }
    return new AzureWikiDocsProvider({
      organization: cfg.organization,
      project: cfg.project,
      wiki: cfg.docsWiki,
      docsTypes,
      dryRun: !opts.yes,
    });
  }
  return new LocalDocsProvider(docsTypes, cwd);
}

/**
 * Resolve the active docs provider from board config. Mirrors {@link resolveProvider}:
 * `--yes` gates azure-wiki mutations, the local provider ignores it (local writes
 * are safe and reversible).
 */
export function resolveDocsProvider(cwd = process.cwd(), opts: ResolveOptions = {}): DocsProvider {
  const cfg = loadBoardConfig(cwd);
  return docsProviderFor(cfg.docsProvider ?? 'local', cfg, cwd, opts);
}

export type { TicketProvider } from './types.js';
export type { DocsProvider } from './types.js';
