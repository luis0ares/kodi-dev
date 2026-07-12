import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { stringify as stringifyYaml } from 'yaml';
import { stateFilePath, type BoardConfig } from '../config.js';
import { openDb } from '../memory/db.js';
import { provisionCollection } from '../memory/store.js';
import { DEFAULT_COLUMNS } from '../providers/azure.js';
import {
  getProjectInfo,
  listIssueStates,
  listProjects,
  normalizeOrgUrl,
  processSupportsIssues,
  statesInCategory,
  type IssueState,
  type Runner,
} from '../providers/azure-discovery.js';
import {
  detectRepo,
  hasProjectWriteScope,
  listProjects as listGithubProjects,
  listRepos,
  listStatusField,
  resolveViewerLogin,
} from '../providers/github-discovery.js';
import { readlinePrompter, type Prompter } from '../prompt.js';

const HOOK_COMMAND = 'kodi hook session-start';
const SESSION_MATCHER = 'startup|resume|clear|compact';
const UPS_COMMAND = 'kodi hook user-prompt-submit';

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

/** Idempotently merge the kodi SessionStart hook into a settings.json object. */
export function mergeSessionStartHook(settings: Record<string, any>): boolean {
  settings.hooks ??= {};
  const arr: HookEntry[] = (settings.hooks.SessionStart ??= []);
  const already = arr.some((e) => e.hooks?.some((h) => h.command === HOOK_COMMAND));
  if (already) return false;
  arr.push({ matcher: SESSION_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  return true;
}

/**
 * Idempotently merge the kodi UserPromptSubmit hook, which injects memories relevant
 * to each prompt (pure FTS, no LLM). No matcher — UserPromptSubmit is not a tool event.
 */
export function mergeUserPromptSubmitHook(settings: Record<string, any>): boolean {
  settings.hooks ??= {};
  const arr: HookEntry[] = (settings.hooks.UserPromptSubmit ??= []);
  const already = arr.some((e) => e.hooks?.some((h) => h.command === UPS_COMMAND));
  if (already) return false;
  arr.push({ hooks: [{ type: 'command', command: UPS_COMMAND }] });
  return true;
}

/**
 * The gh/az commands that touch pull requests and board tasks. Each is denied
 * BOTH directly and via the rtk proxy (which rewrites `gh …` → `rtk gh …`), so the
 * proxy can't be used to slip a board/PR mutation past the direct deny.
 */
const BOARD_CLI_COMMANDS = [
  'gh pr', // GitHub pull requests
  'gh issue', // GitHub issues (board tasks)
  'gh project', // GitHub Projects (boards)
  'az repos pr', // Azure DevOps pull requests
  'az boards', // Azure DevOps boards (work items / tasks)
];

/** Deny a command both directly and through the rtk proxy. */
function denyDirectAndRtk(cmd: string): string[] {
  return [`Bash(${cmd}:*)`, `Bash(rtk ${cmd}:*)`];
}

/**
 * Locked-down default permissions written into a new project's settings.json.
 * kodi IS the sanctioned path for the agent: it proxies gh/az with a validated
 * template, so the agent drives the board THROUGH kodi while the raw gh/az board
 * and PR commands are denied (forcing everything through the validating layer).
 * The one kodi command denied is `kodi init` — a one-time human setup step that
 * would clobber this very config if an agent re-ran it. The rtk-proxied form of
 * each rule is denied too, since rtk rewrites bare commands. Reads of the installed
 * agents/skills are allowed. Rules are Bash/Read prefix patterns.
 */
export const PERMISSION_DENY = [
  ...BOARD_CLI_COMMANDS.flatMap(denyDirectAndRtk),
  ...denyDirectAndRtk('kodi init'), // the one-time human setup command, direct and via rtk
];
export const PERMISSION_ALLOW = [
  'Read(.claude/agents/**)', // read the installed agents
  'Read(.claude/skills/**)', // read the installed skills
  // kodi is the sanctioned board proxy — allow all of it. `kodi init` stays in the
  // deny list, and deny rules override allow, so every kodi command runs without a
  // prompt EXCEPT init. The rtk-proxied form is allowed for the same reason.
  'Bash(kodi:*)',
  'Bash(rtk kodi:*)',
];

/**
 * Idempotently merge the default permission rules into a settings object. Existing
 * user rules are preserved; only missing rules are appended, so re-running init
 * never duplicates or clobbers a hand-edited allow/deny list.
 */
export function mergePermissions(settings: Record<string, any>): boolean {
  const perms = (settings.permissions ??= {});
  const deny: string[] = (perms.deny ??= []);
  const allow: string[] = (perms.allow ??= []);
  let changed = false;
  for (const rule of PERMISSION_DENY)
    if (!deny.includes(rule)) {
      deny.push(rule);
      changed = true;
    }
  for (const rule of PERMISSION_ALLOW)
    if (!allow.includes(rule)) {
      allow.push(rule);
      changed = true;
    }
  return changed;
}

/** The packaged assets directory (agents + skills), resolved next to the bundle. */
export function defaultAssetsDir(): string {
  return fileURLToPath(new URL('../assets/', import.meta.url));
}

function copyTree(srcRoot: string, destRoot: string, force: boolean, reportBase: string): string[] {
  const written: string[] = [];
  if (!existsSync(srcRoot)) return written;
  const walk = (src: string, dest: string) => {
    for (const entry of readdirSync(src)) {
      const s = join(src, entry);
      const d = join(dest, entry);
      if (statSync(s).isDirectory()) walk(s, d);
      else {
        if (existsSync(d) && !force) continue;
        mkdirSync(dirname(d), { recursive: true });
        copyFileSync(s, d);
        written.push(join(reportBase, relative(destRoot, d)));
      }
    }
  };
  walk(srcRoot, destRoot);
  return written;
}

/**
 * Copy every `*.md` under `srcRoot` (any depth) into a single flat `destDir`.
 * Agents are organized by phase in the source but installed flat so discovery is
 * independent of project-agent subdirectory scanning. `README.md` files are skipped.
 */
function copyMarkdownFlat(
  srcRoot: string,
  destDir: string,
  force: boolean,
  reportBase: string,
): string[] {
  const written: string[] = [];
  if (!existsSync(srcRoot)) return written;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const s = join(dir, entry);
      if (statSync(s).isDirectory()) walk(s);
      else if (entry.endsWith('.md') && entry !== 'README.md') {
        const d = join(destDir, entry);
        if (existsSync(d) && !force) continue;
        mkdirSync(destDir, { recursive: true });
        copyFileSync(s, d);
        written.push(join(reportBase, entry));
      }
    }
  };
  walk(srcRoot);
  return written;
}

