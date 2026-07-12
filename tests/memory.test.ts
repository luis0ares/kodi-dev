import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/memory/db.js';
import {
  amendMemory,
  exportMemories,
  importMemories,
  insertMemory,
  lookupCollection,
  provisionCollection,
  queryMemories,
  recentMemories,
  removeMemory,
  resolveCollection,
} from '../src/memory/store.js';
import { contentHash, MemoryDraftSchema } from '../src/memory/template.js';

const COL = 'test-col';
let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kodi-mem-'));
  db = openDb(join(dir, 'rag.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function store(over: Record<string, unknown> = {}, col = COL) {
  return insertMemory(
    db,
    col,
    MemoryDraftSchema.parse({ content: 'x', type: 'decision', ...over }),
  );
}

describe('memory template', () => {
  it('validates and defaults a draft', () => {
    const d = MemoryDraftSchema.parse({ content: '  a finding  ', type: 'gotcha' });
    expect(d.content).toBe('a finding'); // trimmed
    expect(d.ticket).toBeNull();
    expect(d.files).toEqual([]);
  });

  it('rejects empty content and bad type', () => {
    expect(MemoryDraftSchema.safeParse({ content: '', type: 'gotcha' }).success).toBe(false);
    expect(MemoryDraftSchema.safeParse({ content: 'x', type: 'nope' }).success).toBe(false);
  });

  it('content hash ignores surrounding whitespace', () => {
    expect(contentHash('  hi  ')).toBe(contentHash('hi'));
  });
});

describe('store + dedup', () => {
  it('stores, dedups identical content, and separates distinct content', () => {
    const a = store({ content: 'alpha finding' });
    expect(a.deduped).toBe(false);
    const again = store({ content: 'alpha finding' });
    expect(again.deduped).toBe(true);
    expect(again.record.id).toBe(a.record.id); // same row
    const b = store({ content: 'beta finding' });
    expect(b.deduped).toBe(false);
    expect(b.record.id).not.toBe(a.record.id);
  });

  it('derives a title and preserves ticket + files', () => {
    const { record } = store({
      content: 'ZWSP avoids #ref autolinks in PR bodies',
      ticket: 'KODI-14',
      files: ['src/templates/pr.ts', 'tests/pr.test.ts'],
    });
    expect(record.title).toContain('ZWSP');
    expect(record.ticket).toBe('KODI-14');
    expect(record.files).toEqual(['src/templates/pr.ts', 'tests/pr.test.ts']);
  });
});

describe('query', () => {
  beforeEach(() => {
    store({
      content: 'we use a zero-width space to de-autolink refs in PR bodies',
      ticket: 'KODI-14',
      files: ['src/templates/pr.ts'],
    });
    store({
      content: 'azure caps the PR body at 4000 chars',
      type: 'gotcha',
      files: ['src/commands/pr.ts'],
    });
    store({ content: 'unrelated note about the board', type: 'reference' });
  });

  it('BM25 free-text match returns scored hits', () => {
    const hits = queryMemories(db, COL, { text: 'autolink refs' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('autolink');
    expect(typeof hits[0].score).toBe('number');
  });

  it('filters by type, ticket, and file', () => {
    expect(queryMemories(db, COL, { type: 'gotcha' }).map((h) => h.type)).toEqual(['gotcha']);
    expect(queryMemories(db, COL, { ticket: 'KODI-14' })).toHaveLength(1);
    expect(queryMemories(db, COL, { file: 'commands/pr.ts' })).toHaveLength(1);
  });

  it('honors limit and is scoped to its collection', () => {
    expect(queryMemories(db, COL, { limit: 2 })).toHaveLength(2);
    store({ content: 'a memory in another project' }, 'other-col');
    expect(queryMemories(db, COL, { text: 'another project' })).toHaveLength(0);
    expect(queryMemories(db, 'other-col', { text: 'another project' })).toHaveLength(1);
  });

  it('empty query browses newest-first', () => {
    const recent = recentMemories(db, COL, 5);
    expect(recent[0].content).toContain('unrelated note'); // last inserted
  });
});

describe('amend + rm', () => {
  it('amends fields and keeps the FTS index in sync', () => {
    const { record } = store({ content: 'old wording about caching' });
    const updated = amendMemory(db, record.id, {
      content: 'new wording about throttling',
      type: 'gotcha',
    });
    expect(updated?.type).toBe('gotcha');
    expect(queryMemories(db, COL, { text: 'throttling' })).toHaveLength(1);
    expect(queryMemories(db, COL, { text: 'caching' })).toHaveLength(0);
  });

  it('returns null for an unknown id and rejects a dedup collision', () => {
    expect(amendMemory(db, 'mem_nope', { type: 'gotcha' })).toBeNull();
    const a = store({ content: 'first' });
    store({ content: 'second' });
    expect(() => amendMemory(db, a.record.id, { content: 'second' })).toThrow(/identical content/);
  });

  it('removes a memory and drops it from search', () => {
    const { record } = store({ content: 'ephemeral finding' });
    expect(removeMemory(db, record.id)).toBe(true);
    expect(queryMemories(db, COL, { text: 'ephemeral' })).toHaveLength(0);
    expect(removeMemory(db, record.id)).toBe(false);
  });
});

describe('export / import (yaml round-trip)', () => {
  it('round-trips into a fresh collection and dedups on re-import', () => {
    store({ content: 'decision one', ticket: 'KODI-1' });
    store({ content: 'a gotcha', type: 'gotcha' });
    const exported = exportMemories(db, COL);
    expect(exported).toHaveLength(2);

    const first = importMemories(db, 'fresh-col', exported);
    expect(first).toEqual({ added: 2, skipped: 0 });
    // preserved provenance
    expect(queryMemories(db, 'fresh-col', { ticket: 'KODI-1' })).toHaveLength(1);
    // re-import is a no-op
    expect(importMemories(db, 'fresh-col', exported)).toEqual({ added: 0, skipped: 2 });
  });

  it('filters by type on export and import', () => {
    store({ content: 'keep me', type: 'gotcha' });
    store({ content: 'skip me', type: 'decision' });
    expect(exportMemories(db, COL, 'gotcha')).toHaveLength(1);
    const all = exportMemories(db, COL);
    expect(importMemories(db, 'typed-col', all, 'gotcha')).toEqual({ added: 1, skipped: 0 });
  });
});

describe('collection identity', () => {
  it('provisions a stable id per root and distinct ids per project', () => {
    const a = provisionCollection(db, '/repos/app', 'app');
    const again = provisionCollection(db, '/repos/app');
    expect(again.collection).toBe(a.collection); // same root → same id
    const b = provisionCollection(db, '/repos/other-app', 'app');
    expect(b.collection).not.toBe(a.collection); // same name, different root
  });

  it('auto-provisions on resolve and is then found by read-only lookup', () => {
    expect(lookupCollection(db, dir)).toBeNull();
    const resolved = resolveCollection(db, dir);
    expect(resolved.collection).toMatch(/-[0-9a-f]{6}$/);
    expect(lookupCollection(db, dir)?.collection).toBe(resolved.collection);
  });
});
