import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { stringify as stringifyYaml } from 'yaml';
import { stateFilePath, type BoardConfig } from '../config.js';
import { DEFAULT_COLUMNS } from '../providers/azure.js';
import {
  getProjectInfo,
  listProjects,
  processSupportsIssues,
  type Runner,
} from '../providers/azure-discovery.js';
import { readlinePrompter, type Prompter } from '../prompt.js';

const HOOK_COMMAND = 'kodi hook session-start';
const SESSION_MATCHER = 'startup|resume|clear|compact';

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
function copyMarkdownFlat(srcRoot: string, destDir: string, force: boolean, reportBase: string): string[] {
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
  if (mergeSessionStartHook(settings)) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    changed.push('.claude/settings.json (SessionStart hook)');
  }

  changed.push(
    ...copyTree(join(assetsDir, 'skills'), join(claude, 'skills'), force, '.claude/skills'),
    ...copyMarkdownFlat(join(assetsDir, 'agents'), join(claude, 'agents'), force, '.claude/agents'),
  );

  for (const sub of ['prd', 'adr', 'diagrams', 'plan', 'tickets', 'security']) {
    mkdirSync(join(root, 'docs', sub), { recursive: true });
  }

  return changed;
}

/** Thrown to abort init with a human message; nothing is written after it. */
export class InitAbort extends Error {}

export interface WizardOptions {
  provider?: 'local' | 'azure';
  prefix?: string;
  /** Non-interactive azure values (skip the matching prompt when provided). */
  org?: string;
  project?: string;
  todoColumn?: string;
  inProgressColumn?: string;
  toReviewColumn?: string;
  doneColumn?: string;
  repository?: string;
  runner?: Runner;
}

/**
 * Interactive board configuration. Returns the config to persist, or throws
 * InitAbort when a required piece is missing (e.g. no To Do column) so the caller
 * can stop init and tell the user what's missing.
 */
export async function configureBoard(prompter: Prompter, opts: WizardOptions = {}): Promise<BoardConfig> {
  const provider =
    opts.provider ?? ((await prompter.select('Which board provider?', ['local', 'azure'])) as 'local' | 'azure');

  if (provider === 'local') {
    const prefix = opts.prefix ?? (await prompter.input('Ticket key prefix', 'KODI'));
    return { provider: 'local', prefix: prefix || 'KODI' };
  }

  // Azure DevOps — tickets are always created as Issue work-items.
  const org = opts.org ?? (await prompter.input('Azure DevOps organization URL (https://dev.azure.com/<org>)'));
  if (!org) throw new InitAbort('missing: organization URL.');

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
      throw new InitAbort(`project "${project}" not found in ${org} (found: ${projects.join(', ')}).`);
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

  const todo =
    opts.todoColumn ??
    (await prompter.input('To Do column (where new issues are created)', DEFAULT_COLUMNS.todo));
  if (!todo) {
    throw new InitAbort(
      'missing: the To Do column. Configure a To Do column on the project board that accepts new Issues, then re-run `kodi init`.',
    );
  }
  const columns = {
    todo,
    inProgress:
      opts.inProgressColumn ??
      ((await prompter.input('In Progress column', DEFAULT_COLUMNS.inProgress)) || DEFAULT_COLUMNS.inProgress),
    toReview:
      opts.toReviewColumn ??
      ((await prompter.input('To Review column', DEFAULT_COLUMNS.toReview)) || DEFAULT_COLUMNS.toReview),
    done: opts.doneColumn ?? ((await prompter.input('Done column', DEFAULT_COLUMNS.done)) || DEFAULT_COLUMNS.done),
  };
  const repository =
    opts.repository ?? ((await prompter.input('Repository name for pull requests', project)) || project);

  return { provider: 'azure', prefix: 'KODI', organization: org, project, repository, columns };
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
    .option('--provider <local|azure>', 'skip the provider prompt')
    .option('--prefix <prefix>', 'local ticket key prefix (default KODI)')
    .option('--org <url>', 'azure org URL (non-interactive)')
    .option('--project <name>', 'azure project (non-interactive)')
    .option('--todo-column <name>', 'azure To Do column (non-interactive)')
    .option('--in-progress-column <name>', 'azure In Progress column')
    .option('--to-review-column <name>', 'azure To Review column')
    .option('--done-column <name>', 'azure Done column')
    .option('--repository <name>', 'azure repository for PRs')
    .action(async (o) => {
      const root = String(o.dir);

      // Non-TTY + azure without a way to prompt would hang — guard it.
      let provider = o.provider as 'local' | 'azure' | undefined;
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

      const changed = installHarness(root, { force: o.force });
      const statePath = writeState(root, config);
      process.stdout.write(
        `\nkodi init: installed\n${changed.map((c) => `  + ${c}`).join('\n')}\n` +
          `  + ${relative(root, statePath)} (provider: ${config.provider})\n\n` +
          `SessionStart wired to \`${HOOK_COMMAND}\` (matchers: ${SESSION_MATCHER}).\n`,
      );
    });
}