export interface InstallOptions {
  force?: boolean;
  assetsDir?: string;
  /**
   * The configured board provider. `docs/tickets/` is the LOCAL provider's ticket
   * store; a remote board (github/azure) keeps its tickets on the remote, so we do
   * NOT scaffold `docs/tickets/` for those providers. Defaults to `local`.
   */
  provider?: 'local' | 'github' | 'azure';
}

/** Install the kodi harness FILES (hook, agents, skills, docs scaffold). */
export function installHarness(root: string, opts: InstallOptions = {}): string[] {
  const force = opts.force ?? false;
  const assetsDir = opts.assetsDir ?? defaultAssetsDir();
  const claude = join(root, '.claude');
  const changed: string[] = [];

  mkdirSync(claude, { recursive: true });
  const settingsPath = join(claude, 'settings.json');
  const settings: Record<string, any> = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, 'utf-8'))
    : {};
  const hookChanged = mergeSessionStartHook(settings);
  const upsChanged = mergeUserPromptSubmitHook(settings);
  const permsChanged = mergePermissions(settings);
  if (hookChanged || upsChanged || permsChanged) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    const parts = [
      hookChanged ? 'SessionStart hook' : null,
      upsChanged ? 'UserPromptSubmit hook' : null,
      permsChanged ? 'permissions' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    changed.push(`.claude/settings.json (${parts})`);
  }

  changed.push(
    ...copyTree(join(assetsDir, 'skills'), join(claude, 'skills'), force, '.claude/skills'),
    ...copyMarkdownFlat(join(assetsDir, 'agents'), join(claude, 'agents'), force, '.claude/agents'),
    ...copyTree(join(assetsDir, 'rules'), join(claude, 'rules'), force, '.claude/rules'),
  );

  // `tickets` is the LOCAL provider's on-disk ticket store — remote boards
  // (github/azure) keep their tickets on the remote, so it is scaffolded ONLY for
  // the local provider. The rest of the docs scaffold is provider-independent.
  const provider = opts.provider ?? 'local';
  const docsSubs = ['prd', 'adr', 'diagrams', 'plan', 'security'];
  if (provider === 'local') docsSubs.push('tickets');
  for (const sub of docsSubs) {
    mkdirSync(join(root, 'docs', sub), { recursive: true });
  }

  return changed;
}

