import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseVulnerabilities, parseVulnFile } from '../src/commands/hook.js';
import { openDb } from '../src/memory/db.js';
import {
  amendMemory,
  exportMemories,
  flagStaleForFile,
  importMemories,
  insertMemory,
  lookupCollection,
  provisionCollection,
  queryMemories,
  recentMemories,
  removeMemory,
  resolveCollection,
  verifyMemory,
} from '../src/memory/store.js';
import { contentHash, MemoryDraftSchema } from '../src/memory/template.js';
import { SCORE_STALE_CAP } from '../src/memory/veracity.js';

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

/** Store a memory (every memory needs a file now); `dir` is the hashing root. */
function store(over: Record<string, unknown> = {}, col = COL) {
  return insertMemory(
    db,
    col,
    MemoryDraftSchema.parse({ content: 'x', type: 'decision', files: ['src/x.ts'], ...over }),
    dir,
  );
}

/** Write a real file under the temp project root (so it can be hashed / changed). */
function writeFile(rel: string, content: string) {
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

describe('memory template', () => {
  it('validates and defaults a draft', () => {
    const d = MemoryDraftSchema.parse({
      content: '  a finding  ',
      type: 'gotcha',
      files: ['a.ts'],
    });
    expect(d.content).toBe('a finding'); // trimmed
    expect(d.ticket).toBeNull();
    expect(d.files).toEqual(['a.ts']);
  });

  it('rejects empty content, bad type, and NO files', () => {
    expect(
      MemoryDraftSchema.safeParse({ content: '', type: 'gotcha', files: ['a.ts'] }).success,
    ).toBe(false);
    expect(
      MemoryDraftSchema.safeParse({ content: 'x', type: 'nope', files: ['a.ts'] }).success,
    ).toBe(false);
    expect(MemoryDraftSchema.safeParse({ content: 'x', type: 'gotcha', files: [] }).success).toBe(
      false,
    );
  });

  it('content hash ignores surrounding whitespace', () => {
    expect(contentHash('  hi  ')).toBe(contentHash('hi'));
  });
});

describe('store + dedup', () => {
  it('stores at fresh score 3, dedups identical, separates distinct', () => {
    const a = store({ content: 'alpha finding' });
    expect(a.deduped).toBe(false);
    expect(a.record.score).toBe(3);
    expect(a.record.status).toBe('active');
    const again = store({ content: 'alpha finding' });
    expect(again.deduped).toBe(true);
    expect(again.record.id).toBe(a.record.id);
    const b = store({ content: 'beta finding' });
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

  it('returns hits with veracity score + separate bm25 relevance', () => {
    const hits = queryMemories(db, COL, { text: 'autolink refs' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('autolink');
    expect(hits[0].score).toBe(3); // veracity
    expect(typeof hits[0].bm25).toBe('number'); // relevance
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
    expect(recentMemories(db, COL, 5)[0].content).toContain('unrelated note');
  });
});

describe('amend + rm', () => {
  it('amends fields, resets score to 3, keeps FTS in sync', () => {
    const { record } = store({ content: 'old wording about caching' });
    verifyMemory(db, record.id, true, dir); // score 4
    const updated = amendMemory(
      db,
      record.id,
      { content: 'new wording about throttling', type: 'gotcha' },
      dir,
    );
    expect(updated?.type).toBe('gotcha');
    expect(updated?.score).toBe(3); // reset by the edit
    expect(queryMemories(db, COL, { text: 'throttling' })).toHaveLength(1);
    expect(queryMemories(db, COL, { text: 'caching' })).toHaveLength(0);
  });

  it('returns null for an unknown id and rejects a dedup collision', () => {
    expect(amendMemory(db, 'mem_nope', { type: 'gotcha' }, dir)).toBeNull();
    const a = store({ content: 'first' });
    store({ content: 'second' });
    expect(() => amendMemory(db, a.record.id, { content: 'second' }, dir)).toThrow(
      /identical content/,
    );
  });

  it('removes a memory and drops it from search', () => {
    const { record } = store({ content: 'ephemeral finding' });
    expect(removeMemory(db, record.id)).toBe(true);
    expect(queryMemories(db, COL, { text: 'ephemeral' })).toHaveLength(0);
    expect(removeMemory(db, record.id)).toBe(false);
  });
});

describe('veracity loop', () => {
  it('verify --pass raises score (cap 5); --fail tombstones + blocks re-learning', () => {
    const { record } = store({ content: 'verify me' });
    expect(verifyMemory(db, record.id, true, dir)?.score).toBe(4);
    expect(verifyMemory(db, record.id, true, dir)?.score).toBe(5);
    expect(verifyMemory(db, record.id, true, dir)?.score).toBe(5); // capped

    const b = store({ content: 'wrong finding', files: ['src/y.ts'] });
    const t = verifyMemory(db, b.record.id, false, dir, 'code says otherwise');
    expect(t?.status).toBe('tombstoned');
    expect(t?.tombstoneReason).toBe('code says otherwise');
    expect(queryMemories(db, COL, { text: 'wrong finding' })).toHaveLength(0); // out of search
    // re-learn guard: storing the identical disproven content is blocked
    const re = store({ content: 'wrong finding', files: ['src/y.ts'] });
    expect(re.blocked).toBe(true);
  });

  it('a file edit flags linked memories needs-reverify and caps score at 2', () => {
    writeFile('src/db.ts', 'export const A = 1;');
    const { record } = store({ content: 'A is 1', files: ['src/db.ts'] });
    verifyMemory(db, record.id, true, dir);
    verifyMemory(db, record.id, true, dir); // score 5
    writeFile('src/db.ts', 'export const A = 2;'); // change it out from under the memory
    expect(flagStaleForFile(db, dir, 'src/db.ts')).toBe(1);
    const m = queryMemories(db, COL, { limit: 50 }).find((x) => x.id === record.id)!;
    expect(m.needsReverify).toBe(true);
    expect(m.score).toBe(SCORE_STALE_CAP); // 2 — dropped out of the inject bands
  });

  it('band-gates injection by minScore', () => {
    const a = store({ content: 'still fresh' }); // 3
    const b = store({ content: 'proven finding', files: ['src/z.ts'] });
    verifyMemory(db, b.record.id, true, dir); // 4
    expect(queryMemories(db, COL, { minScore: 4 }).map((h) => h.id)).toEqual([b.record.id]);
    expect(queryMemories(db, COL, { minScore: 3 })).toHaveLength(2);
    expect(a.record.score).toBe(3);
  });
});

describe('export / import (yaml round-trip)', () => {
  it('round-trips (fresh score), dedups on re-import, excludes tombstoned', () => {
    store({ content: 'decision one', ticket: 'KODI-1' });
    const drop = store({ content: 'a gotcha', type: 'gotcha' });
    verifyMemory(db, drop.record.id, false, dir); // tombstone → excluded from export
    const exported = exportMemories(db, COL);
    expect(exported.map((m) => m.content)).toEqual(['decision one']);

    expect(importMemories(db, 'fresh-col', exported, dir)).toEqual({ added: 1, skipped: 0 });
    expect(queryMemories(db, 'fresh-col', { ticket: 'KODI-1' })[0].score).toBe(3);
    expect(importMemories(db, 'fresh-col', exported, dir)).toEqual({ added: 0, skipped: 1 });
  });

  it('filters by type on export and import', () => {
    store({ content: 'keep me', type: 'gotcha' });
    store({ content: 'skip me', type: 'decision' });
    expect(exportMemories(db, COL, 'gotcha')).toHaveLength(1);
    const all = exportMemories(db, COL);
    expect(importMemories(db, 'typed-col', all, dir, 'gotcha')).toEqual({ added: 1, skipped: 0 });
  });
});

describe('retrieval quality', () => {
  it('splits identifiers so camelCase queries match word-level content', () => {
    store({ content: 'the pull request markdown renderer escapes hash refs' });
    expect(queryMemories(db, COL, { text: 'renderPrMarkdown' })).toHaveLength(1);
  });

  it('prefix-matches longer terms for stem-ish recall', () => {
    store({ content: 'this documents the autolinking behavior of GitHub' });
    expect(queryMemories(db, COL, { text: 'autolink' })).toHaveLength(1);
  });

  it('blends recency so a newer equally-relevant memory ranks first', () => {
    const older = store({ content: 'caching strategy notes', title: 'caching' });
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(
      '2020-01-01T00:00:00.000Z',
      older.record.id,
    );
    const newer = store({ content: 'caching strategy revisited', title: 'caching' });
    expect(queryMemories(db, COL, { text: 'caching strategy' })[0].id).toBe(newer.record.id);
  });

  it('matches --file against real array elements, not JSON structure', () => {
    store({ content: 'touches pr', files: ['src/templates/pr.ts'] });
    store({ content: 'touches other', files: ['src/other.ts'] });
    expect(queryMemories(db, COL, { file: 'templates/pr.ts' })).toHaveLength(1);
    expect(queryMemories(db, COL, { file: '","' })).toHaveLength(0);
  });
});

describe('concurrency (shared DB, parallel sessions)', () => {
  it('provisions the same collection from two connections without collision', () => {
    const db2 = openDb(join(dir, 'rag.db'));
    try {
      const a = provisionCollection(db, '/repos/shared', 'shared');
      const b = provisionCollection(db2, '/repos/shared', 'shared');
      expect(b.collection).toBe(a.collection);
      const rows = db
        .prepare('SELECT COUNT(*) AS n FROM collections WHERE root_path = ?')
        .get('/repos/shared') as unknown as { n: number };
      expect(rows.n).toBe(1);
    } finally {
      db2.close();
    }
  });

  it('sees a second connection’s committed writes (WAL)', () => {
    const db2 = openDb(join(dir, 'rag.db'));
    try {
      insertMemory(
        db2,
        COL,
        MemoryDraftSchema.parse({
          content: 'written by session two',
          type: 'gotcha',
          files: ['a.ts'],
        }),
        dir,
      );
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
  });

  it('extracts the report path from a vulnerability string (the required file)', () => {
    expect(parseVulnFile('CRITICAL — SQLi (docs/security/a.md)')).toBe('docs/security/a.md');
    expect(parseVulnFile('a finding with no path')).toBeNull();
  });
});

describe('collection identity', () => {
  it('provisions a stable id per root and distinct ids per project', () => {
    const a = provisionCollection(db, '/repos/app', 'app');
    expect(provisionCollection(db, '/repos/app').collection).toBe(a.collection);
    expect(provisionCollection(db, '/repos/other-app', 'app').collection).not.toBe(a.collection);
  });

  it('auto-provisions on resolve and is then found by read-only lookup', () => {
    expect(lookupCollection(db, dir)).toBeNull();
    const resolved = resolveCollection(db, dir);
    expect(resolved.collection).toMatch(/-[0-9a-f]{6}$/);
    expect(lookupCollection(db, dir)?.collection).toBe(resolved.collection);
  });
});
