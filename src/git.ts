import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execMutate, execRead } from './exec.js';

/**
 * The branch every `kodi tickets start` cuts, namespaced so kodi-created
 * branches are easy to spot in `git branch` / a PR's `--source`.
 */
export function sliceBranchName(id: string): string {
  return `slice/kodi-${id}`;
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
): boolean {
  try {
    read(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
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
}

export interface StartGitResult {
  branch: string;
  /** Set only when `worktree: true`. */
  worktreePath?: string;
}

export interface StartGitDeps {
  exists?: typeof branchExists;
  mutate?: typeof execMutate;
  pathExists?: typeof existsSync;
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
  const branch = sliceBranchName(id);
  // Only a brand-new branch has a base to pick — reusing an existing one keeps
  // whatever it already points at, so `sourceBranch` never applies there.
  const newBranchArgs = opts.sourceBranch ? [branch, opts.sourceBranch] : [branch];

  if (!opts.worktree) {
    const already = exists(branch);
    mutate(
      already ? ['git', 'checkout', branch] : ['git', 'checkout', '-b', ...newBranchArgs],
      opts.dryRun,
    );
    return { branch };
  }

  // Flatten the branch's `/` to `-` for the directory name only — the branch
  // itself stays namespaced (`slice/kodi-<id>`), but a worktree dir shaped like
  // the branch would nest one worktree per ticket under a shared `slice/`
  // folder, which is not what a flat --worktree layout wants.
  const worktreePath = join(opts.root, opts.worktreesDir, branch.replace(/\//g, '-'));
  if (pathExists(worktreePath)) return { branch, worktreePath };
  const already = exists(branch);
  mutate(
    already
      ? ['git', 'worktree', 'add', worktreePath, branch]
      : ['git', 'worktree', 'add', worktreePath, '-b', ...newBranchArgs],
    opts.dryRun,
  );
  return { branch, worktreePath };
}