/** Thrown to abort init with a human message; nothing is written after it. */
export class InitAbort extends Error {}

export interface WizardOptions {
  provider?: 'local' | 'github' | 'azure';
  prefix?: string;
  /** Non-interactive azure values (skip the matching prompt when provided). */
  org?: string;
  project?: string;
  todoColumn?: string;
  inProgressColumn?: string;
  toReviewColumn?: string;
  doneColumn?: string;
  repository?: string;
  /** Non-interactive github values. */
  ownerType?: string;
  projectOwner?: string;
  projectNumber?: number;
  runner?: Runner;
}

/**
 * Interactive board configuration. Returns the config to persist, or throws
 * InitAbort when a required piece is missing (e.g. no To Do column) so the caller
 * can stop init and tell the user what's missing.
 */
export async function configureBoard(
  prompter: Prompter,
  opts: WizardOptions = {},
): Promise<BoardConfig> {
  const provider =
    opts.provider ??
    ((await prompter.select('Which board provider?', ['local', 'github', 'azure'])) as
      'local' | 'github' | 'azure');

  if (provider === 'local') {
    const prefix = opts.prefix ?? (await prompter.input('Ticket key prefix', 'KODI'));
    return { provider: 'local', prefix: prefix || 'KODI' };
  }

  if (provider === 'github') {
    return configureGithub(prompter, opts);
  }

  // Azure DevOps — tickets are always created as Issue work-items.
  const orgInput =
    opts.org ?? (await prompter.input('Azure DevOps organization (name or URL, e.g. acme)'));
  const org = normalizeOrgUrl(orgInput);
  if (!org) throw new InitAbort('missing: organization.');

  let projects: string[];
  try {
    projects = listProjects(org, opts.runner);
  } catch (e) {
    throw new InitAbort(
      `could not list projects for ${org}. Is \`az\` installed and logged in (az login / az devops login)? ${
        e instanceof Error ? e.message : ''
      }`,
    );
  }
  if (projects.length === 0) throw new InitAbort(`no projects found in ${org}.`);

  let project = opts.project;
  if (project) {
    if (!projects.includes(project)) {
      throw new InitAbort(
        `project "${project}" not found in ${org} (found: ${projects.join(', ')}).`,
      );
    }
  } else {
    project = await prompter.select('Select a project', projects);
  }

  // Verify the project is reachable AND its process supports the Issue type.
  const info = getProjectInfo(org, project, opts.runner);
  if (!info) throw new InitAbort(`project "${project}" is not reachable in ${org}.`);
  if (!processSupportsIssues(info.processTemplate)) {
    throw new InitAbort(
      `project "${project}" uses the ${info.processTemplate} process, which has no "Issue" work-item type. ` +
        `kodi creates tickets as Issues — use a Basic-process project (or add the Issue type), then re-run \`kodi init\`.`,
    );
  }

  // Discover the board's Issue states (categorized) so the user picks REAL
  // columns instead of typing them. States fall into meta-categories:
  // Proposed = To Do-type, InProgress = doing/review, Completed = done.
  let states: IssueState[] = [];
  try {
    states = listIssueStates(org, project, opts.runner);
  } catch {
    /* invoke unavailable → fall back to free-text prompts below */
  }
  const proposed = statesInCategory(states, 'Proposed');
  const inProg = statesInCategory(states, 'InProgress');
  const completed = statesInCategory(states, 'Completed');

  // Pick a column: use the flag, else auto (1 candidate), else select, else free-text.
  const pick = async (
    flag: string | undefined,
    message: string,
    candidates: string[],
    def: string,
  ): Promise<string> => {
    if (flag) return flag;
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return prompter.select(message, candidates);
    return (await prompter.input(message, def)) || def;
  };

  // To Do column (where new issues are created) — the explicit selection.
  let todo: string;
  if (opts.todoColumn) {
    todo = opts.todoColumn;
  } else if (states.length > 0 && proposed.length === 0) {
    throw new InitAbort(
      'no To Do-type column: the Issue type on this board has no "Proposed" state where new issues can land. ' +
        'Add a To Do column/state to the board, then re-run `kodi init`.',
    );
  } else if (proposed.length > 0) {
    todo =
      proposed.length === 1
        ? proposed[0]
        : await prompter.select('To Do column (where new issues are created)', proposed);
  } else {
    todo = await prompter.input(
      'To Do column (where new issues are created)',
      DEFAULT_COLUMNS.todo,
    );
    if (!todo) throw new InitAbort('missing: the To Do column.');
  }

  const columns = {
    todo,
    inProgress: await pick(
      opts.inProgressColumn,
      'In Progress column',
      inProg,
      DEFAULT_COLUMNS.inProgress!,
    ),
    toReview: await pick(
      opts.toReviewColumn,
      'To Review column',
      inProg,
      DEFAULT_COLUMNS.toReview!,
    ),
    done: await pick(opts.doneColumn, 'Done column', completed, DEFAULT_COLUMNS.done!),
  };
  const repository =
    opts.repository ??
    ((await prompter.input('Repository name for pull requests', project)) || project);

  return { provider: 'azure', prefix: 'KODI', organization: org, project, repository, columns };
}

