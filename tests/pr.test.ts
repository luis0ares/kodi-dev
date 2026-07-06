import { describe, expect, it } from 'vitest';
import { azureCreateArgs, githubCreateArgs } from '../src/commands/pr.js';
import { PrSchema, renderPrHtml, renderPrMarkdown } from '../src/templates/pr.js';

function draft(over: Record<string, unknown> = {}) {
  return PrSchema.parse({
    title: 'Add dataset import',
    summary: 'Import a dataset from CSV.',
    features: ['CSV upload'],
    ...over,
  });
}

describe('pr template', () => {
  it('applies defaults and validates a minimal draft', () => {
    const pr = draft();
    expect(pr.fixes).toEqual([]);
    expect(pr.reviewers).toEqual([]);
  });

  it('rejects a too-short title', () => {
    expect(PrSchema.safeParse({ title: 'ab', summary: 'x' }).success).toBe(false);
  });

  it('renders summary and non-empty sections only', () => {
    const md = renderPrMarkdown(draft({ fixes: ['crash on empty file'] }));
    expect(md).toContain('## Summary');
    expect(md).toContain('## Features');
    expect(md).toContain('- CSV upload');
    expect(md).toContain('## Fixes');
    expect(md).not.toContain('## Improvements'); // empty → omitted
  });

  it('renders HTML for azure', () => {
    expect(renderPrHtml(draft())).toContain('<h2>Summary</h2>');
  });
});

describe('pr command construction', () => {
  it('builds a github create command with reviewers and repo', () => {
    const args = githubCreateArgs(draft({ reviewers: ['alice'] }), '/tmp/b.md', 'feat/x', 'main', 'owner/repo');
    expect(args.slice(0, 4)).toEqual(['gh', 'pr', 'create', '--title']);
    expect(args).toContain('--body-file');
    expect(args).toContain('--base');
    expect(args).toContain('main');
    expect(args).toContain('--head');
    expect(args).toContain('feat/x');
    expect(args).toContain('--reviewer');
    expect(args).toContain('alice');
    expect(args).toContain('--repo');
    expect(args).toContain('owner/repo');
  });

  it('builds an azure create command', () => {
    const args = azureCreateArgs(draft(), '<p>x</p>', 'feat/x', 'main', 'Repo');
    expect(args.slice(0, 5)).toEqual(['az', 'repos', 'pr', 'create', '--title']);
    expect(args).toContain('--source-branch');
    expect(args).toContain('--target-branch');
    expect(args).toContain('--repository');
  });
});
