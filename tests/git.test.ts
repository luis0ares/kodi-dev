import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertAutopilotSlug,
  assertGitRepo,
  branchExists,
  gitArgs,
  remoteBranchExists,
  sliceBranchName,
  startAutopilotGit,
  startSliceGit,
  type StartGitDeps,
} from '../src/git.js';

/** Every startSliceGit call now preflights `assertGitRepo` through `read`; the
 * default stub answers "yes, a repo" so each test asserts only what it is about. */
function deps(over: StartGitDeps = {}): StartGitDeps {
  return { read: () => 'true', ...over };
}

describe('sliceBranchName', () => {
  it('namespaces the ticket id under slice/kodi-', () => {
    expect(sliceBranchName('KODI-003')).toBe('slice/kodi-KODI-003');
    expect(sliceBranchName('123')).toBe('slice/kodi-123');
  });
});

describe('gitArgs', () => {
  it('anchors every git call at the project root, so a subdirectory still drives the repo', () => {
    expect(gitArgs('/repo', ['checkout', '-b', 'x'])).toEqual([
      'git',
      '-C',
      '/repo',
      'checkout',
      '-b',
      'x',
    ]);
  });
});

describe('assertGitRepo', () => {
  it('passes when the root is inside a work tree', () => {
    expect(() => assertGitRepo('/repo', () => 'true')).not.toThrow();
  });

  it("names the directory and the fix instead of leaking git's bare exit 128", () => {
    const boom = () => {
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    };
    expect(() => assertGitRepo('/workspace', boom)).toThrow(/\/workspace is not a git repository/);
    expect(() => assertGitRepo('/workspace', boom)).toThrow(/Run kodi from inside the git repo/);
  });
});

describe('branchExists', () => {
  it('is true when the read succeeds', () => {
    expect(branchExists('slice/kodi-1', () => '')).toBe(true);
  });

  it('is false when the read throws (no such branch, or not a repo)', () => {
    expect(
      branchExists('slice/kodi-1', () => {
        throw new Error('not found');
      }),
    ).toBe(false);
  });

  it('anchors the lookup at the root when one is given', () => {
    const read = vi.fn(() => '');
    branchExists('slice/kodi-1', read, '/repo');
    expect(read).toHaveBeenCalledWith([
      'git',
      '-C',
      '/repo',
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/slice/kodi-1',
    ]);
  });
});

describe('remoteBranchExists', () => {
  it('is true when ls-remote returns a ref', () => {
    expect(
      remoteBranchExists('slice/kodi-2', '/repo', () => 'abc123\trefs/heads/slice/kodi-2\n'),
    ).toBe(true);
  });

  it('is false when ls-remote returns nothing', () => {
    expect(remoteBranchExists('slice/kodi-2', '/repo', () => '\n')).toBe(false);
  });

  it('is undefined — never false — when the remote cannot be interrogated', () => {
    expect(
      remoteBranchExists('slice/kodi-2', '/repo', () => {
        throw new Error('could not read from remote repository');
      }),
    ).toBeUndefined();
  });
});

