import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { ZodError } from 'zod';
import { loadBoardConfig } from '../config.js';
import { execMutate, execRead } from '../exec.js';
import {
  assertWithinBodyLimit,
  PrSchema,
  renderPrHtml,
  renderPrMarkdown,
  type Pr,
} from '../templates/pr.js';

type Target = 'github' | 'azure';

/** Resolve the PR backend from an explicit flag or the active provider (local has none). */
function resolveTarget(explicit?: string): Target {
  if (explicit === 'github' || explicit === 'azure') return explicit;
  const p = loadBoardConfig().provider;
  if (p === 'github' || p === 'azure') return p;
  throw new Error(
    `no PR target: the active provider is "${p}". Configure github/azure with \`kodi init\`, or pass --provider.`,
  );
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
const TESTING_KEYS = ['unit', 'integration', 'manual', 'na'] as const;

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

export function githubCreateArgs(
  pr: Pr,
  bodyFile: string,
  source: string,
  target: string,
  repo?: string,
  draft = false,
): string[] {
  const args = [
    'gh',
    'pr',
    'create',
    '--title',
    pr.title,
    '--body-file',
    bodyFile,
    '--base',
    target,
    '--head',
    source,
  ];
  // gh's --draft is a plain boolean flag; presence opens the PR as a draft.
  if (draft) args.push('--draft');
  for (const r of pr.reviewers) args.push('--reviewer', r);
  if (repo) args.push('--repo', repo);
  return args;
}

/**
 * Pull Azure work-item IDs out of the free-form "Related Issues / Work Items"
 * entries so `az repos pr create` can actually LINK them (`--work-items`) instead
 * of merely printing them in the description. Accepts a bare id ("123"), a "#123"
 * reference, and Azure's "AB#123" mention form; ignores "N/A" and any non-numeric
 * ref (e.g. a GitHub-style "AUTH-9"). Deduplicated, order-preserving.
 */
export function azureWorkItemIds(relatedIssues: string[]): string[] {
  const ids: string[] = [];
  for (const entry of relatedIssues) {
    const m = /^(?:AB)?#?(\d+)$/i.exec(entry.trim());
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

export function azureCreateArgs(
  pr: Pr,
  html: string,
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
    html,
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

export function githubEditArgs(id: string, pr: Pr, bodyFile: string, repo?: string): string[] {
  const args = ['gh', 'pr', 'edit', id, '--title', pr.title, '--body-file', bodyFile];
  // gh pr edit only adds reviewers (it cannot remove); safe for a body/title edit.
  for (const r of pr.reviewers) args.push('--add-reviewer', r);
  if (repo) args.push('--repo', repo);
  return args;
}

export function azureUpdateArgs(id: string, pr: Pr, html: string): string[] {
  // az repos pr update identifies the PR by --id alone (no --repository needed).
  return ['az', 'repos', 'pr', 'update', '--id', id, '--title', pr.title, '--description', html];
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
      '--vulnerability <ref>',
      'security finding to capture into project memory, referencing its report ' +
        '(repeatable; captured by the hook, not rendered in the PR body)',
      collect,
      [],
    )
    .option(
      '--testing <kind>',
      'Testing checkbox: unit|integration|manual|na (repeatable)',
      collect,
      [],
    )
    .option('--issue <ref>', 'related issue / work item (repeatable)', collect, [])
    .option('--reviewer <name>', 'reviewer (repeatable)', collect, [])
    .option('--notes <text>');
}

export function registerPrCommand(program: Command) {
  const pr = program
    .command('pr')
    .description('Manage pull requests (proxy gh/az) with a validated template');

  addTemplateOptions(pr.command('create'))
    .description('Create a PR from a validated template draft')
    .requiredOption('--source <branch>', 'branch the PR is opened from')
    .option('--target <branch>', 'branch the PR merges into (default: prTarget from kodi init)')
    .option('--provider <github|azure>', 'override the PR provider')
    .option('--repository <repo>', 'repository (gh: OWNER/REPO; az: name)')
    .option('--draft', 'open the PR in draft / work-in-progress (non-active) mode', false)
    .option('--yes', 'execute (default: dry-run)', false)
    .action((o) => {
      const draft = draftFromOptions(o);
      const provider = resolveTarget(o.provider);
      const cfg = loadBoardConfig();
      const repo = o.repository ?? cfg.repository;
      // Fall back to the default target branch chosen at `kodi init` (prTarget).
      const targetBranch = o.target ?? cfg.prTarget;
      if (!targetBranch) {
        throw new Error(
          'no target branch: pass --target, or set a default with `kodi init` (saved as prTarget).',
        );
      }
      // Enforce the 4000-char ceiling on the canonical markdown body before we
      // hand anything to gh/az — refuse rather than let a provider reject/truncate.
      const body = renderPrMarkdown(draft);
      assertWithinBodyLimit(body);
      let args: string[];
      if (provider === 'github') {
        const bodyFile = join(mkdtempSync(join(tmpdir(), 'kodi-pr-')), 'body.md');
        writeFileSync(bodyFile, body, 'utf-8');
        args = githubCreateArgs(draft, bodyFile, o.source, targetBranch, repo, o.draft);
      } else {
        args = azureCreateArgs(draft, renderPrHtml(draft), o.source, targetBranch, repo, o.draft);
      }
      const res = execMutate(args, !o.yes);
      if (res.ran)
        process.stdout.write(
          (res.stdout.trim() || `${o.draft ? 'Draft PR' : 'PR'} created`) + '\n',
        );
    });

  addTemplateOptions(pr.command('edit <id>'))
    .description('Edit an existing PR: re-render its body/title from a validated template draft')
    .option('--provider <github|azure>', 'override the PR provider')
    .option('--repository <repo>', 'repository (gh: OWNER/REPO; az: name)')
    .option('--yes', 'execute (default: dry-run)', false)
    .action((id: string, o: Record<string, unknown>) => {
      const draft = draftFromOptions(o);
      const target = resolveTarget(o.provider as string | undefined);
      const repo = (o.repository as string) ?? loadBoardConfig().repository;
      // Same body contract as create — the full template is re-validated and re-rendered.
      const body = renderPrMarkdown(draft);
      assertWithinBodyLimit(body);
      let args: string[];
      if (target === 'github') {
        const bodyFile = join(mkdtempSync(join(tmpdir(), 'kodi-pr-')), 'body.md');
        writeFileSync(bodyFile, body, 'utf-8');
        args = githubEditArgs(id, draft, bodyFile, repo);
      } else {
        args = azureUpdateArgs(id, draft, renderPrHtml(draft));
      }
      const res = execMutate(args, !o.yes);
      if (res.ran) process.stdout.write((res.stdout.trim() || 'PR updated') + '\n');
    });

  pr.command('list')
    .description('List open pull requests')
    .option('--provider <github|azure>', 'override the PR provider')
    .option('--repository <repo>')
    .action((o) => {
      const target = resolveTarget(o.provider);
      const repo = o.repository ?? loadBoardConfig().repository;
      const args =
        target === 'github'
          ? ['gh', 'pr', 'list', ...(repo ? ['--repo', repo] : [])]
          : ['az', 'repos', 'pr', 'list', ...(repo ? ['--repository', repo] : [])];
      process.stdout.write(execRead(args));
    });

  pr.command('abandon <id>')
    .description('Abandon/close a pull request')
    .option('--provider <github|azure>', 'override the PR provider')
    .option('--repository <repo>')
    .option('--yes', 'execute (default: dry-run)', false)
    .action((id, o) => {
      const target = resolveTarget(o.provider);
      const repo = o.repository ?? loadBoardConfig().repository;
      const args =
        target === 'github'
          ? ['gh', 'pr', 'close', id, ...(repo ? ['--repo', repo] : [])]
          : ['az', 'repos', 'pr', 'update', '--id', id, '--status', 'abandoned'];
      execMutate(args, !o.yes);
    });

  return pr;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
