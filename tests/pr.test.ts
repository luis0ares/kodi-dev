import { describe, expect, it } from 'vitest';
import {
  azureCreateArgs,
  azureUpdateArgs,
  azureWorkItemIds,
  githubCreateArgs,
  githubEditArgs,
} from '../src/commands/pr.js';
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
    typeOfChange: { feature: true },
    features: ['CSV upload'],
    relatedIssues: ['N/A'],
    testing: { unit: true },
    ...over,
  });
}

describe('pr template', () => {
  it('applies defaults and validates a minimal draft', () => {
    const pr = draft();
    expect(pr.fixes).toEqual([]);
    expect(pr.reviewers).toEqual([]);
    expect(pr.typeOfChange.feature).toBe(true);
    expect(pr.typeOfChange.refactor).toBe(false);
    expect(pr.testing.unit).toBe(true);
  });

  it('rejects a too-short title', () => {
    expect(
      PrSchema.safeParse({
        title: 'ab',
        summary: 'x',
        typeOfChange: { fix: true },
        testing: { na: true },
      }).success,
    ).toBe(false);
  });

  it('rejects a draft with no Type of Change checked', () => {
    const r = PrSchema.safeParse({
      title: 'A valid title',
      summary: 'x',
      typeOfChange: {},
      relatedIssues: ['N/A'],
      testing: { unit: true },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /Type of Change/.test(i.message))).toBe(true);
  });

  it('rejects a draft with no Testing option checked', () => {
    const r = PrSchema.safeParse({
      title: 'A valid title',
      summary: 'x',
      typeOfChange: { fix: true },
      relatedIssues: ['N/A'],
      testing: {},
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /Testing/.test(i.message))).toBe(true);
  });

  it('rejects a draft with no Related Issues / Work Items entry', () => {
    const r = PrSchema.safeParse({
      title: 'A valid title',
      summary: 'x',
      typeOfChange: { fix: true },
      relatedIssues: [],
      testing: { na: true },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /Related Issues/.test(i.message))).toBe(true);
  });

  it('always renders every required section, in template order', () => {
    const md = renderPrMarkdown(draft());
    const order = [
      '## Summary',
      '## Type of Change',
      '## Included Changes',
      '### Features',
      '### Fixes',
      '### Improvements',
      '## Related Issues / Work Items',
      '## Testing',
      '## Checklist',
    ];
    let last = -1;
    for (const section of order) {
      const at = md.indexOf(section);
      expect(at, `missing section: ${section}`).toBeGreaterThan(-1);
      expect(at, `out of order: ${section}`).toBeGreaterThan(last);
      last = at;
    }
  });

  it('renders empty Included Changes subsections as "n/a" rather than dropping them', () => {
    const md = renderPrMarkdown(draft()); // no fixes, no improvements
    expect(md).toContain('### Fixes\n\n- n/a');
    expect(md).toContain('### Improvements\n\n- n/a');
  });

  it('renders Azure HTML checkboxes as real <input> elements (not literal [ ]/[x])', () => {
    const html = renderPrHtml(draft({ typeOfChange: { documentation: true } }));
    // checked box for the selected type, unchecked for the others — never literal brackets
    expect(html).toContain('<input type="checkbox" checked /> Documentation');
    expect(html).toContain('<input type="checkbox" /> Feature');
    expect(html).not.toContain('[ ] Feature');
    expect(html).not.toContain('[x] Documentation');
  });

  it('checks Type of Change and Testing boxes that are set, leaves the rest blank', () => {
    const md = renderPrMarkdown(
      draft({ typeOfChange: { feature: true, fix: true }, testing: { unit: true, manual: true } }),
    );
    expect(md).toContain('- [x] Feature');
    expect(md).toContain('- [x] Fix');
    expect(md).toContain('- [ ] Improvement');
    expect(md).toContain('- [ ] Refactor');
    expect(md).toContain('- [x] Unit tests');
    expect(md).toContain('- [ ] Integration tests');
    expect(md).toContain('- [x] Manual testing');
  });

  it('always renders the Checklist blank for the human to tick after creation', () => {
    const md = renderPrMarkdown(draft());
    expect(md).toContain('- [ ] Self-review completed');
    expect(md).toContain('- [ ] Created on a dedicated branch (not the default branch)');
    expect(md).toContain('- [ ] CI passing');
    expect(md).toContain('- [ ] Ready to merge');
    // never pre-checked
    expect(md).not.toContain('- [x] Self-review completed');
  });

  it('omits Notes when absent and renders it when present', () => {
    expect(renderPrMarkdown(draft())).not.toContain('## Notes');
    const md = renderPrMarkdown(draft({ notes: 'Deploy after the migration.' }));
    expect(md).toContain('## Notes');
    expect(md).toContain('Deploy after the migration.');
    // Notes sits between Testing and Checklist
    expect(md.indexOf('## Notes')).toBeGreaterThan(md.indexOf('## Testing'));
    expect(md.indexOf('## Notes')).toBeLessThan(md.indexOf('## Checklist'));
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

  it('extracts azure work-item ids from related issues (bare, #, AB#), ignoring non-numeric', () => {
    expect(azureWorkItemIds(['123', '#456', 'AB#789', 'N/A', 'AUTH-9', 'ab#123'])).toEqual([
      '123',
      '456',
      '789',
    ]);
    // dedupes and preserves first-seen order
    expect(azureWorkItemIds(['#5', '5', 'AB#5'])).toEqual(['5']);
    // the default "N/A"-only draft links nothing
    expect(azureWorkItemIds(['N/A'])).toEqual([]);
  });

  it('links referenced work items to an azure PR via --work-items (space-separated)', () => {
    const args = azureCreateArgs(
      draft({ relatedIssues: ['1219', '#42'] }),
      '<p>x</p>',
      'feat/x',
      'main',
      'Repo',
    );
    const at = args.indexOf('--work-items');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('1219');
    expect(args[at + 2]).toBe('42');
  });

  it('omits --work-items when no related issue is a work-item reference', () => {
    const args = azureCreateArgs(draft(), '<p>x</p>', 'feat/x', 'main', 'Repo'); // relatedIssues: ['N/A']
    expect(args).not.toContain('--work-items');
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

  it('builds a github edit command (id, title, body-file, add-reviewer, repo)', () => {
    const args = githubEditArgs(
      '42',
      draft({ reviewers: ['octocat'] }),
      '/tmp/body.md',
      'acme/app',
    );
    expect(args.slice(0, 4)).toEqual(['gh', 'pr', 'edit', '42']);
    expect(args).toContain('--title');
    expect(args).toContain('--body-file');
    expect(args).toContain('/tmp/body.md');
    expect(args).toContain('--add-reviewer');
    expect(args).toContain('octocat');
    expect(args.slice(-2)).toEqual(['--repo', 'acme/app']);
  });

  it('builds an azure update command (identified by --id, no --repository)', () => {
    const args = azureUpdateArgs('42', draft(), '<p>x</p>');
    expect(args.slice(0, 5)).toEqual(['az', 'repos', 'pr', 'update', '--id']);
    expect(args).toContain('42');
    expect(args).toContain('--title');
    expect(args).toContain('--description');
    expect(args).not.toContain('--repository');
  });

  it('omits --draft by default and adds it when requested', () => {
    expect(githubCreateArgs(draft(), '/tmp/body.md', 'feat/x', 'main')).not.toContain('--draft');
    expect(githubCreateArgs(draft(), '/tmp/body.md', 'feat/x', 'main', undefined, true)).toContain(
      '--draft',
    );
    expect(azureCreateArgs(draft(), '<p>x</p>', 'feat/x', 'main')).not.toContain('--draft');
    // az takes an explicit boolean value after --draft
    const az = azureCreateArgs(draft(), '<p>x</p>', 'feat/x', 'main', undefined, true);
    expect(az).toContain('--draft');
    expect(az[az.indexOf('--draft') + 1]).toBe('true');
  });
});
