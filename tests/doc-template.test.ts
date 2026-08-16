import { describe, expect, it } from 'vitest';
import {
  canonicalizeDocId,
  docFileStem,
  formatDocId,
  nextDocNum,
  parseDocId,
  parseDocMarkdown,
  parseDocMarkdownLenient,
  renderDocMarkdown,
  titleCase,
} from '../src/templates/doc.js';

describe('doc frontmatter', () => {
  it('round-trips frontmatter + body', () => {
    const raw = renderDocMarkdown({
      frontmatter: { name: 'Document handling', description: 'In-platform viewer', type: 'prd', status: 'Shipped' },
      body: '# PRD 0009 — Document handling\n\n## Problem statement\n',
    });
    expect(raw.startsWith('---\n')).toBe(true);
    const parsed = parseDocMarkdown(raw);
    expect(parsed.frontmatter).toEqual({
      name: 'Document handling',
      description: 'In-platform viewer',
      type: 'prd',
      status: 'Shipped',
    });
    expect(parsed.body).toBe('# PRD 0009 — Document handling\n\n## Problem statement\n');
  });

  it('requires name, description and type', () => {
    const raw = renderDocMarkdown({ frontmatter: { name: 'x' } as any, body: 'body' });
    expect(() => parseDocMarkdown(raw)).toThrow(/description/);
  });

  it('rejects a doc with no frontmatter block at all', () => {
    expect(() => parseDocMarkdown('# just a heading\n')).toThrow(/frontmatter/);
  });

  it('passes through arbitrary per-type extra fields untouched', () => {
    const raw = renderDocMarkdown({
      frontmatter: {
        name: 'x',
        description: 'y',
        type: 'adr',
        status: 'Accepted',
        'related-adrs': [1, 2, 6],
      },
      body: 'body',
    });
    const parsed = parseDocMarkdown(raw);
    expect(parsed.frontmatter.status).toBe('Accepted');
    expect(parsed.frontmatter['related-adrs']).toEqual([1, 2, 6]);
  });
});

// Real shapes from the EPR-V2 docs the user copied into the playground for
// testing: ADRs with NO frontmatter at all, and PRDs whose frontmatter has a
// bare `title:` (no `name`/`description`/`type`). A strict parse silently
// dropped every one of them from `list`/`get`/`migrate` — this is the fix.
describe('parseDocMarkdownLenient — adopting pre-kodi content', () => {
  it('never throws on a file with no frontmatter block at all', () => {
    const raw = '# ADR 0001 — Clean Architecture layering\n\n**Status:** Accepted\n';
    const parsed = parseDocMarkdownLenient(raw, { type: 'adr', slug: 'clean-architecture-layering' });
    expect(parsed.frontmatter.name).toBe('ADR 0001 — Clean Architecture layering'); // from the H1
    expect(parsed.frontmatter.description).toBe('');
    expect(parsed.frontmatter.type).toBe('adr'); // from the fallback context, not guessed
    expect(parsed.body).toBe(raw); // untouched — nothing to strip
  });

  it('falls back to the title-cased slug when there is no frontmatter AND no H1', () => {
    const parsed = parseDocMarkdownLenient('just some prose\n', { type: 'security', slug: 'portal-query-cache-survives-signout' });
    expect(parsed.frontmatter.name).toBe(titleCase('portal-query-cache-survives-signout'));
  });

  it('maps a bare `title:` frontmatter field (the real EPR-V2 PRD shape) to `name`', () => {
    const raw = [
      '---',
      'PRD: 9',
      'title: Document Handling',
      'status: Shipped',
      '---',
      '',
      '# PRD 0009 — Document Handling',
    ].join('\n');
    const parsed = parseDocMarkdownLenient(raw, { type: 'prd', slug: 'document-handling' });
    expect(parsed.frontmatter.name).toBe('Document Handling');
    expect(parsed.frontmatter.description).toBe(''); // no description/summary anywhere -> ''
    expect(parsed.frontmatter.type).toBe('prd');
    expect(parsed.frontmatter.status).toBe('Shipped'); // untouched extra field, preserved
    expect(parsed.frontmatter.PRD).toBe(9);
  });

  it('prefers real frontmatter fields (name/description/type) over every fallback when present', () => {
    const raw = renderDocMarkdown({
      frontmatter: { name: 'Real Name', description: 'Real description', type: 'prd' },
      body: '# A different heading\n',
    });
    const parsed = parseDocMarkdownLenient(raw, { type: 'adr', slug: 'wrong-fallback' });
    expect(parsed.frontmatter).toMatchObject({ name: 'Real Name', description: 'Real description', type: 'prd' });
  });

  it('treats malformed YAML frontmatter the same as "no frontmatter" rather than throwing', () => {
    const raw = '---\nname: [unclosed\n---\n\n# Heading\n';
    expect(() => parseDocMarkdownLenient(raw, { type: 'prd', slug: 'x' })).not.toThrow();
  });
});

describe('doc id scheme', () => {
  it('formats and parses TYPE-NNNN with 4-digit padding', () => {
    expect(formatDocId('prd', 9)).toBe('PRD-0009');
    expect(formatDocId('ADR', 1)).toBe('ADR-0001');
    expect(parseDocId('PRD-0009')).toEqual({ type: 'prd', num: 9 });
  });

  it('canonicalizes a hand-typed, unpadded, lowercase id', () => {
    expect(canonicalizeDocId('prd-9')).toBe('PRD-0009');
    expect(canonicalizeDocId('adr-0001')).toBe('ADR-0001');
  });

  it('returns null for something that is not TYPE-NNNN shaped', () => {
    expect(parseDocId('not-an-id')).toBeNull();
    expect(parseDocId('PRD')).toBeNull();
  });

  it('leaves an unparseable ref untouched when canonicalizing', () => {
    expect(canonicalizeDocId('N/A')).toBe('N/A');
  });

  it('computes the next free number per type, ignoring other types', () => {
    const ids = ['PRD-0001', 'PRD-0003', 'ADR-0009'];
    expect(nextDocNum('prd', ids)).toBe(4);
    expect(nextDocNum('adr', ids)).toBe(10);
    expect(nextDocNum('security', ids)).toBe(1);
  });

  it('builds the file/page stem from num + slug', () => {
    expect(docFileStem(9, 'document-handling')).toBe('0009-document-handling');
  });
});
