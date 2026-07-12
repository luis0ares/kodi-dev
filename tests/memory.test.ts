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
import { parseVulnerabilities } from '../src/commands/hook.js';
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

describe('retrieval quality', () => {
  it('splits identifiers so camelCase queries match word-level content', () => {
    store({ content: 'the pull request markdown renderer escapes hash refs' });
    // "renderPrMarkdown" → render / pr / markdown, so it matches despite no literal token
    const hits = queryMemories(db, COL, { text: 'renderPrMarkdown' });
    expect(hits).toHaveLength(1);
  });

  it('prefix-matches longer terms for stem-ish recall', () => {
    store({ content: 'this documents the autolinking behavior of GitHub' });
    expect(queryMemories(db, COL, { text: 'autolink' })).toHaveLength(1); // autolink* ~ autolinking
  });

  it('blends recency so a newer equally-relevant memory ranks first', () => {
    const older = store({ content: 'caching strategy notes', title: 'caching' });
    // force an older timestamp on the first row
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(
      '2020-01-01T00:00:00.000Z',
      older.record.id,
    );
    const newer = store({ content: 'caching strategy revisited', title: 'caching' });
    const hits = queryMemories(db, COL, { text: 'caching strategy' });
    expect(hits[0].id).toBe(newer.record.id);
  });

  it('matches --file against real array elements, not JSON structure', () => {
    store({ content: 'touches pr', files: ['src/templates/pr.ts'] });
    store({ content: 'touches other', files: ['src/other.ts'] });
    expect(queryMemories(db, COL, { file: 'templates/pr.ts' })).toHaveLength(1);
    // a fragment that only appears as JSON punctuation must not match
    expect(queryMemories(db, COL, { file: '","' })).toHaveLength(0);
  });
});

describe('concurrency (shared DB, parallel sessions)', () => {
  it('provisions the same collection from two connections without collision', () => {
    const db2 = openDb(join(dir, 'rag.db'));
    try {
      const a = provisionCollection(db, '/repos/shared', 'shared');
      const b = provisionCollection(db2, '/repos/shared', 'shared'); // second session, same root
      expect(b.collection).toBe(a.collection); // converge, no UNIQUE throw
      const rows = db
        .prepare('SELECT COUNT(*) AS n FROM collections WHERE root_path = ?')
        .get('/repos/shared') as unknown as { n: number };
      expect(rows.n).toBe(1);
    } finally {
      db2.close();
    }
  });

  it('sees a second connection’s committed writes (WAL) and keeps the FTS index consistent', () => {
    const db2 = openDb(join(dir, 'rag.db'));
    try {
      insertMemory(
        db2,
        COL,
        MemoryDraftSchema.parse({ content: 'written by session two', type: 'gotcha' }),
      );
      // the first connection can immediately query the other session's committed row
      expect(queryMemories(db, COL, { text: 'session two' })).toHaveLength(1);
    } finally {
      db2.close();
    }
  });
});

describe('PostToolUse capture parsing', () => {
  it('extracts --vulnerability values (quoted/unquoted) only from `kodi pr create`', () => {
    const cmd =
      'kodi pr create --title x --vulnerability "CRITICAL — SQLi (docs/security/a.md)" ' +
      "--vulnerability 'HIGH — authz (docs/security/b.md)' --source f --target main";
    expect(parseVulnerabilities(cmd)).toEqual([
      'CRITICAL — SQLi (docs/security/a.md)',
      'HIGH — authz (docs/security/b.md)',
    ]);
  });

  it('captures nothing for non-pr-create commands or when no --vulnerability is present', () => {
    expect(parseVulnerabilities('kodi tickets list --json')).toEqual([]);
    expect(parseVulnerabilities('kodi pr create --title x --source f --target main')).toEqual([]);
    expect(parseVulnerabilities('echo --vulnerability "not a kodi pr"')).toEqual([]);
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
