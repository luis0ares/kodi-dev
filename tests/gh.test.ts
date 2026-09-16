import { describe, expect, it, vi } from 'vitest';
import { baseBranchLinkWarning, defaultBranch, explainGhFailure, ghVersion } from '../src/gh.js';

describe('defaultBranch', () => {
  it('asks gh for the repository default branch', () => {
    const read = vi.fn((_args: string[]) => 'main\n');
    expect(defaultBranch('Owner/repo', read)).toBe('main');
    expect(read.mock.calls[0][0]).toEqual([
      'gh',
      'repo',
      'view',
      'Owner/repo',
      '--json',
      'defaultBranchRef',
      '-q',
      '.defaultBranchRef.name',
    ]);
  });

  it('resolves from cwd when no repository is configured', () => {
    const read = vi.fn((_args: string[]) => 'main\n');
    defaultBranch(undefined, read);
    expect(read.mock.calls[0][0]).not.toContain('Owner/repo');
  });

  it('is undefined — never an error — when gh cannot answer', () => {
    expect(
      defaultBranch('Owner/repo', () => {
        throw new Error('gh: not authenticated');
      }),
    ).toBeUndefined();
    expect(defaultBranch('Owner/repo', () => '\n')).toBeUndefined();
  });
});

describe('baseBranchLinkWarning', () => {
  it('warns when the base is not the default branch — the case kodi prTarget creates', () => {
    const w = baseBranchLinkWarning('integration/0006-visual-identity', 'main');
    expect(w).toMatch(/is not the repository's default branch/);
    expect(w).toContain('integration/0006-visual-identity');
    expect(w).toContain('main');
    expect(w).toMatch(/will not link or auto-close/);
  });

  it('is silent when the base IS the default branch', () => {
    expect(baseBranchLinkWarning('main', 'main')).toBeUndefined();
  });

  it('is silent when the default branch is unknown — advice never becomes an error', () => {
    expect(baseBranchLinkWarning('develop', undefined)).toBeUndefined();
  });
});

describe('ghVersion', () => {
  it('reads the version out of `gh --version`', () => {
    expect(ghVersion(() => 'gh version 2.46.0 (2024-03-20)\nhttps://…')).toBe('2.46.0');
  });

  it('is undefined when gh is not runnable', () => {
    expect(
      ghVersion(() => {
        throw new Error('ENOENT');
      }),
    ).toBeUndefined();
  });
});

describe('explainGhFailure', () => {
  const sunset = new Error(
    '`gh pr edit 8 --body-file /tmp/body.md` failed (exit 1): GraphQL: Projects (classic) is ' +
      'being deprecated in favor of the new Projects experience, see: ' +
      'https://github.blog/changelog/2024-05-23-sunset-notice-projects-classic/. ' +
      '(repository.pullRequest.projectCards)',
  );

  it('names the real cause — an old gh, not kodi and not the GitHub API', () => {
    const err = explainGhFailure(sunset, {
      bodyFile: '/tmp/body.md',
      version: () => '2.46.0',
    }) as Error;
    expect(err.message).toMatch(/your `gh` is too old/);
    expect(err.message).toContain('detected gh 2.46.0');
    expect(err.message).toMatch(/Upgrade gh/);
  });

  it('hands back the workaround with the body kodi already rendered', () => {
    const err = explainGhFailure(sunset, {
      bodyFile: '/tmp/body.md',
      version: () => undefined,
    }) as Error;
    expect(err.message).toContain('gh api -X PATCH');
    expect(err.message).toContain('--field body=@/tmp/body.md');
    // Nothing is hidden: the original text is still there for the reader.
    expect(err.message).toContain('projectCards');
  });

  it('passes an unrecognized failure through untouched', () => {
    const other = new Error('`gh pr edit 8` failed (exit 1): pull request not found');
    expect(explainGhFailure(other, { version: () => '2.101.0' })).toBe(other);
  });
});
