import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  findProjectRoot,
  loadBoardConfig,
  writeMemoryBinding,
  type MemoryBinding,
} from '../config.js';
import {
  contentHash,
  derivePreview,
  type MemoryDraft,
  type MemoryImportRecord,
  type MemoryRecord,
  type MemoryType,
} from './template.js';

/** A resolved project collection: its stable DB key + display name. */
export type Collection = MemoryBinding;

/**
 * Run `fn` inside a single transaction so the `memories` table and its `memories_fts`
 * index never desync on a mid-write failure. Not nestable — callers must not wrap an
 * already-transactional op.
 */
function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback failure; surface the original error */
    }
    throw e;
  }
}

// ── Collection identity ──────────────────────────────────────────────────────

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  );
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 6);
}

function ensureCollectionRow(
  db: DatabaseSync,
  id: string,
  name: string,
  root: string | null,
): void {
  const existing = db.prepare('SELECT id FROM collections WHERE id = ?').get(id);
  if (existing) return;
  db.prepare('INSERT INTO collections (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    root,
    new Date().toISOString(),
  );
}

/**
 * Provision (or reuse) the collection for a project root, keyed by that root path so
 * it is stable across folder renames of the *display* name and shared by init and
 * the auto-provision path. The id is `<slug>-<shorthash(root)>`.
 */
export function provisionCollection(
  db: DatabaseSync,
  root: string,
  preferredName?: string,
): Collection {
  const existing = db
    .prepare('SELECT id, name FROM collections WHERE root_path = ?')
    .get(root) as unknown as { id: string; name: string } | undefined;
  if (existing) return { collection: existing.id, name: existing.name };
  const name = slug(preferredName ?? basename(root));
  const id = `${name}-${shortHash(root)}`;
  ensureCollectionRow(db, id, name, root);
  return { collection: id, name };
}

/**
 * Resolve the collection for the current working dir. Order: (1) the explicit
 * `memory:` binding in `kodi-dev.yaml`; (2) the global registry keyed by project
 * root; (3) provision a fresh one and write the binding back into `kodi-dev.yaml`
 * when that file exists. Every path converges on the same id for a given root.
 */
export function resolveCollection(db: DatabaseSync, cwd: string = process.cwd()): Collection {
  const root = findProjectRoot(cwd);
  const cfg = loadBoardConfig(cwd);
  if (cfg.memory?.collection) {
    const name = cfg.memory.name ?? cfg.memory.collection;
    ensureCollectionRow(db, cfg.memory.collection, name, root);
    return { collection: cfg.memory.collection, name };
  }
  const provisioned = provisionCollection(db, root);
  writeMemoryBinding(root, provisioned);
  return provisioned;
}

/**
 * Read-only collection lookup: the `memory:` binding, else the root-path registry,
 * else null. Unlike {@link resolveCollection} it never provisions or writes — used by
 * the SessionStart hook, which must have no side effects.
 */
export function lookupCollection(db: DatabaseSync, cwd: string = process.cwd()): Collection | null {
  const cfg = loadBoardConfig(cwd);
  if (cfg.memory?.collection) {
    return { collection: cfg.memory.collection, name: cfg.memory.name ?? cfg.memory.collection };
  }
  const row = db
    .prepare('SELECT id, name FROM collections WHERE root_path = ?')
    .get(findProjectRoot(cwd)) as unknown as { id: string; name: string } | undefined;
  return row ? { collection: row.id, name: row.name } : null;
}

// ── Row mapping ──────────────────────────────────────────────────────────────

interface MemRow {
  id: string;
  collection_id: string;
  content: string;
  title: string;
  type: string;
  ticket: string | null;
  files_json: string;
  created_at: string;
  content_hash: string;
  score?: number;
}

