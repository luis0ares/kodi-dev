import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { ZodError } from 'zod';
import { findProjectRoot, loadBoardConfig } from '../config.js';
import { execMutate, execRead } from '../exec.js';
import { DEFAULT_REMOTE, remoteBranchExists } from '../git.js';
import { azFileArg } from '../tmpfile.js';
import {
  assertWithinBodyLimit,
  PrSchema,
  renderPrHtml,
  renderPrMarkdown,
  type Pr,
} from '../templates/pr.js';

/** Pull requests live on Azure DevOps; the local provider has no remote to open one on. */
export function assertAzure(explicit?: string): void {
  const provider = explicit ?? loadBoardConfig().provider;
  if (provider !== 'azure') {
    throw new Error(
      `no PR target: pull requests need the azure provider, not "${provider}". ` +
        `Configure it with \`kodi init\`, or pass --provider azure.`,
    );
  }
}

/** Fold a repeatable enum flag (e.g. `--type fix --type refactor`) into the
 * boolean object a checkbox group expects, rejecting unknown values. */
function checkboxFlags<K extends string>(
  flag: string,
  keys: readonly K[],
  values: string[],
): Record<K, boolean> {
  const out = Object.fromEntries(keys.map((k) => [k, false])) as Record<K, boolean>;
  for (const v of values) {
    if (!(keys as readonly string[]).includes(v)) {
      throw new Error(`${flag}: unknown value "${v}" (allowed: ${keys.join(', ')})`);
    }
    out[v as K] = true;
  }
  return out;
}

const TYPE_KEYS = ['feature', 'fix', 'improvement', 'refactor', 'documentation'] as const;
const TESTING_KEYS = ['unit', 'integration', 'e2e', 'manual', 'na'] as const;

/** The template is enforced entirely by {@link PrSchema}. Re-throw a Zod failure
 * as a readable, section-by-section message instead of a raw JSON dump. */
function parseDraft(input: unknown): Pr {
  try {
    return PrSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.issues.map((i) => `  - ${i.path.join('.') || '(draft)'}: ${i.message}`);
      throw new Error(
        `PR draft does not satisfy the required template:\n${lines.join('\n')}\n` +
          `Every section except Notes is required.`,
      );
    }
    throw err;
  }
}

function draftFromOptions(o: Record<string, unknown>): Pr {
  if (o.file) return parseDraft(JSON.parse(readFileSync(String(o.file), 'utf-8')));
  return parseDraft({
    title: o.title,
    summary: o.summary,
    typeOfChange: checkboxFlags('--type', TYPE_KEYS, (o.type as string[]) ?? []),
    features: o.feature ?? [],
    fixes: o.fix ?? [],
    improvements: o.improvement ?? [],
    relatedIssues: o.issue ?? [],
    testing: checkboxFlags('--testing', TESTING_KEYS, (o.testing as string[]) ?? []),
    notes: o.notes,
    reviewers: o.reviewer ?? [],
  });
}

/**
 * Refuse a PR whose head branch was never published, with the push command
 * spelled out. `az repos pr create --source-branch` fails on a local-only branch,
 * and its own error describes an unknown ref rather than the one thing that fixes it. `kodi tickets start` cuts the
 * slice branch locally, so this is the normal state right after `start`.
 * A remote we cannot interrogate (offline, no such remote) never blocks.
 */
export function assertSourcePublished(
  source: string,
  root: string,
  read?: (args: string[]) => string,
  remote = DEFAULT_REMOTE,
): void {
  if (remoteBranchExists(source, root, read, remote) !== false) return;
  throw new Error(
    `branch "${source}" does not exist on ${remote} — a PR's head branch must be pushed first.\n` +
      `  git push -u ${remote} ${source}\n` +
      `or cut the branch with \`kodi tickets start <key> --push --yes\`, which publishes it for you.`,
  );
}

/**
 * Pull Azure work-item IDs out of the free-form "Related Issues / Work Items"
 * entries so `az repos pr create` can actually LINK them (`--work-items`) instead
 * of merely printing them in the description. Accepts a bare id ("123"), a "#123"
 * reference, and Azure's "AB#123" mention form; ignores "N/A" and any non-numeric
 * ref (e.g. a prefixed key like "AUTH-9"). Deduplicated, order-preserving.
 */
