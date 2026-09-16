import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { ZodError } from 'zod';
import { findProjectRoot, loadBoardConfig } from '../config.js';
import { execMutate, execRead, type ExecResult } from '../exec.js';
import { baseBranchLinkWarning, defaultBranch, explainGhFailure } from '../gh.js';
import { DEFAULT_REMOTE, remoteBranchExists } from '../git.js';
import { azFileArg, writeTempFile } from '../tmpfile.js';
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
const TESTING_KEYS = ['unit', 'integration', 'e2e', 'manual', 'na'] as const;

/**
 * The closing keyword `--issue` refs are rendered with. `none` opts out entirely
 * and passes every entry through exactly as typed.
 */
export const ISSUE_KEYWORDS = ['closes', 'fixes', 'resolves', 'none'] as const;
export type IssueKeyword = (typeof ISSUE_KEYWORDS)[number];

/** An entry that ALREADY opens with a closing keyword — never rewritten. */
const CLOSING_PREFIX_RE = /^(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+\S/i;
/** `3` / `#3` — a bare GitHub issue number, with or without the sigil. */
const BARE_REF_RE = /^#?(\d+)$/;
/** `KODI-3` / `KODI-003` — a kodi-shaped key; on GitHub the number IS the issue. */
const PREFIXED_REF_RE = /^[A-Za-z][A-Za-z0-9]*-0*(\d+)$/;
/** The template's "this PR references nothing" placeholder. */
const NA_RE = /^n\/?a$/i;

/**
 * Turn a Related-Issues entry into something GitHub will actually act on.
 *
 * "Related Issues / Work Items" is the one section rendered WITHOUT autolink
 * neutralization — i.e. the section deliberately built to hold a real reference —
 * but nothing used to validate or complete what was passed. `--issue 3` rendered
 * the literal text `3`: no link, no cross-reference, no closing behaviour, and no
 * warning. A human reading the PR saw it correctly attributed while GitHub had
 * nothing.
 *
 * So a recognizable reference (`3`, `#3`, `KODI-3`) becomes `Closes #3`. Anything
 * else — a URL, free text, `N/A`, or an entry that already starts with its own
 * closing keyword — is left exactly as typed.
 */
export function normalizeRelatedIssue(entry: string, keyword: IssueKeyword = 'closes'): string {
  const text = entry.trim();
  if (keyword === 'none' || NA_RE.test(text) || CLOSING_PREFIX_RE.test(text)) return text;
  const m = BARE_REF_RE.exec(text) ?? PREFIXED_REF_RE.exec(text);
  if (!m) return text;
  return `${keyword[0].toUpperCase()}${keyword.slice(1)} #${m[1]}`;
}

/**
 * Apply {@link normalizeRelatedIssue} across the section — GitHub only. Azure
 * gets its links from `az repos pr create --work-items` (see
 * {@link azureWorkItemIds}), which parses the raw refs and would not recognize a
 * keyword-prefixed entry, so Azure entries are passed through untouched.
 */
export function normalizeRelatedIssues(
  entries: string[],
  target: Target,
  keyword: IssueKeyword = 'closes',
): string[] {
  if (target !== 'github') return entries;
  return entries.map((e) => normalizeRelatedIssue(e, keyword));
}

function parseIssueKeyword(value: unknown): IssueKeyword {
  const v = String(value ?? 'closes').toLowerCase();
  if (!(ISSUE_KEYWORDS as readonly string[]).includes(v)) {
    throw new Error(
      `--issue-keyword: unknown value "${value}" (allowed: ${ISSUE_KEYWORDS.join(', ')})`,
    );
  }
  return v as IssueKeyword;
}

/** Whether any entry would rely on GitHub's closing-keyword behaviour. */
export function hasClosingKeyword(entries: string[]): boolean {
  return entries.some((e) => CLOSING_PREFIX_RE.test(e.trim()));
}

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
 * spelled out. `gh pr create --head` / `az repos pr create --source-branch`
 * both fail on a local-only branch, and their own errors describe an unknown
 * ref rather than the one thing that fixes it. `kodi tickets start` cuts the
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

export function githubEditArgs(id: string, pr: Pr, bodyFile: string, repo?: string): string[] {
  const args = ['gh', 'pr', 'edit', id, '--title', pr.title, '--body-file', bodyFile];
  // gh pr edit only adds reviewers (it cannot remove); safe for a body/title edit.
  for (const r of pr.reviewers) args.push('--add-reviewer', r);
  if (repo) args.push('--repo', repo);
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

/**
 * Run a gh/az mutation, translating a failure that came out of `gh` itself
 * (rather than out of GitHub's answer) into an explanation with a fix — see
 * {@link explainGhFailure}. Anything unrecognized propagates untouched.
 */
function runPrMutation(args: string[], dryRun: boolean, bodyFile?: string): ExecResult {
  try {
    return execMutate(args, dryRun);
  } catch (err) {
    throw explainGhFailure(err, { bodyFile });
  }
}

/** One pull request, normalized across providers for `pr list`. */
export interface PrListRow {
  id: string;
  title: string;
  /** Head branch — where the change comes from. */
  source: string;
  /** Base branch — what it merges into. Absent from the old listing entirely. */
  target: string;
  state: string;
  updated?: string;
}

/** Azure returns fully-qualified refs (`refs/heads/main`); GitHub returns names. */
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

export function githubListArgs(repo?: string): string[] {
  return [
    'gh',
    'pr',
    'list',
    '--json',
    'number,title,headRefName,baseRefName,state,updatedAt',
    ...(repo ? ['--repo', repo] : []),
  ];
}

export function parseGithubPrList(json: string): PrListRow[] {
  return jsonRows(json).map((r) => ({
    id: String(r.number ?? ''),
    title: String(r.title ?? ''),
    source: shortRef(r.headRefName),
    target: shortRef(r.baseRefName),
    state: String(r.state ?? ''),
    updated: optional(r.updatedAt),
  }));
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
      'related issue / work item (repeatable). On github a bare ref (3, #3, KODI-3) ' +
        'is rendered as a closing keyword ("Closes #3") so GitHub actually links it',
      collect,
      [],
    )
    .option(
      '--issue-keyword <word>',
      `closing keyword --issue refs are rendered with: ${ISSUE_KEYWORDS.join('|')} (github only)`,
      'closes',
    )
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
    .option('--remote <name>', 'git remote the head branch must exist on', DEFAULT_REMOTE)
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
      // The head branch must be ON the remote — checked before anything is
      // rendered or previewed, so a dry-run predicts the real run.
      assertSourcePublished(o.source, findProjectRoot(), undefined, o.remote);
      draft.relatedIssues = normalizeRelatedIssues(
        draft.relatedIssues,
        provider,
        parseIssueKeyword(o.issueKeyword),
      );
      // Enforce the 4000-char ceiling on the canonical markdown body before we
      // hand anything to gh/az — refuse rather than let a provider reject/truncate.
      const body = renderPrMarkdown(draft);
      assertWithinBodyLimit(body);
      let args: string[];
      let bodyFile: string | undefined;
      if (provider === 'github') {
        // Closing keywords only link on a default-branch base — say so up front
        // rather than let the Development panel silently stay empty.
        if (hasClosingKeyword(draft.relatedIssues)) {
          const warning = baseBranchLinkWarning(targetBranch, defaultBranch(repo));
          if (warning) process.stderr.write(warning);
        }
        bodyFile = writeTempFile(body, 'kodi-pr-', 'body.md');
        args = githubCreateArgs(draft, bodyFile, o.source, targetBranch, repo, o.draft);
      } else {
        // On Windows this becomes an `@file` ref (the `.cmd` shim truncates a
        // multi-line value); everywhere else it stays the inline HTML body.
        const descriptionArg = azFileArg(renderPrHtml(draft), 'kodi-pr-');
        args = azureCreateArgs(draft, descriptionArg, o.source, targetBranch, repo, o.draft);
      }
      const res = runPrMutation(args, !o.yes, bodyFile);
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
      draft.relatedIssues = normalizeRelatedIssues(
        draft.relatedIssues,
        target,
        parseIssueKeyword(o.issueKeyword),
      );
      // Same body contract as create — the full template is re-validated and re-rendered.
      const body = renderPrMarkdown(draft);
      assertWithinBodyLimit(body);
      let args: string[];
      let bodyFile: string | undefined;
      if (target === 'github') {
        bodyFile = writeTempFile(body, 'kodi-pr-', 'body.md');
        args = githubEditArgs(id, draft, bodyFile, repo);
      } else {
        // On Windows this becomes an `@file` ref (the `.cmd` shim truncates a
        // multi-line value); everywhere else it stays the inline HTML body.
        args = azureUpdateArgs(id, draft, azFileArg(renderPrHtml(draft), 'kodi-pr-'));
      }
      const res = runPrMutation(args, !(o.yes as boolean), bodyFile);
      if (res.ran) process.stdout.write((res.stdout.trim() || 'PR updated') + '\n');
    });

  pr.command('list')
    .description('List open pull requests (id, state, source → target, title)')
    .option('--provider <github|azure>', 'override the PR provider')
    .option('--repository <repo>')
    .option('--json', 'machine-readable output', false)
    .action((o) => {
      const target = resolveTarget(o.provider);
      const repo = o.repository ?? loadBoardConfig().repository;
      const rows =
        target === 'github'
          ? parseGithubPrList(execRead(githubListArgs(repo)))
          : parseAzurePrList(execRead(azureListArgs(repo)));
      if (o.json) process.stdout.write(JSON.stringify(rows) + '\n');
      else process.stdout.write(renderPrList(rows) + '\n');
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
      runPrMutation(args, !o.yes);
    });

  return pr;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