function rowToRecord(r: MemRow): MemoryRecord {
  return {
    id: r.id,
    collection: r.collection_id,
    content: r.content,
    title: r.title,
    type: r.type as MemoryType,
    ticket: r.ticket ?? null,
    files: JSON.parse(r.files_json || '[]') as string[],
    createdAt: r.created_at,
    contentHash: r.content_hash,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

interface RawInsert {
  content: string;
  title: string;
  type: MemoryType;
  ticket: string | null;
  files: string[];
  createdAt: string;
  hash: string;
}

/** Insert a fully-formed row + its FTS entry. Assumes no existing hash collision. */
function rawInsert(db: DatabaseSync, collectionId: string, v: RawInsert): MemoryRecord {
  const id = `mem_${randomUUID().slice(0, 8)}`;
  tx(db, () => {
    db.prepare(
      `INSERT INTO memories
         (id, collection_id, content, title, type, ticket, files_json, created_at, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      collectionId,
      v.content,
      v.title,
      v.type,
      v.ticket,
      JSON.stringify(v.files),
      v.createdAt,
      v.hash,
    );
    db.prepare('INSERT INTO memories_fts (memory_id, content, title) VALUES (?, ?, ?)').run(
      id,
      v.content,
      v.title,
    );
  });
  return {
    id,
    collection: collectionId,
    content: v.content,
    title: v.title,
    type: v.type,
    ticket: v.ticket,
    files: v.files,
    createdAt: v.createdAt,
    contentHash: v.hash,
  };
}

export interface InsertResult {
  record: MemoryRecord;
  /** True when an identical finding already existed (store is a no-op). */
  deduped: boolean;
}

/** Store a finding, deduped by content hash within the collection (idempotent). */
export function insertMemory(
  db: DatabaseSync,
  collectionId: string,
  draft: MemoryDraft,
): InsertResult {
  const hash = contentHash(draft.content);
  const existing = db
    .prepare('SELECT * FROM memories WHERE collection_id = ? AND content_hash = ?')
    .get(collectionId, hash) as unknown as MemRow | undefined;
  if (existing) return { record: rowToRecord(existing), deduped: true };
  const record = rawInsert(db, collectionId, {
    content: draft.content,
    title: draft.title ?? derivePreview(draft.content),
    type: draft.type,
    ticket: draft.ticket ?? null,
    files: draft.files,
    createdAt: new Date().toISOString(),
    hash,
  });
  return { record, deduped: false };
}

export interface AmendPatch {
  content?: string;
  type?: MemoryType;
  ticket?: string | null;
  files?: string[];
  title?: string;
}

/** Edit a memory in place; returns null when the id is unknown. */
export function amendMemory(db: DatabaseSync, id: string, patch: AmendPatch): MemoryRecord | null {
  const cur = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as
    MemRow | undefined;
  if (!cur) return null;
  const prev = rowToRecord(cur);
  const content = patch.content ?? prev.content;
  const title = patch.title ?? (patch.content ? derivePreview(patch.content) : prev.title);
  const type = patch.type ?? prev.type;
  const ticket = patch.ticket !== undefined ? patch.ticket : prev.ticket;
  const files = patch.files ?? prev.files;
  const hash = contentHash(content);
  // Guard the collection's dedup invariant up front with a clear message, rather
  // than letting the UNIQUE(collection_id, content_hash) constraint throw raw.
  if (hash !== prev.contentHash) {
    const clash = db
      .prepare('SELECT id FROM memories WHERE collection_id = ? AND content_hash = ? AND id <> ?')
      .get(prev.collection, hash, id) as unknown as { id: string } | undefined;
    if (clash) {
      throw new Error(
        `another memory (${clash.id}) already has identical content in this project.`,
      );
    }
  }
  tx(db, () => {
    db.prepare(
      'UPDATE memories SET content=?, title=?, type=?, ticket=?, files_json=?, content_hash=? WHERE id=?',
    ).run(content, title, type, ticket, JSON.stringify(files), hash, id);
    db.prepare('UPDATE memories_fts SET content=?, title=? WHERE memory_id=?').run(
      content,
      title,
      id,
    );
  });
  return { ...prev, content, title, type, ticket, files, contentHash: hash };
}

/** Delete a memory; returns false when the id is unknown. */
export function removeMemory(db: DatabaseSync, id: string): boolean {
  return tx(db, () => {
    const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id);
    return Number(info.changes) > 0;
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Turn free text into a lenient FTS5 OR-query (punctuation stripped). */
function toFtsQuery(text: string): string | null {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export interface QueryOpts {
  text?: string;
  type?: MemoryType;
  ticket?: string;
  file?: string;
  since?: string;
  limit?: number;
}

export type QueryHit = MemoryRecord & { score?: number };

/**
 * Retrieve within a collection: free-text BM25 match (when `text` given) plus any
 * of the metadata filters, newest-first when there is no text. `limit` defaults to 10.
 */
export function queryMemories(db: DatabaseSync, collectionId: string, opts: QueryOpts): QueryHit[] {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
  const filters = ['m.collection_id = ?'];
  const params: (string | number)[] = [collectionId];
  if (opts.type) (filters.push('m.type = ?'), params.push(opts.type));
  if (opts.ticket) (filters.push('m.ticket = ?'), params.push(opts.ticket));
  if (opts.file) (filters.push('m.files_json LIKE ?'), params.push(`%${opts.file}%`));
  if (opts.since) (filters.push('m.created_at >= ?'), params.push(opts.since));

  const fts = opts.text ? toFtsQuery(opts.text) : null;
  if (fts) {
    const sql = `SELECT m.*, bm25(memories_fts) AS score
      FROM memories_fts f JOIN memories m ON m.id = f.memory_id
      WHERE memories_fts MATCH ? AND ${filters.join(' AND ')}
      ORDER BY score ASC LIMIT ?`;
    const rows = db.prepare(sql).all(fts, ...params, limit) as unknown as MemRow[];
    return rows.map((r) => ({ ...rowToRecord(r), score: r.score }));
  }
  const sql = `SELECT m.* FROM memories m WHERE ${filters.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`;
  return (db.prepare(sql).all(...params, limit) as unknown as MemRow[]).map(rowToRecord);
}

/** The N most recent memories in a collection (for the session-start digest). */
export function recentMemories(db: DatabaseSync, collectionId: string, limit = 5): MemoryRecord[] {
  return queryMemories(db, collectionId, { limit });
}

// ── Export / import (YAML) ───────────────────────────────────────────────────

/** All records in a collection (optionally one type), oldest-first for a stable file. */
export function exportMemories(
  db: DatabaseSync,
  collectionId: string,
  type?: MemoryType,
): MemoryRecord[] {
  const sql = type
    ? 'SELECT * FROM memories WHERE collection_id = ? AND type = ? ORDER BY created_at ASC'
    : 'SELECT * FROM memories WHERE collection_id = ? ORDER BY created_at ASC';
  const rows = (type
    ? db.prepare(sql).all(collectionId, type)
    : db.prepare(sql).all(collectionId)) as unknown as MemRow[];
  return rows.map(rowToRecord);
}

export interface ImportResult {
  added: number;
  skipped: number;
}

/**
 * Import records into the CURRENT collection, deduped by content hash (re-importing
 * the same file is a no-op). Original `createdAt` is preserved when present; id and
 * contentHash are (re)owned by us. An optional `type` filter limits what is imported.
 */
export function importMemories(
  db: DatabaseSync,
  collectionId: string,
  records: MemoryImportRecord[],
  type?: MemoryType,
): ImportResult {
  let added = 0;
  let skipped = 0;
  for (const r of records) {
    if (type && r.type !== type) continue;
    const hash = contentHash(r.content);
    const dupe = db
      .prepare('SELECT id FROM memories WHERE collection_id = ? AND content_hash = ?')
      .get(collectionId, hash);
    if (dupe) {
      skipped++;
      continue;
    }
    rawInsert(db, collectionId, {
      content: r.content,
      title: r.title ?? derivePreview(r.content),
      type: r.type,
      ticket: r.ticket ?? null,
      files: r.files,
      createdAt: r.createdAt ?? new Date().toISOString(),
      hash,
    });
    added++;
  }
  return { added, skipped };
}
