import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execMutate, execRead } from './exec.js';

/** The remote every slice branch is pushed to / looked up on. */
export const DEFAULT_REMOTE = 'origin';

/**
 * The branch every `kodi tickets start` cuts, namespaced so kodi-created
 * branches are easy to spot in `git branch` / a PR's `--source`.
 */
export function sliceBranchName(id: string): string {
  return `slice/kodi-${id}`;
}

/**
 * Every git call kodi makes is anchored with `-C <root>` at the project root —
 * the directory `.claude/kodi-dev.yaml` lives under — so running `kodi` from a
 * subdirectory of a configured project still drives the right repository
 * instead of whatever `process.cwd()` happens to be.
 */
export function gitArgs(root: string, args: string[]): string[] {
  return ['git', '-C', root, ...args];
}

/**
 * Fail early, and with an instruction, when the resolved project root is not
 * inside a git work tree. Without this the first real mutation dies on git's own
 * `fatal: not a git repository (or any of the parent directories): .git`, which
 * names no path and suggests no fix — and a dry-run, which never touches git,
 * prints a clean plan right up until the real run fails. This check runs on BOTH
 * paths so the preview predicts the real thing.
 */
export function assertGitRepo(root: string, read: (args: string[]) => string = execRead): void {
  try {
    read(gitArgs(root, ['rev-parse', '--is-inside-work-tree']));
  } catch {
    throw new Error(
      `${root} is not a git repository.\n` +
        `kodi resolves the repository from the project root — the directory holding ` +
        `.claude/kodi-dev.yaml, searched upward from the current directory. Run kodi from ` +
        `inside the git repository (or move .claude/kodi-dev.yaml into it).`,
    );
  }
}

/**
 * True when a local branch with this name already exists — re-running `start`
 * on a ticket that's already underway reuses it instead of failing on
 * `checkout -b`/`worktree add -b`. Any failure (no such branch, not a repo)
 * reads as "does not exist", matching the blanket-catch convention used
 * elsewhere for read failures.
 */
export function branchExists(
  name: string,
  read: (args: string[]) => string = execRead,
  root?: string,
): boolean {
  const args = ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`];
  try {
    read(root ? gitArgs(root, args) : ['git', ...args]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `remote` already carries this branch — what `gh pr create --head` /
 * `az repos pr create --source-branch` actually require. `undefined` means "could
 * not tell" (no such remote, offline, not a repo): the caller treats that as
 * "don't block", because a false negative here would refuse a perfectly valid PR.
 */
export function remoteBranchExists(
  branch: string,
  root: string,
  read: (args: string[]) => string = execRead,
  remote = DEFAULT_REMOTE,
): boolean | undefined {
  try {
    return read(gitArgs(root, ['ls-remote', '--heads', remote, branch])).trim().length > 0;
  } catch {
    return undefined;
  }
}

/**
 * Publish a slice branch with upstream tracking. Gated by `dryRun` like every
 * other kodi mutation — a push is a remote write, so it only happens with `--yes`.
 */
export function pushSliceBranch(
  branch: string,
  opts: { root: string; dryRun: boolean; remote?: string },
  mutate: typeof execMutate = execMutate,
): void {
  mutate(gitArgs(opts.root, ['push', '-u', opts.remote ?? DEFAULT_REMOTE, branch]), opts.dryRun);
}

export interface StartGitOptions {
  /** Create an isolated worktree instead of checking out the branch in place. */
  worktree: boolean;
  /** Where worktrees are created, relative to `root` (`BoardConfig.worktreesDir`). */
  worktreesDir: string;
  /** Project root — the directory `.claude/kodi-dev.yaml` lives under. */
  root: string;
  /** Preview only (no `--yes`) — mirrors every other `kodi` mutation. */
  dryRun: boolean;
  /**
   * Base a NEW slice branch on this ref instead of the current HEAD
   * (`BoardConfig.sourceBranch`). Ignored when the slice branch already
   * exists — reusing a branch never changes its base.
   */
  sourceBranch?: string;
  /**
   * Also publish the branch with upstream tracking (`git push -u`). Off by
   * default because a push is a remote write; on, it is what makes the branch
   * usable as a PR head right away (`kodi pr create --source`).
   */
  push?: boolean;
  /** Remote a `push` targets (default {@link DEFAULT_REMOTE}). */
  remote?: string;
}

export interface StartGitResult {
  branch: string;
  /** Set only when `worktree: true`. */
  worktreePath?: string;
  /** Whether the branch was pushed (or, in a dry-run, would be). */
  pushed: boolean;
}

export interface StartGitDeps {
  exists?: typeof branchExists;
  mutate?: typeof execMutate;
  pathExists?: typeof existsSync;
  read?: (args: string[]) => string;
}

/**
 * Cut (or reuse) the slice branch for a ticket — either checked out in the
 * current working tree, or as a separate worktree so another slice can build
 * in parallel without disturbing it. Gated by `dryRun` exactly like every
 * other `kodi` mutation: a dry-run only previews the git command that would
 * run, same as `execMutate` everywhere else.
 */
export function startSliceGit(
  id: string,
  opts: StartGitOptions,
  deps: StartGitDeps = {},
): StartGitResult {
  const exists = deps.exists ?? branchExists;
  const mutate = deps.mutate ?? execMutate;
  const pathExists = deps.pathExists ?? existsSync;
  const read = deps.read ?? execRead;
  // Before anything is previewed OR run: prove we are in a repository, so the
  // failure names the directory and the fix instead of git's bare exit 128.
  assertGitRepo(opts.root, read);
  const branch = sliceBranchName(id);
  // Only a brand-new branch has a base to pick — reusing an existing one keeps
  // whatever it already points at, so `sourceBranch` never applies there.
  const newBranchArgs = opts.sourceBranch ? [branch, opts.sourceBranch] : [branch];

  const push = () => {
    if (!opts.push) return false;
    pushSliceBranch(branch, { root: opts.root, dryRun: opts.dryRun, remote: opts.remote }, mutate);
    return true;
  };

  if (!opts.worktree) {
    const already = exists(branch, read, opts.root);
    mutate(
      gitArgs(opts.root, already ? ['checkout', branch] : ['checkout', '-b', ...newBranchArgs]),
      opts.dryRun,
    );
    return { branch, pushed: push() };
  }

  // Flatten the branch's `/` to `-` for the directory name only — the branch
  // itself stays namespaced (`slice/kodi-<id>`), but a worktree dir shaped like
  // the branch would nest one worktree per ticket under a shared `slice/`
  // folder, which is not what a flat --worktree layout wants.
  const worktreePath = join(opts.root, opts.worktreesDir, branch.replace(/\//g, '-'));
  if (pathExists(worktreePath)) return { branch, worktreePath, pushed: push() };
  const already = exists(branch, read, opts.root);
  mutate(
    gitArgs(
      opts.root,
      already
        ? ['worktree', 'add', worktreePath, branch]
        : ['worktree', 'add', worktreePath, '-b', ...newBranchArgs],
    ),
    opts.dryRun,
  );
  return { branch, worktreePath, pushed: push() };
}
