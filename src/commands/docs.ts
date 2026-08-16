import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { DEFAULT_DOC_TYPES, findProjectRoot, loadBoardConfig, writeBoardConfig } from '../config.js';
import { docsProviderFor, resolveDocsProvider } from '../providers/index.js';
import type { DocContent, DocRef, DocsProvider } from '../providers/types.js';
import { canonicalizeDocId, renderDocMarkdown } from '../templates/doc.js';

function out(data: unknown, json: boolean, human: () => string) {
  if (json) process.stdout.write(JSON.stringify(data) + '\n');
  else process.stdout.write(human() + '\n');
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** `--meta key=value` (repeatable) -> a plain object of extra frontmatter fields. */
function parseMeta(pairs: string[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 0) throw new Error(`--meta "${pair}" is not "key=value"`);
    meta[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return meta;
}

/** Validate a `type` argument against the project's registered `docsTypes` —
 * never a fixed enum in code. */
function requireKnownType(type: string, docsTypes: string[]): string {
  const t = type.toLowerCase();
  if (!docsTypes.includes(t)) {
    throw new Error(
      `unknown doc type "${t}" — known: ${docsTypes.join(', ')}. Add it with \`kodi docs types add ${t}\`.`,
    );
  }
  return t;
}

/** `[####------] 12/41`, or an empty string once `total` isn't known yet. */
function progressBar(current: number, total: number, width = 20): string {
  const filled = total > 0 ? Math.round((current / total) * width) : 0;
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

const STATUS_LABEL: Record<MigrateProgress['status'], string> = {
  migrated: 'migrated',
  skipped: 'skipped ',
  failed: 'FAILED  ',
};

/**
 * Console progress for `docs migrate` — every step is a real `az`/fs
 * round-trip against azure-wiki, so a multi-dozen-doc migrate can otherwise
 * sit silent for minutes. TTY: one redrawn line with a bar, cleared to a
 * final summary line when done. Non-TTY (piped, CI, log file): one
 * append-only line per doc — a redrawn line would just be garbage in a log.
 * Always STDERR, so `--json`'s stdout summary stays machine-readable.
 */
function reportMigrateProgress(event: MigrateProgress): void {
  const bar = progressBar(event.index, event.total);
  const line = `${bar} ${event.index}/${event.total} ${STATUS_LABEL[event.status]} ${event.ref.id} — ${event.ref.name}`;
  if (process.stderr.isTTY) {
    process.stderr.write(`\r${line}`.padEnd(process.stderr.columns ?? 80));
    if (event.index === event.total) process.stderr.write('\n');
  } else {
    process.stderr.write(`${line}\n`);
  }
}

/**
 * Regenerate the index, but never let a failure here hide a mutation that
 * already succeeded (the doc IS created/deleted at this point) — warn on
 * stderr and keep going instead of throwing past the caller's `out()`.
 */
async function refreshIndex(provider: DocsProvider): Promise<void> {
  try {
    await provider.updateIndex();
  } catch (e) {
    process.stderr.write(
      `warning: doc saved, but regenerating the index failed (${e instanceof Error ? e.message : String(e)}) — run \`kodi docs reindex --yes\` to retry.\n`,
    );
  }
}

export interface MigrateSummary {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
}

/** One migration step's outcome, reported as it happens — each step is a real
 * `az`/fs round-trip against azure-wiki, so a multi-dozen-doc migrate can take
 * minutes with zero other feedback otherwise. */
export interface MigrateProgress {
  index: number; // 1-based
  total: number;
  ref: DocRef;
  status: 'migrated' | 'skipped' | 'failed';
}

export interface MigrateOptions {
  type?: string;
  force?: boolean;
  /** Whether the TARGET actually writes (dry-run when false, mirrors `--yes`). */
  apply?: boolean;
  /** Called after every doc is processed (not during `source.list()` itself,
   * which has no natural progress increments). */
  onProgress?: (event: MigrateProgress) => void;
}

/**
 * Copy every doc `source` has (optionally scoped to one `type`) onto `target`,
 * preserving each doc's id (via `put`, not `create` — an auto-incrementing
 * `create` would let the two backends' numbering drift, defeating the whole
 * point of a reversible round-trip). A target doc that already exists is
 * skipped unless `force`. `target.updateIndex()` runs once at the end, only
 * when `apply` (no point regenerating an index that's about to be
 * dry-run-previewed away). Exported standalone so it's testable against two
 * stub in-memory `DocsProvider`s, without a real `az` or Commander action.
 */
export async function runMigrate(
  source: DocsProvider,
  target: DocsProvider,
  opts: MigrateOptions = {},
): Promise<MigrateSummary> {
  const refs = await source.list(opts.type);
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let index = 0;
  for (const ref of refs) {
    index++;
    const report = (status: MigrateProgress['status']) =>
      opts.onProgress?.({ index, total: refs.length, ref, status });

    const existing = opts.force ? null : await target.get(ref.id);
    if (existing) {
      skipped++;
      report('skipped');
      continue;
    }
    const doc = await source.get(ref.id);
    if (!doc) {
      failed++;
      report('failed');
      continue;
    }
    try {
      await target.put(ref.id, {
        name: doc.name,
        description: doc.description,
        body: doc.body,
        meta: doc.meta,
      });
      migrated++;
      report('migrated');
    } catch {
      failed++;
      report('failed');
    }
  }
  // never let a failed index regen erase a migration that otherwise succeeded —
  // same reasoning as `refreshIndex` below, inlined here since MigrateSummary has
  // no stderr-writing concern of its own (the command layer reports the summary).
  if (opts.apply) {
    try {
      await target.updateIndex();
    } catch {
      /* the migrated docs themselves are still valid; `kodi docs reindex` can retry */
    }
  }
  return { total: refs.length, migrated, skipped, failed };
}

export function registerDocsCommand(program: Command) {
  const docs = program
    .command('docs')
    .description('Manage documentation artifacts (PRDs, ADRs, security, plans, …) across the active docs provider');

  const types = docs.command('types').description("Manage the project's registered doc types");

  types
    .command('list')
    .description('List the registered doc types')
    .option('--json', 'machine-readable output', false)
    .action((o) => {
      const list = loadBoardConfig().docsTypes ?? DEFAULT_DOC_TYPES;
      out(list, o.json, () => list.join('\n'));
    });

  types
    .command('add <type>')
    .description('Register a new doc type')
    .action((type: string) => {
      const root = findProjectRoot();
      const cfg = loadBoardConfig(root);
      const t = type.toLowerCase();
      const list = cfg.docsTypes ?? DEFAULT_DOC_TYPES;
      if (list.includes(t)) {
        process.stdout.write(`doc type "${t}" is already registered\n`);
        return;
      }
      writeBoardConfig(root, { ...cfg, docsTypes: [...list, t] });
      process.stdout.write(`added doc type "${t}"\n`);
    });

  types
    .command('remove <type>')
    .description('Unregister a doc type (existing docs of that type are left untouched)')
    .action((type: string) => {
      const root = findProjectRoot();
      const cfg = loadBoardConfig(root);
      const t = type.toLowerCase();
      const list = cfg.docsTypes ?? DEFAULT_DOC_TYPES;
      if (!list.includes(t)) {
        process.stdout.write(`doc type "${t}" is not registered\n`);
        return;
      }
      writeBoardConfig(root, { ...cfg, docsTypes: list.filter((x) => x !== t) });
      process.stdout.write(`removed doc type "${t}"\n`);
    });

  docs
    .command('create <type>')
    .description('Create a new doc artifact of the given type')
    .requiredOption('--name <text>', 'artifact title (frontmatter "name")')
    .requiredOption('--description <text>', 'one-line summary (frontmatter "description")')
    .option('-f, --file <path>', 'markdown body from a file')
    .option('--content <text>', 'markdown body inline')
    .option('--meta <key=value>', 'extra frontmatter field (repeatable)', collect, [])
    .option('--comment <text>', 'azure wiki commit comment (ignored by the local provider)')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (type: string, o) => {
      const cfg = loadBoardConfig();
      const t = requireKnownType(type, cfg.docsTypes ?? DEFAULT_DOC_TYPES);
      const body = o.file ? readFileSync(String(o.file), 'utf-8') : String(o.content ?? '');
      const provider = resolveDocsProvider(process.cwd(), { yes: o.yes });
      const created = await provider.create(t, {
        name: o.name,
        description: o.description,
        body,
        meta: parseMeta(o.meta),
        comment: o.comment,
      });
      await refreshIndex(provider);
      out(created, o.json, () => `Created ${created.id} — ${created.name}`);
    });

  docs
    .command('update <id>')
    .description('Revise an EXISTING doc in place, at its current id (create mints a new id; this does not)')
    .option('--name <text>', 'new title (frontmatter "name") — omit to keep the current one')
    .option('--description <text>', 'new one-line summary — omit to keep the current one')
    .option('-f, --file <path>', 'new markdown body from a file — omit to keep the current one')
    .option('--content <text>', 'new markdown body inline — omit to keep the current one')
    .option(
      '--meta <key=value>',
      'extra frontmatter field to set/overwrite (repeatable) — fields not named here are kept as-is',
      collect,
      [],
    )
    .option('--comment <text>', 'azure wiki commit comment (ignored by the local provider)')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (id: string, o) => {
      const canonical = canonicalizeDocId(id);
      const provider = resolveDocsProvider(process.cwd(), { yes: o.yes });
      const existing = await provider.get(canonical);
      if (!existing) throw new Error(`doc ${canonical} not found — use \`kodi docs create\` for a new one`);
      const body = o.file ? readFileSync(String(o.file), 'utf-8') : (o.content ?? existing.body);
      const updated = await provider.put(canonical, {
        name: o.name ?? existing.name,
        description: o.description ?? existing.description,
        body,
        meta: { ...existing.meta, ...parseMeta(o.meta) },
        comment: o.comment,
      });
      await refreshIndex(provider);
      out(updated, o.json, () => `Updated ${updated.id} — ${updated.name}`);
    });

  docs
    .command('list [type]')
    .description('List doc artifacts (every registered type, or one)')
    .option('--json', 'machine-readable output', false)
    .action(async (type: string | undefined, o) => {
      const cfg = loadBoardConfig();
      const t = type ? requireKnownType(type, cfg.docsTypes ?? DEFAULT_DOC_TYPES) : undefined;
      const refs = await resolveDocsProvider().list(t);
      out(refs, o.json, () =>
        refs.length ? refs.map((r) => `${r.id}  ${r.name} — ${r.description}`).join('\n') : '(no docs)',
      );
    });

  docs
    .command('get <id>')
    .description('Get a doc artifact by id (e.g. PRD-0009)')
    .option('--json', 'machine-readable output', false)
    .action(async (id: string, o) => {
      const canonical = canonicalizeDocId(id);
      const doc = await resolveDocsProvider().get(canonical);
      if (!doc) {
        out({ id: canonical, found: false }, o.json, () => `${canonical} not found`);
        process.exitCode = 1;
        return;
      }
      out(doc, o.json, () => renderDocMarkdown({ frontmatter: doc.meta as DocContent['meta'], body: doc.body }));
    });

  docs
    .command('delete <id>')
    .description('Delete a doc artifact by id')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .action(async (id: string, o) => {
      const canonical = canonicalizeDocId(id);
      const provider = resolveDocsProvider(process.cwd(), { yes: o.yes });
      await provider.delete(canonical);
      await refreshIndex(provider);
      process.stdout.write(`Deleted ${canonical}\n`);
    });

  docs
    .command('reindex')
    .description("Regenerate the docs index/table-of-contents (the wiki's home page, or docs/README.md)")
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .action(async (o) => {
      await resolveDocsProvider(process.cwd(), { yes: o.yes }).updateIndex();
      process.stdout.write('Index regenerated\n');
    });

  docs
    .command('migrate')
    .description('Copy every doc artifact from one docs backend onto another')
    .requiredOption('--to <local|azure-wiki>', 'the backend to migrate INTO')
    .option('--type <type>', 'only migrate one doc type')
    .option(
      '--force',
      're-migrate: overwrite a doc that already exists on the target instead of skipping it',
      false,
    )
    .option('--yes', 'execute (default: dry-run preview)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (o) => {
      const to = o.to as 'local' | 'azure-wiki';
      if (to !== 'local' && to !== 'azure-wiki') {
        throw new Error(`--to must be "local" or "azure-wiki" (got "${o.to}")`);
      }
      // The source is always "the other backend" — NOT necessarily whatever
      // `docsProvider` currently is. Both backends' data exists independently of
      // which one is "active" (that only decides where `docs list`/`create`
      // read/write by default), so `--to azure-wiki` migrates from local even
      // when azure-wiki is already active — the only way to re-push local edits
      // / re-migrate with `--force`. (Simple two-way flip; revisit once a third
      // backend, e.g. github-wiki, exists.)
      const from = to === 'azure-wiki' ? 'local' : 'azure-wiki';
      const root = findProjectRoot();
      const cfg = loadBoardConfig(root);
      const cfgWithTypes = { ...cfg, docsTypes: cfg.docsTypes ?? DEFAULT_DOC_TYPES };
      // the source is only ever read (list/get), which never goes through the
      // dry-run gate — `yes` here is inert, kept only for a symmetric call shape.
      const source: DocsProvider = docsProviderFor(from, cfgWithTypes, root, {});
      const target: DocsProvider = docsProviderFor(to, cfgWithTypes, root, { yes: o.yes });

      // `source.list()` itself can be slow (azure-wiki: one `az` call per doc
      // just to resolve names) with no natural progress increment of its own —
      // say so up front rather than sitting silent before per-doc progress starts.
      process.stderr.write(`Resolving docs from ${from}...\n`);
      const result = await runMigrate(source, target, {
        type: o.type,
        force: o.force,
        apply: o.yes,
        onProgress: reportMigrateProgress,
      });
      const summary = { ...result, from, to };
      out(
        summary,
        o.json,
        () =>
          `migrated ${result.migrated}, skipped ${result.skipped}, failed ${result.failed} (of ${result.total}) — ${from} -> ${to}`,
      );

      if (o.yes && result.failed === 0) {
        writeBoardConfig(root, {
          ...cfgWithTypes,
          docsProvider: to,
          ...(to === 'azure-wiki' ? { docsWiki: cfgWithTypes.docsWiki ?? `${cfgWithTypes.project}.wiki` } : {}),
        });
      }
    });
}
