// Pure-lib unit tests for the frontmatter extractor + §7 projector. Verifies the
// explicit allow-list pick (SR-5): phantom NG-1 fields and slug/nonGoals never
// survive, defaults are applied, drivers is rebuilt sub-key-by-sub-key, and a
// malformed block throws (→ the assembler degrades the card, SR-3).

import { describe, expect, it } from 'vitest';
import { extractFrontmatterBlock, projectFrontmatter } from '@/lib/tickets/frontmatter';

describe('extractFrontmatterBlock', () => {
  it('returns the inner YAML of a leading fenced block, without the fences', () => {
    expect(extractFrontmatterBlock('---\nkey: A\n---\n# body\n')).toBe('key: A');
  });

  it('tolerates a leading UTF-8 BOM before the fence', () => {
    expect(extractFrontmatterBlock('﻿---\nkey: A\n---\n')).toBe('key: A');
  });

  it('returns null when the source has no leading fence', () => {
    expect(extractFrontmatterBlock('# just a heading\nno frontmatter\n')).toBeNull();
  });

  it('returns null when the fence is never closed', () => {
    expect(extractFrontmatterBlock('---\nkey: A\nnever closed\n')).toBeNull();
  });
});

describe('projectFrontmatter — §7 allow-list pick & phantom exclusion (scenario 3)', () => {
  const block = [
    'key: KODI-001',
    'title: Add dataset import',
    'slug: add-dataset-import', // R-013: never surfaced
    'status: Pending', // index-wins: never projected here
    'dependencies:',
    '  - KODI-999',
    'drivers:',
    '  adr:',
    '    - docs/adr/0002',
    '  prd: docs/prd/0001',
    '  security: docs/security/AUTH-014',
    '  bogus: should-not-survive', // extra driver sub-key
    'summary: Import a dataset from CSV.',
    'acceptanceCriteria:',
    '  - CSV upload works',
    'nonGoals:', // R-013: never surfaced
    '  - remote import',
    'prUrl: https://example.test/pr/1',
    'notes: some notes',
    // NG-1 phantom fields that must never be read/exposed:
    'priority: high',
    'phase: 2',
    'created: 2026-01-01',
    'implementedAt: 2026-02-02',
    'branch: feat/x',
    'lastCommit: abc123',
  ].join('\n');

  it('exposes exactly the §7 projected fields and no phantom / non-surfaced keys', () => {
    const p = projectFrontmatter(block);
    expect(new Set(Object.keys(p))).toEqual(
      new Set(['title', 'dependencies', 'drivers', 'summary', 'acceptanceCriteria', 'prUrl', 'notes']),
    );
    for (const forbidden of [
      'key',
      'status',
      'slug',
      'nonGoals',
      'priority',
      'phase',
      'created',
      'implementedAt',
      'branch',
      'lastCommit',
    ]) {
      expect(forbidden in p).toBe(false);
    }
  });

  it('rebuilds drivers from only its three known sub-keys, dropping extras', () => {
    const p = projectFrontmatter(block);
    expect(new Set(Object.keys(p.drivers))).toEqual(new Set(['adr', 'prd', 'security']));
    expect(p.drivers).toEqual({
      adr: ['docs/adr/0002'],
      prd: 'docs/prd/0001',
      security: 'docs/security/AUTH-014',
    });
  });

  it('applies §7 defaults: dependencies [] and drivers {adr:[]} when absent', () => {
    const p = projectFrontmatter('title: Bare\nsummary: minimal\nacceptanceCriteria:\n  - ok');
    expect(p.dependencies).toEqual([]);
    expect(p.drivers).toEqual({ adr: [] });
    expect('prd' in p.drivers).toBe(false);
    expect('security' in p.drivers).toBe(false);
  });

  it('drops __proto__/constructor/prototype from the frontmatter (SR-4)', () => {
    const p = projectFrontmatter('__proto__:\n  polluted: true\ntitle: T\nsummary: s\n');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(p.title).toBe('T');
  });

  it('throws when the block is not a YAML mapping (→ card degrades, SR-3)', () => {
    expect(() => projectFrontmatter('just a scalar string')).toThrow();
    expect(() => projectFrontmatter('- a\n- b')).toThrow();
  });
});