/**
 * Interactive GitHub Projects v2 configuration. Issues live in a repo; status is
 * driven by a board's single-select Status field. Discovery proxies `gh`.
 */
async function configureGithub(prompter: Prompter, opts: WizardOptions): Promise<BoardConfig> {
  // Preflight the WRITE scope up front: discovery below only needs read:project,
  // so a read-only token would sail through init and then fail at the first
  // `kodi tickets create` (when the issue is added to the board). Only block when
  // we can positively confirm the `project` scope is absent (null = unknown).
  if (hasProjectWriteScope(opts.runner) === false) {
    throw new InitAbort(
      'your gh token can read Projects but not write to them (has read:project, missing project). ' +
        'Run `gh auth refresh -s project --hostname github.com`, then re-run `kodi init`.',
    );
  }

  // Owner: user-owned defaults to the authenticated login; org-owned is prompted.
  let owner = opts.projectOwner;
  if (!owner) {
    const ownerType =
      opts.ownerType ??
      (await prompter.select('Is the board owned by an organization or a user?', [
        'organization',
        'user',
      ]));
    if (ownerType === 'user') {
      let login = '';
      try {
        login = resolveViewerLogin(opts.runner);
      } catch {
        /* fall through to a prompt */
      }
      owner = (await prompter.input('GitHub user login (board owner)', login)) || login;
    } else {
      owner = await prompter.input('GitHub organization login (board owner)');
    }
  }
  if (!owner) throw new InitAbort('missing: project owner.');

  // First `gh project` call — also the auth/scope preflight. A failure here is
  // usually a missing login or the Projects scope, so say exactly how to fix it.
  let projects;
  try {
    projects = listGithubProjects(owner, opts.runner);
  } catch (e) {
    throw new InitAbort(
      `could not list projects for ${owner}. Is \`gh\` installed and logged in (gh auth login), and does your ` +
        `token have the Projects scope (gh auth refresh -s project --hostname github.com)? ${e instanceof Error ? e.message : ''}`,
    );
  }
  if (projects.length === 0) throw new InitAbort(`no Projects v2 boards found for owner ${owner}.`);

  let number = opts.projectNumber;
  if (number != null) {
    if (!projects.some((p) => p.number === number)) {
      throw new InitAbort(
        `project #${number} not found for ${owner} (found: ${projects.map((p) => `#${p.number} ${p.title}`).join(', ')}).`,
      );
    }
  } else {
    const choice = await prompter.select(
      'Select a project',
      projects.map((p) => `#${p.number} ${p.title}`),
    );
    number = Number(choice.match(/#(\d+)/)![1]);
  }

  const statusField = listStatusField(owner, number, opts.runner);
  if (!statusField) {
    throw new InitAbort(
      `project #${number} has no single-select "Status" field. Add a Status field to the board (every built-in ` +
        `board template has one), then re-run \`kodi init\`.`,
    );
  }
  const options = statusField.options.map((o) => o.name);
  if (options.length === 0)
    throw new InitAbort(`the Status field on project #${number} has no options.`);

  // GitHub Status options carry no meta-categories, so the user picks each bucket
  // from the flat option list (auto-select when there's a single option).
  const pick = async (flag: string | undefined, message: string): Promise<string> => {
    if (flag) return flag;
    return options.length === 1 ? options[0] : prompter.select(message, options);
  };
  const columns = {
    todo: await pick(opts.todoColumn, 'To Do column (where new issues are created)'),
    inProgress: await pick(opts.inProgressColumn, 'In Progress column'),
    toReview: await pick(opts.toReviewColumn, 'To Review column'),
    done: await pick(opts.doneColumn, 'Done column'),
  };

  let repository = opts.repository;
  if (!repository) {
    let detected = '';
    try {
      detected = detectRepo(opts.runner);
    } catch {
      /* not in a gh-recognized repo */
    }
    let repos: string[] = [];
    try {
      repos = listRepos(owner, opts.runner);
    } catch {
      /* fall back to free-text below */
    }
    if (repos.length > 0) {
      // Surface the current repo first so it's the default-highlighted choice.
      if (detected && repos.includes(detected))
        repos = [detected, ...repos.filter((r) => r !== detected)];
      repository = await prompter.select('Repository for issues', repos);
    } else {
      repository =
        (await prompter.input('Repository for issues (owner/repo)', detected)) || detected;
    }
  }
  if (!repository) throw new InitAbort('missing: repository (owner/repo).');

  return {
    provider: 'github',
    prefix: 'KODI',
    repository,
    projectOwner: owner,
    projectNumber: number,
    columns,
  };
}

/** Persist the board config to the project's `.claude/kodi-dev.yaml`. */
export function writeState(root: string, config: BoardConfig): string {
  const path = stateFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(config), 'utf-8');
  return path;
}

export function registerInitCommand(program: Command) {
  program
    .command('init')
    .description('Install the kodi harness and configure the board (interactive)')
    .option('-d, --dir <path>', 'target project directory', process.cwd())
    .option('--force', 'overwrite existing agents/skills', false)
    .option('--provider <local|github|azure>', 'skip the provider prompt')
    .option('--prefix <prefix>', 'local ticket key prefix (default KODI)')
    .option('--org <url>', 'azure org URL (non-interactive)')
    .option('--project <name>', 'azure project (non-interactive)')
    .option('--owner-type <org|user>', 'github board owner type (non-interactive)')
    .option('--project-owner <login>', 'github Projects owner login (org or user)')
    .option('--project-number <n>', 'github Projects board number', (v) => Number(v))
    .option('--todo-column <name>', 'To Do column (non-interactive)')
    .option('--in-progress-column <name>', 'In Progress column')
    .option('--to-review-column <name>', 'To Review column')
    .option('--done-column <name>', 'Done column')
    .option('--repository <name>', 'repository for PRs (azure: name; github: owner/repo)')
    .action(async (o) => {
      const root = String(o.dir);

      // Non-TTY + a remote provider without a way to prompt would hang — guard it.
      let provider = o.provider as 'local' | 'github' | 'azure' | undefined;
      if (!provider && !process.stdin.isTTY) provider = 'local';

      const prompter = readlinePrompter();
      let config: BoardConfig;
      try {
        // Configure the board FIRST so an abort leaves the project untouched.
        config = await configureBoard(prompter, {
          provider,
          prefix: o.prefix,
          org: o.org,
          project: o.project,
          ownerType: o.ownerType,
          projectOwner: o.projectOwner,
          projectNumber: o.projectNumber,
          todoColumn: o.todoColumn,
          inProgressColumn: o.inProgressColumn,
          toReviewColumn: o.toReviewColumn,
          doneColumn: o.doneColumn,
          repository: o.repository,
        });
      } catch (e) {
        if (e instanceof InitAbort) {
          process.stderr.write(`\nkodi init aborted — ${e.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw e;
      } finally {
        prompter.close();
      }

      const changed = installHarness(root, { force: o.force, provider: config.provider });

      // Provision this project's memory collection (best-effort — never block init)
      // and bind it in the state file so `kodi memory` and the SessionStart digest
      // scope to it. Keyed by the ABSOLUTE root so it matches later `findProjectRoot`.
      try {
        const db = openDb();
        const displayName =
          config.project ??
          (config.repository ? basename(config.repository) : basename(resolve(root)));
        config.memory = provisionCollection(db, resolve(root), displayName);
        db.close();
      } catch {
        /* memory is optional; a failure here must not abort init */
      }

      const statePath = writeState(root, config);
      process.stdout.write(
        `\nkodi init: installed\n${changed.map((c) => `  + ${c}`).join('\n')}\n` +
          `  + ${relative(root, statePath)} (provider: ${config.provider})\n\n` +
          `SessionStart wired to \`${HOOK_COMMAND}\` (matchers: ${SESSION_MATCHER}).\n`,
      );
    });
}