describe('startSliceGit', () => {
  it('refuses before previewing anything when the root is not a repository', () => {
    const mutate = vi.fn();
    expect(() =>
      startSliceGit(
        'KODI-003',
        { worktree: false, worktreesDir: '.claude/worktrees', root: '/workspace', dryRun: true },
        deps({
          exists: () => false,
          mutate,
          read: () => {
            throw new Error('fatal: not a git repository');
          },
        }),
      ),
    ).toThrow(/not a git repository/);
    // The dry run must PREDICT the real run — nothing is previewed either.
    expect(mutate).not.toHaveBeenCalled();
  });

  it('checks out a new branch when it does not exist yet', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: false, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      deps({ exists: () => false, mutate }),
    );

    expect(result).toEqual({ branch: 'slice/kodi-KODI-003', pushed: false });
    expect(mutate).toHaveBeenCalledWith(
      ['git', '-C', '/repo', 'checkout', '-b', 'slice/kodi-KODI-003'],
      false,
    );
  });

  it('reuses (checks out) an existing branch instead of failing on -b', () => {
    const mutate = vi.fn();
    startSliceGit(
      'KODI-003',
      { worktree: false, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      deps({ exists: () => true, mutate }),
    );

    expect(mutate).toHaveBeenCalledWith(
      ['git', '-C', '/repo', 'checkout', 'slice/kodi-KODI-003'],
      false,
    );
  });

  it('bases a new branch on sourceBranch when configured', () => {
    const mutate = vi.fn();
    startSliceGit(
      'KODI-003',
      {
        worktree: false,
        worktreesDir: '.claude/worktrees',
        root: '/repo',
        dryRun: false,
        sourceBranch: 'develop',
      },
      deps({ exists: () => false, mutate }),
    );

    expect(mutate).toHaveBeenCalledWith(
      ['git', '-C', '/repo', 'checkout', '-b', 'slice/kodi-KODI-003', 'develop'],
      false,
    );
  });

  it('ignores sourceBranch when the branch already exists (reuse keeps its own base)', () => {
    const mutate = vi.fn();
    startSliceGit(
      'KODI-003',
      {
        worktree: false,
        worktreesDir: '.claude/worktrees',
        root: '/repo',
        dryRun: false,
        sourceBranch: 'develop',
      },
      deps({ exists: () => true, mutate }),
    );

    expect(mutate).toHaveBeenCalledWith(
      ['git', '-C', '/repo', 'checkout', 'slice/kodi-KODI-003'],
      false,
    );
  });

  it('previews only (no mutation semantics change) on a dry-run', () => {
    const mutate = vi.fn();
    startSliceGit(
      'KODI-003',
      { worktree: false, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: true },
      deps({ exists: () => false, mutate }),
    );

    expect(mutate).toHaveBeenCalledWith(
      ['git', '-C', '/repo', 'checkout', '-b', 'slice/kodi-KODI-003'],
      true,
    );
  });

  it('does not push by default — the branch stays local until asked', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: false, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      deps({ exists: () => false, mutate }),
    );

    expect(result.pushed).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('publishes the branch with upstream tracking on --push', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      {
        worktree: false,
        worktreesDir: '.claude/worktrees',
        root: '/repo',
        dryRun: false,
        push: true,
      },
      deps({ exists: () => false, mutate }),
    );

    expect(result.pushed).toBe(true);
    expect(mutate).toHaveBeenLastCalledWith(
      ['git', '-C', '/repo', 'push', '-u', 'origin', 'slice/kodi-KODI-003'],
      false,
    );
  });

  it('pushes to a custom remote, and honours dry-run like any other mutation', () => {
    const mutate = vi.fn();
    startSliceGit(
      'KODI-003',
      {
        worktree: false,
        worktreesDir: '.claude/worktrees',
        root: '/repo',
        dryRun: true,
        push: true,
        remote: 'upstream',
      },
      deps({ exists: () => false, mutate }),
    );

    expect(mutate).toHaveBeenLastCalledWith(
      ['git', '-C', '/repo', 'push', '-u', 'upstream', 'slice/kodi-KODI-003'],
      true,
    );
  });

  it('pushes a reused worktree branch too, even though nothing was created', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      {
        worktree: true,
        worktreesDir: '.claude/worktrees',
        root: '/repo',
        dryRun: false,
        push: true,
      },
      deps({ exists: () => true, mutate, pathExists: () => true }),
    );

    expect(result.pushed).toBe(true);
    expect(mutate).toHaveBeenCalledWith(
      ['git', '-C', '/repo', 'push', '-u', 'origin', 'slice/kodi-KODI-003'],
      false,
    );
  });

  it('creates a worktree at <root>/<worktreesDir>/<branch> when it does not exist', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      deps({ exists: () => false, mutate, pathExists: () => false }),
    );

    const expectedPath = '/repo/.claude/worktrees/slice-kodi-KODI-003';
    expect(result).toEqual({
      branch: 'slice/kodi-KODI-003',
      worktreePath: expectedPath,
      pushed: false,
    });
    expect(mutate).toHaveBeenCalledWith(
      ['git', '-C', '/repo', 'worktree', 'add', expectedPath, '-b', 'slice/kodi-KODI-003'],
      false,
    );
  });

  it('bases a new worktree branch on sourceBranch when configured', () => {
    const mutate = vi.fn();
    const expectedPath = '/repo/.claude/worktrees/slice-kodi-KODI-003';
    startSliceGit(
      'KODI-003',
      {
        worktree: true,
        worktreesDir: '.claude/worktrees',
        root: '/repo',
        dryRun: false,
        sourceBranch: 'develop',
      },
      deps({ exists: () => false, mutate, pathExists: () => false }),
    );

    expect(mutate).toHaveBeenCalledWith(
      [
        'git',
        '-C',
        '/repo',
        'worktree',
        'add',
        expectedPath,
        '-b',
        'slice/kodi-KODI-003',
        'develop',
      ],
      false,
    );
  });

  it('flattens the branch slash in the worktree dir name, so every slice does not nest under one shared "slice" folder', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      deps({ exists: () => false, mutate, pathExists: () => false }),
    );

    expect(result.worktreePath).toBe('/repo/.claude/worktrees/slice-kodi-KODI-003');
    expect(result.branch).toBe('slice/kodi-KODI-003'); // the branch itself stays namespaced
  });

  it('adds a worktree from an existing branch without -b', () => {
    const mutate = vi.fn();
    startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      deps({ exists: () => true, mutate, pathExists: () => false }),
    );

    const expectedPath = '/repo/.claude/worktrees/slice-kodi-KODI-003';
    expect(mutate).toHaveBeenCalledWith(
      ['git', '-C', '/repo', 'worktree', 'add', expectedPath, 'slice/kodi-KODI-003'],
      false,
    );
  });

  it('is idempotent — skips entirely when the worktree path already exists', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      deps({ exists: () => false, mutate, pathExists: () => true }),
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(result).toEqual({
      branch: 'slice/kodi-KODI-003',
      worktreePath: '/repo/.claude/worktrees/slice-kodi-KODI-003',
      pushed: false,
    });
  });

  it('respects a custom worktreesDir', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: 'tmp/wt', root: '/repo', dryRun: false },
      deps({ exists: () => false, mutate, pathExists: () => false }),
    );

    expect(result.worktreePath).toBe('/repo/tmp/wt/slice-kodi-KODI-003');
  });
});

