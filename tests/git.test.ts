import { describe, expect, it, vi } from 'vitest';
import { branchExists, sliceBranchName, startSliceGit } from '../src/git.js';

describe('sliceBranchName', () => {
  it('namespaces the ticket id under slice/kodi-', () => {
    expect(sliceBranchName('KODI-003')).toBe('slice/kodi-KODI-003');
    expect(sliceBranchName('123')).toBe('slice/kodi-123');
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
});

describe('startSliceGit', () => {
  it('checks out a new branch when it does not exist yet', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: false, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      { exists: () => false, mutate },
    );

    expect(result).toEqual({ branch: 'slice/kodi-KODI-003' });
    expect(mutate).toHaveBeenCalledWith(['git', 'checkout', '-b', 'slice/kodi-KODI-003'], false);
  });

  it('reuses (checks out) an existing branch instead of failing on -b', () => {
    const mutate = vi.fn();
    startSliceGit(
      'KODI-003',
      { worktree: false, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      { exists: () => true, mutate },
    );

    expect(mutate).toHaveBeenCalledWith(['git', 'checkout', 'slice/kodi-KODI-003'], false);
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
      { exists: () => false, mutate },
    );

    expect(mutate).toHaveBeenCalledWith(
      ['git', 'checkout', '-b', 'slice/kodi-KODI-003', 'develop'],
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
      { exists: () => true, mutate },
    );

    expect(mutate).toHaveBeenCalledWith(['git', 'checkout', 'slice/kodi-KODI-003'], false);
  });

  it('previews only (no mutation semantics change) on a dry-run', () => {
    const mutate = vi.fn();
    startSliceGit(
      'KODI-003',
      { worktree: false, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: true },
      { exists: () => false, mutate },
    );

    expect(mutate).toHaveBeenCalledWith(['git', 'checkout', '-b', 'slice/kodi-KODI-003'], true);
  });

  it('creates a worktree at <root>/<worktreesDir>/<branch> when it does not exist', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      { exists: () => false, mutate, pathExists: () => false },
    );

    const expectedPath = '/repo/.claude/worktrees/slice-kodi-KODI-003';
    expect(result).toEqual({ branch: 'slice/kodi-KODI-003', worktreePath: expectedPath });
    expect(mutate).toHaveBeenCalledWith(
      ['git', 'worktree', 'add', expectedPath, '-b', 'slice/kodi-KODI-003'],
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
      { exists: () => false, mutate, pathExists: () => false },
    );

    expect(mutate).toHaveBeenCalledWith(
      ['git', 'worktree', 'add', expectedPath, '-b', 'slice/kodi-KODI-003', 'develop'],
      false,
    );
  });

  it('flattens the branch slash in the worktree dir name, so every slice does not nest under one shared "slice" folder', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      { exists: () => false, mutate, pathExists: () => false },
    );

    expect(result.worktreePath).toBe('/repo/.claude/worktrees/slice-kodi-KODI-003');
    expect(result.branch).toBe('slice/kodi-KODI-003'); // the branch itself stays namespaced
  });

  it('adds a worktree from an existing branch without -b', () => {
    const mutate = vi.fn();
    startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      { exists: () => true, mutate, pathExists: () => false },
    );

    const expectedPath = '/repo/.claude/worktrees/slice-kodi-KODI-003';
    expect(mutate).toHaveBeenCalledWith(
      ['git', 'worktree', 'add', expectedPath, 'slice/kodi-KODI-003'],
      false,
    );
  });

  it('is idempotent — skips entirely when the worktree path already exists', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: '.claude/worktrees', root: '/repo', dryRun: false },
      { exists: () => false, mutate, pathExists: () => true },
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(result).toEqual({
      branch: 'slice/kodi-KODI-003',
      worktreePath: '/repo/.claude/worktrees/slice-kodi-KODI-003',
    });
  });

  it('respects a custom worktreesDir', () => {
    const mutate = vi.fn();
    const result = startSliceGit(
      'KODI-003',
      { worktree: true, worktreesDir: 'tmp/wt', root: '/repo', dryRun: false },
      { exists: () => false, mutate, pathExists: () => false },
    );

    expect(result.worktreePath).toBe('/repo/tmp/wt/slice-kodi-KODI-003');
  });
});
