import { describe, expect, it } from 'vitest';
import {
  decideEnsureWikiAction,
  flattenWikiPagePaths,
  parseDocPagePath,
  parseWikiNames,
  wikiCreateArgs,
  wikiListArgs,
  wikiPageDeleteArgs,
  wikiPageShowArgs,
  wikiPageTreeArgs,
  wikiPageWriteArgs,
  type WikiPageNode,
} from '../src/providers/azure-wiki-docs.js';

describe('azure wiki — argv builders', () => {
  it('builds the wiki list command', () => {
    expect(wikiListArgs('https://dev.azure.com/acme', 'Proj')).toEqual([
      'az', 'devops', 'wiki', 'list', '--org', 'https://dev.azure.com/acme', '--project', 'Proj', '--output', 'json',
    ]);
  });

  it('builds the wiki create command (project-wiki type is the default, no --type flag)', () => {
    const args = wikiCreateArgs('https://dev.azure.com/acme', 'Proj', 'Proj.wiki');
    expect(args).toEqual([
      'az', 'devops', 'wiki', 'create', '--name', 'Proj.wiki', '--org', 'https://dev.azure.com/acme', '--project', 'Proj',
    ]);
  });

  it('builds the recursive page-tree read', () => {
    const args = wikiPageTreeArgs('org', 'Proj', 'Proj.wiki');
    expect(args).toContain('--recursion-level');
    expect(args).toContain('full');
    expect(args).not.toContain('--include-content');
  });

  it('builds a page show with --include-content', () => {
    const args = wikiPageShowArgs('org', 'Proj', 'Proj.wiki', '/prd/0009-document-handling');
    expect(args).toContain('--include-content');
    expect(args).toContain('/prd/0009-document-handling');
  });

  it('builds a create page write with --file-path, never inline --content (sidesteps the Windows argv-truncation bug)', () => {
    const args = wikiPageWriteArgs('create', 'org', 'Proj', 'Proj.wiki', '/prd/0001-x', '/tmp/page.md');
    expect(args).toContain('--file-path');
    expect(args).toContain('/tmp/page.md');
    expect(args).not.toContain('--content');
    expect(args).not.toContain('--version');
  });

  it('builds an update page write with --version (the eTag)', () => {
    const args = wikiPageWriteArgs('update', 'org', 'Proj', 'Proj.wiki', '/prd/0001-x', '/tmp/page.md', 'abc123');
    expect(args).toContain('--version');
    expect(args).toContain('abc123');
  });

  it('includes --comment only when given', () => {
    const withComment = wikiPageWriteArgs('create', 'org', 'Proj', 'Proj.wiki', '/p', '/tmp/f', undefined, 'msg');
    expect(withComment).toContain('--comment');
    expect(withComment).toContain('msg');
    const without = wikiPageWriteArgs('create', 'org', 'Proj', 'Proj.wiki', '/p', '/tmp/f');
    expect(without).not.toContain('--comment');
  });

  it('builds a delete with --yes (no interactive confirmation)', () => {
    const args = wikiPageDeleteArgs('org', 'Proj', 'Proj.wiki', '/prd/0001-x');
    expect(args).toContain('--yes');
  });
});

describe('azure wiki — parsers', () => {
  it('parses wiki names from both array and {value:[...]} shapes', () => {
    expect(parseWikiNames(JSON.stringify([{ name: 'A.wiki' }, { name: 'B.wiki' }]))).toEqual(['A.wiki', 'B.wiki']);
    expect(parseWikiNames(JSON.stringify({ value: [{ name: 'A.wiki' }] }))).toEqual(['A.wiki']);
    expect(parseWikiNames('')).toEqual([]);
  });

  it('flattens a nested page tree depth-first', () => {
    const root: WikiPageNode = {
      path: '/',
      subPages: [
        { path: '/prd', subPages: [{ path: '/prd/0001-x', subPages: [] }] },
        { path: '/Some Unrelated Page', subPages: [] },
      ],
    };
    expect(flattenWikiPagePaths(root)).toEqual(['/prd', '/prd/0001-x', '/Some Unrelated Page']);
  });

  it('parses a doc-shaped page path (type/NNNN-slug)', () => {
    expect(parseDocPagePath('/prd/0009-document-handling')).toEqual({
      type: 'prd',
      num: 9,
      slug: 'document-handling',
    });
  });

  it('rejects non-doc-shaped paths — single segment, no numeric prefix, or unrelated wiki content', () => {
    expect(parseDocPagePath('/Diabetes Prediction Pipeline')).toBeNull();
    expect(parseDocPagePath('/prd')).toBeNull();
    expect(parseDocPagePath('/prd/not-numbered')).toBeNull();
    expect(parseDocPagePath('/')).toBeNull();
  });
});

describe('ensureWiki decision', () => {
  it('is "unavailable" when the wiki-list read itself failed (feature disabled/unreachable)', () => {
    expect(decideEnsureWikiAction(null, 'Proj.wiki')).toBe('unavailable');
  });

  it('is "exists" when the target wiki is already in the list', () => {
    expect(decideEnsureWikiAction(['Proj.wiki', 'Other.wiki'], 'Proj.wiki')).toBe('exists');
  });

  it('is "create" when the feature is enabled but the target wiki is absent', () => {
    expect(decideEnsureWikiAction([], 'Proj.wiki')).toBe('create');
    expect(decideEnsureWikiAction(['Other.wiki'], 'Proj.wiki')).toBe('create');
  });
});
