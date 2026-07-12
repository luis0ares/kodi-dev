import { describe, expect, it } from 'vitest';
import { azureCreateArgs, githubCreateArgs } from '../src/commands/pr.js';
import {
  assertWithinBodyLimit,
  MAX_PR_BODY,
  PrSchema,
  renderPrHtml,
  renderPrMarkdown,
} from '../src/templates/pr.js';

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

  it('renders the security vulnerabilities section only when findings exist', () => {
    expect(renderPrMarkdown(draft())).not.toContain('## Security vulnerabilities');
    const md = renderPrMarkdown(
      draft({
        vulnerabilities: ['CRITICAL — SQLi in login (docs/security/KODI-014-sqli-login.md)'],
      }),
    );
    expect(md).toContain('## Security vulnerabilities');
    expect(md).toContain('- CRITICAL — SQLi in login (docs/security/KODI-014-sqli-login.md)');
    // findings surface right after the summary, before feature/change bullets
    expect(md.indexOf('## Security vulnerabilities')).toBeLessThan(md.indexOf('## Features'));
  });

  it('renders HTML for azure', () => {
    expect(renderPrHtml(draft())).toContain('<h2>Summary</h2>');
  });

  it('neutralizes accidental "#<number>" so no provider autolinks it', () => {
    const md = renderPrMarkdown(
      draft({ summary: 'Closes the gap from #1010 and note #42.', features: ['bump to v#7'] }),
    );
    // the raw "#<digit>" adjacency is broken (zero-width space inserted) ...
    expect(md).not.toContain('#1010');
    expect(md).not.toContain('#42');
    expect(md).not.toContain('#7');
    // ... but the visible glyphs are preserved
    expect(md).toContain('#\u200B1010');
    expect(md).toContain('v#\u200B7');
  });

  it('keeps "#<number>" intact in Related issues (intentional references)', () => {
    const md = renderPrMarkdown(draft({ relatedIssues: ['#1010', 'AUTH-9'] }));
    expect(md).toContain('- #1010');
    expect(md).not.toContain('#\u200B1010');
  });

  it('accepts a body at the limit and rejects one over it', () => {
    expect(() => assertWithinBodyLimit('x'.repeat(MAX_PR_BODY))).not.toThrow();
    expect(() => assertWithinBodyLimit('x'.repeat(MAX_PR_BODY + 1))).toThrow(
      /is \d+ chars; the limit is 4000/,
    );
  });
});

describe('pr command construction', () => {
  it('builds an azure create command', () => {
    const args = azureCreateArgs(draft(), '<p>x</p>', 'feat/x', 'main', 'Repo');
    expect(args.slice(0, 5)).toEqual(['az', 'repos', 'pr', 'create', '--title']);
    expect(args).toContain('--source-branch');
    expect(args).toContain('--target-branch');
    expect(args).toContain('--repository');
  });

  it('builds a github create command (markdown body-file, base/head, reviewers, repo)', () => {
    const args = githubCreateArgs(
      draft({ reviewers: ['octocat'] }),
      '/tmp/body.md',
      'feat/x',
      'main',
      'acme/app',
    );
    expect(args.slice(0, 5)).toEqual(['gh', 'pr', 'create', '--title', 'Add dataset import']);
    expect(args).toContain('--body-file');
    expect(args).toContain('/tmp/body.md');
    expect(args.slice(-2)).toEqual(['--repo', 'acme/app']);
    expect(args).toContain('--base');
    expect(args).toContain('--head');
    expect(args).toContain('--reviewer');
    expect(args).toContain('octocat');
  });
});