describe('assertAutopilotSlug', () => {
  it('accepts lowercase kebab-case', () => {
    expect(() => assertAutopilotSlug('proposal-links', [])).not.toThrow();
    expect(() => assertAutopilotSlug('b2b', [])).not.toThrow();
  });

  it.each(['slice/kodi-1', 'Proposal-Links', 'trailing-', '-leading', 'two--dashes', 'a b', ''])(
    'refuses %j, which could not name a branch, a directory and a report',
    (slug) => {
      expect(() => assertAutopilotSlug(slug, [])).toThrow(/not a slug/);
    },
  );

  it('refuses an integration branch, however the ref was spelled', () => {
    expect(() => assertAutopilotSlug('develop', ['develop'])).toThrow(/integration branch/);
    expect(() => assertAutopilotSlug('develop', ['origin/develop'])).toThrow(/integration branch/);
    expect(() => assertAutopilotSlug('develop', [undefined, 'main'])).not.toThrow();
  });
});

describe('startAutopilotGit', () => {
  const opts = { worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false };

  it('cuts the worktree on the slug from the base, never a slice/kodi-<id> branch', () => {
    const mutate = vi.fn();
    const res = startAutopilotGit(
      'proposal-links',
      { ...opts, sourceBranch: 'origin/develop' },
      {
        read: (args) => (args.includes('ls-remote') ? '' : 'true'),
        exists: () => false,
        pathExists: () => false,
        mutate,
      },
    );
    expect(res).toEqual({
      branch: 'proposal-links',
      worktreePath: join('/repo', '.claude/worktrees', 'proposal-links'),
      pushed: false,
    });
    expect(mutate).toHaveBeenCalledWith(
      gitArgs('/repo', [
        'worktree',
        'add',
        join('/repo', '.claude/worktrees', 'proposal-links'),
        '-b',
        'proposal-links',
        'origin/develop',
      ]),
      false,
    );
  });

  it('reuses the worktree for a later ticket of the same run', () => {
    const mutate = vi.fn();
    const res = startAutopilotGit('proposal-links', opts, {
      read: () => 'proposal-links\n',
      pathExists: () => true,
      mutate,
    });
    expect(res.branch).toBe('proposal-links');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses a directory holding another branch rather than building on it', () => {
    expect(() =>
      startAutopilotGit('proposal-links', opts, {
        read: () => 'someone-else\n',
        pathExists: () => true,
      }),
    ).toThrow(/is on "someone-else"/);
  });

  it('refuses a slug already on the remote, which its force-push would overwrite', () => {
    const mutate = vi.fn();
    expect(() =>
      startAutopilotGit('proposal-links', opts, {
        read: (args) =>
          args.includes('ls-remote') ? 'abc123\trefs/heads/proposal-links\n' : 'true',
        exists: () => false,
        pathExists: () => false,
        mutate,
      }),
    ).toThrow(/already exists on origin/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('re-attaches a local branch whose worktree was removed, keeping its commits', () => {
    const mutate = vi.fn();
    startAutopilotGit('proposal-links', opts, {
      read: () => 'true',
      exists: () => true,
      pathExists: () => false,
      mutate,
    });
    expect(mutate).toHaveBeenCalledWith(
      gitArgs('/repo', [
        'worktree',
        'add',
        join('/repo', '.claude/worktrees', 'proposal-links'),
        'proposal-links',
      ]),
      false,
    );
  });

  it('makes no git change in a dry run', () => {
    const mutate = vi.fn();
    startAutopilotGit(
      'proposal-links',
      { ...opts, dryRun: true },
      {
        read: (args) => (args.includes('ls-remote') ? '' : 'true'),
        exists: () => false,
        pathExists: () => false,
        mutate,
      },
    );
    expect(mutate).toHaveBeenCalledWith(expect.any(Array), true);
  });

  describe('against real git', () => {
    let dir: string;
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'kodi-autopilot-'));
      const remote = join(dir, 'origin.git');
      execFileSync('git', ['init', '--quiet', '--bare', remote]);
      execFileSync('git', ['clone', '--quiet', remote, join(dir, 'main')], { stdio: 'pipe' });
      const main = join(dir, 'main');
      git(main, 'config', 'user.email', 'test@example.com');
      git(main, 'config', 'user.name', 'test');
      git(main, 'checkout', '--quiet', '-b', 'develop');
      writeFileSync(join(main, 'base.txt'), 'base\n');
      git(main, 'add', '.');
      git(main, 'commit', '--quiet', '-m', 'base');
      git(main, 'push', '--quiet', '-u', 'origin', 'develop');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('serves a whole run from one command: first ticket cuts, later tickets reuse', () => {
      const root = join(dir, 'main');
      const run = {
        worktreesDir: '.claude/worktrees',
        root,
        dryRun: false,
        sourceBranch: 'origin/develop',
        reserved: ['origin/develop'],
      };
      const first = startAutopilotGit('proposal-links', run);
      expect(existsSync(join(first.worktreePath!, 'base.txt'))).toBe(true);
      expect(git(first.worktreePath!, 'branch', '--show-current')).toBe('proposal-links');
      expect(git(root, 'branch', '--show-current')).toBe('develop');

      writeFileSync(join(first.worktreePath!, 'one.txt'), 'one\n');
      git(first.worktreePath!, 'add', '.');
      git(first.worktreePath!, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'one');
      const tip = git(first.worktreePath!, 'rev-parse', 'HEAD');

      const later = startAutopilotGit('proposal-links', run);
      expect(later.worktreePath).toBe(first.worktreePath);
      expect(git(later.worktreePath!, 'rev-parse', 'HEAD')).toBe(tip);
    });

    it('refuses a slug that exists only on the remote', () => {
      const root = join(dir, 'main');
      git(root, 'push', '--quiet', 'origin', 'develop:taken');
      expect(() =>
        startAutopilotGit('taken', { worktreesDir: '.claude/worktrees', root, dryRun: false }),
      ).toThrow(/already exists on origin/);
      expect(existsSync(join(root, '.claude/worktrees', 'taken'))).toBe(false);
    });
  });
});