export function azureWorkItemIds(relatedIssues: string[]): string[] {
  const ids: string[] = [];
  for (const entry of relatedIssues) {
    const m = /^(?:AB)?#?(\d+)$/i.exec(entry.trim());
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/**
 * `descriptionArg` comes from {@link azFileArg}: the inline HTML body everywhere,
 * an `@<file>` reference on Windows only — where a multi-line inline
 * `--description` is truncated at its first newline by az's `.cmd` shim.
 */
export function azureCreateArgs(
  pr: Pr,
  descriptionArg: string,
  source: string,
  target: string,
  repo?: string,
  draft = false,
): string[] {
  const args = [
    'az',
    'repos',
    'pr',
    'create',
    '--title',
    pr.title,
    '--description',
    descriptionArg,
    '--source-branch',
    source,
    '--target-branch',
    target,
  ];
  // az's --draft takes an explicit boolean value.
  if (draft) args.push('--draft', 'true');
  // Link the referenced work items to the PR (the description text alone does NOT
  // create the link Azure shows under "Work Items"). `--work-items` is space-
  // separated; the shell-free spawn passes each id as its own argv entry.
  const workItems = azureWorkItemIds(pr.relatedIssues);
  if (workItems.length) args.push('--work-items', ...workItems);
  if (repo) args.push('--repository', repo);
  return args;
}

/** `descriptionArg` comes from {@link azFileArg} — inline HTML everywhere, an
 * `@<file>` reference on Windows, whose `.cmd` shim truncates a multi-line value. */
export function azureUpdateArgs(id: string, pr: Pr, descriptionArg: string): string[] {
  // az repos pr update identifies the PR by --id alone (no --repository needed).
  return [
    'az',
    'repos',
    'pr',
    'update',
    '--id',
    id,
    '--title',
    pr.title,
    '--description',
    descriptionArg,
  ];
}

/** One pull request, as `pr list` shows it. */
export interface PrListRow {
  id: string;
  title: string;
  /** Head branch — where the change comes from. */
  source: string;
  /** Base branch — what it merges into. Absent from the old listing entirely. */
  target: string;
  state: string;
  updated?: string;
  /** Who opened it, when the provider says. */
  author?: string;
}

/** Azure returns fully-qualified refs (`refs/heads/main`). */
function shortRef(ref: unknown): string {
  return String(ref ?? '').replace(/^refs\/heads\//, '');
}

/** A provider's `--json` listing, narrowed to "an array of objects" and no further —
 * every field is read defensively below, so a shape change degrades rather than throws. */
function jsonRows(json: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(json || '[]');
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
}

/** An optional string field: present and non-empty, or absent. */
function optional(value: unknown): string | undefined {
  return value ? String(value) : undefined;
}

export function azureListArgs(repo?: string): string[] {
  return ['az', 'repos', 'pr', 'list', '--output', 'json', ...(repo ? ['--repository', repo] : [])];
}

export function parseAzurePrList(json: string): PrListRow[] {
  return jsonRows(json).map((r) => ({
    id: String(r.pullRequestId ?? r.codeReviewId ?? ''),
    title: String(r.title ?? ''),
    source: shortRef(r.sourceRefName),
    target: shortRef(r.targetRefName),
    state: String(r.status ?? ''),
    updated: optional(r.creationDate),
    author: optional((r.createdBy as { displayName?: unknown } | null)?.displayName),
  }));
}

/** Aligned one-line-per-PR listing. `source → target` is the point: without the
 * base branch there was no way to confirm a PR's target through kodi at all. */
export function renderPrList(rows: PrListRow[]): string {
  if (!rows.length) return 'No open pull requests.';
  const branches = rows.map((r) => `${r.source} → ${r.target}`);
  const w = (xs: string[]) => Math.max(...xs.map((x) => x.length));
  const idW = w(rows.map((r) => r.id));
  const stateW = w(rows.map((r) => r.state));
  const branchW = w(branches);
  return rows
    .map(
      (r, i) =>
        `${r.id.padEnd(idW)}  ${r.state.padEnd(stateW)}  ${branches[i].padEnd(branchW)}  ${r.title}`,
    )
    .join('\n');
}

/** Attach the shared template-draft options used by both `create` and `edit`,
 * so the two commands always parse an identical draft. */
function addTemplateOptions(cmd: Command): Command {
  return cmd
    .option('-f, --file <path>', 'JSON PR draft (validated against the template)')
    .option('-t, --title <title>')
    .option('-s, --summary <summary>')
    .option(
      '--type <kind>',
      'Type of Change checkbox: feature|fix|improvement|refactor|documentation (repeatable)',
      collect,
      [],
    )
    .option('--feature <text>', 'Included Changes › feature (repeatable)', collect, [])
    .option('--fix <text>', 'Included Changes › fix (repeatable)', collect, [])
    .option('--improvement <text>', 'Included Changes › improvement (repeatable)', collect, [])
    .option(
      '--testing <kind>',
      'Testing checkbox: unit|integration|e2e|manual|na (repeatable)',
      collect,
      [],
    )
    .option(
      '--issue <ref>',
      'related issue / work item (repeatable). 123, #123 and AB#123 link the work item',
      collect,
      [],
    )
    .option('--reviewer <name>', 'reviewer (repeatable)', collect, [])
    .option('--notes <text>');
}

export function registerPrCommand(program: Command) {
  const pr = program
    .command('pr')
    .description('Manage pull requests (proxy az) with a validated template');

  addTemplateOptions(pr.command('create'))
    .description('Create a PR from a validated template draft')
    .requiredOption('--source <branch>', 'branch the PR is opened from')
    .option('--target <branch>', 'branch the PR merges into (default: prTarget from kodi init)')
    .option('--provider <azure>', 'open it on Azure DevOps even when the board is local')
    .option('--repository <repo>', 'repository (name)')
    .option('--draft', 'open the PR in draft / work-in-progress (non-active) mode', false)
    .option('--remote <name>', 'git remote the head branch must exist on', DEFAULT_REMOTE)
    .option('--yes', 'execute (default: dry-run)', false)
    .action((o) => {
      const draft = draftFromOptions(o);
      assertAzure(o.provider);
      const cfg = loadBoardConfig();
      const repo = o.repository ?? cfg.repository;
      // Fall back to the default target branch chosen at `kodi init` (prTarget).
      const targetBranch = o.target ?? cfg.prTarget;
      if (!targetBranch) {
        throw new Error(
          'no target branch: pass --target, or set a default with `kodi init` (saved as prTarget).',
        );
      }
      // The head branch must be ON the remote — checked before anything is
      // rendered or previewed, so a dry-run predicts the real run.
      assertSourcePublished(o.source, findProjectRoot(), undefined, o.remote);
      // Enforce the 4000-char ceiling on the canonical markdown body before we
      // hand anything to az — refuse rather than let the provider reject/truncate.
      assertWithinBodyLimit(renderPrMarkdown(draft));
      // On Windows this becomes an `@file` ref (the `.cmd` shim truncates a
      // multi-line value); everywhere else it stays the inline HTML body.
      const descriptionArg = azFileArg(renderPrHtml(draft), 'kodi-pr-');
      const args = azureCreateArgs(draft, descriptionArg, o.source, targetBranch, repo, o.draft);
      const res = execMutate(args, !o.yes);
      if (res.ran)
        process.stdout.write(
          (res.stdout.trim() || `${o.draft ? 'Draft PR' : 'PR'} created`) + '\n',
        );
    });

  addTemplateOptions(pr.command('edit <id>'))
    .description('Edit an existing PR: re-render its body/title from a validated template draft')
    .option('--provider <azure>', 'edit it on Azure DevOps even when the board is local')
    .option('--yes', 'execute (default: dry-run)', false)
    .action((id: string, o: Record<string, unknown>) => {
      const draft = draftFromOptions(o);
      assertAzure(o.provider as string | undefined);
      // Same body contract as create — the full template is re-validated and re-rendered.
      assertWithinBodyLimit(renderPrMarkdown(draft));
      // On Windows this becomes an `@file` ref (the `.cmd` shim truncates a
      // multi-line value); everywhere else it stays the inline HTML body.
      const args = azureUpdateArgs(id, draft, azFileArg(renderPrHtml(draft), 'kodi-pr-'));
      const res = execMutate(args, !(o.yes as boolean));
      if (res.ran) process.stdout.write((res.stdout.trim() || 'PR updated') + '\n');
    });

  pr.command('list')
    .description('List open pull requests (id, state, source → target, title)')
    .option('--provider <azure>', 'list Azure DevOps PRs even when the board is local')
    .option('--repository <repo>')
    .option('--json', 'machine-readable output', false)
    .action((o) => {
      assertAzure(o.provider);
      const repo = o.repository ?? loadBoardConfig().repository;
      const rows = parseAzurePrList(execRead(azureListArgs(repo)));
      if (o.json) process.stdout.write(JSON.stringify(rows) + '\n');
      else process.stdout.write(renderPrList(rows) + '\n');
    });

  pr.command('abandon <id>')
    .description('Abandon a pull request')
    .option('--provider <azure>', 'abandon it on Azure DevOps even when the board is local')
    .option('--yes', 'execute (default: dry-run)', false)
    .action((id, o) => {
      assertAzure(o.provider);
      execMutate(['az', 'repos', 'pr', 'update', '--id', id, '--status', 'abandoned'], !o.yes);
    });

  return pr;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
