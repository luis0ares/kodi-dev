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
  type MemoryStatus,
  type MemoryType,
} from './template.js';
import {
  anyFileChanged,
  hashFile,
  hashFiles,
  parseFileHashes,
  SCORE_FRESH,
  SCORE_MAX,
  SCORE_STALE_CAP,
} from './veracity.js';

/** A resolved project collection: its stable DB key + display name. */
export type Collection = MemoryBinding;

/**
 * Run `fn` inside a single write transaction so the `memories` table and its
 * `memories_fts` index never desync on a mid-write failure. Uses `BEGIN IMMEDIATE`
 * so the write lock is taken up front: with several sessions on the shared DB, a
 * plain deferred `BEGIN` that reads then writes can deadlock on the read→write lock
 * upgrade (which `busy_timeout` cannot resolve), whereas IMMEDIATE just waits for the
 * writer slot. Not nestable — callers must not wrap an already-transactional op.
 */
function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
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

// node:sqlite returns rows as generic `Record<string, SQLOutputValue>`; our columns
// are known, so these two helpers centralize the single unavoidable cast (rather than
// repeating `as unknown as T` at every call site) behind a typed read.
type Bind = string | number;

function queryOne<T>(db: DatabaseSync, sql: string, ...params: Bind[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

function queryAll<T>(db: DatabaseSync, sql: string, ...params: Bind[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
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

/**
 * Idempotently ensure a collection row exists. `ON CONFLICT DO NOTHING` makes this
 * race-safe: two sessions provisioning the same project at once can't collide on the
 * `id` PK or the `root_path` UNIQUE — the loser's insert is simply a no-op.
 */
function ensureCollectionRow(
  db: DatabaseSync,
  id: string,
  name: string,
  root: string | null,
): void {
  db.prepare(
    'INSERT INTO collections (id, name, root_path, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  ).run(id, name, root, new Date().toISOString());
}

/**
 * Provision (or reuse) the collection for a project root, keyed by that root path so
 * it is stable across folder renames of the *display* name and shared by init and
 * the auto-provision path. The id is `<slug>-<shorthash(root)>`.
 *
 * Race-safe: insert-if-absent then read back the winning row by root, so two parallel
 * sessions bootstrapping the same new project converge on one collection (whichever
 * committed first) instead of one throwing a UNIQUE violation.
 */
export function provisionCollection(
  db: DatabaseSync,
  root: string,
  preferredName?: string,
): Collection {
  const name = slug(preferredName ?? basename(root));
  const id = `${name}-${shortHash(root)}`;
  ensureCollectionRow(db, id, name, root);
  const row = queryOne<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM collections WHERE root_path = ?',
    root,
  );
  return row ? { collection: row.id, name: row.name } : { collection: id, name };
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
  const row = queryOne<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM collections WHERE root_path = ?',
    findProjectRoot(cwd),
  );
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
  score: number;
  status: string;
  needs_reverify: number;
  file_hashes: string | null;
  verified_at: string | null;
  tombstone_reason: string | null;
  /** bm25 rank, present only on FTS queries. */
  bm25?: number;
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
    score: r.score,
    status: r.status as MemoryStatus,
    needsReverify: !!r.needs_reverify,
    fileHashes: parseFileHashes(r.file_hashes),
    verifiedAt: r.verified_at ?? null,
    tombstoneReason: r.tombstone_reason ?? null,
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
  /** sha256 of each linked file at insert time. */
  fileHashes: Record<string, string>;
}

/** Insert a fresh row (score = 3, active) + its FTS entry. Assumes no hash collision. */
function rawInsert(db: DatabaseSync, collectionId: string, v: RawInsert): MemoryRecord {
  const id = `mem_${randomUUID().slice(0, 8)}`;
  const fileHashesJson = JSON.stringify(v.fileHashes);
  tx(db, () => {
    db.prepare(
      `INSERT INTO memories
         (id, collection_id, content, title, type, ticket, files_json, created_at, content_hash,
          score, status, needs_reverify, file_hashes, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, NULL)`,
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
      SCORE_FRESH,
      fileHashesJson,
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
    score: SCORE_FRESH,
    status: 'active',
    needsReverify: false,
    fileHashes: v.fileHashes,
    verifiedAt: null,
    tombstoneReason: null,
  };
}

export interface InsertResult {
  record: MemoryRecord;
  /** True when an identical ACTIVE finding already existed (store is a no-op). */
  deduped: boolean;
  /** True when an identical finding was previously TOMBSTONED (re-learn guard blocked it). */
  blocked?: boolean;
}

/**
 * Store a finding. `root` is the project root used to hash the linked files. Deduped by
 * content hash within the collection (idempotent); and if the identical content was
 * previously refuted (tombstoned), the store is BLOCKED — the re-learn guard, so a
 * disproven claim can't be silently re-learned.
 */
export function insertMemory(
  db: DatabaseSync,
  collectionId: string,
  draft: MemoryDraft,
  root: string,
): InsertResult {
  const hash = contentHash(draft.content);
  const existing = queryOne<MemRow>(
    db,
    'SELECT * FROM memories WHERE collection_id = ? AND content_hash = ?',
    collectionId,
    hash,
  );
  if (existing) {
    if (existing.status === 'tombstoned') {
      return { record: rowToRecord(existing), deduped: false, blocked: true };
    }
    return { record: rowToRecord(existing), deduped: true };
  }
  const record = rawInsert(db, collectionId, {
    content: draft.content,
    title: draft.title ?? derivePreview(draft.content),
    type: draft.type,
    ticket: draft.ticket ?? null,
    files: draft.files,
    createdAt: new Date().toISOString(),
    hash,
    fileHashes: hashFiles(root, draft.files),
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

/**
 * Edit a memory in place; returns null when the id is unknown. Editing makes it a NEW
 * claim, so the veracity trust is discarded: score resets to fresh (3), needs-reverify
 * clears, and the file hashes are re-stamped against `root`. `root` hashes the files.
 */
export function amendMemory(
  db: DatabaseSync,
  id: string,
  patch: AmendPatch,
  root: string,
): MemoryRecord | null {
  const cur = queryOne<MemRow>(db, 'SELECT * FROM memories WHERE id = ?', id);
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
    const clash = queryOne<{ id: string }>(
      db,
      'SELECT id FROM memories WHERE collection_id = ? AND content_hash = ? AND id <> ?',
      prev.collection,
      hash,
      id,
    );
    if (clash) {
      throw new Error(
        `another memory (${clash.id}) already has identical content in this project.`,
      );
    }
  }
  const fileHashes = hashFiles(root, files);
  tx(db, () => {
    db.prepare(
      `UPDATE memories SET content=?, title=?, type=?, ticket=?, files_json=?, content_hash=?,
         score=?, needs_reverify=0, file_hashes=?, verified_at=NULL WHERE id=?`,
    ).run(
      content,
      title,
      type,
      ticket,
      JSON.stringify(files),
      hash,
      SCORE_FRESH,
      JSON.stringify(fileHashes),
      id,
    );
    db.prepare('UPDATE memories_fts SET content=?, title=? WHERE memory_id=?').run(
      content,
      title,
      id,
    );
  });
  return {
    ...prev,
    content,
    title,
    type,
    ticket,
    files,
    contentHash: hash,
    score: SCORE_FRESH,
    needsReverify: false,
    fileHashes,
    verifiedAt: null,
  };
}

// ── Veracity: verify, stale-flagging ─────────────────────────────────────────

/**
 * Record the agent's veracity judgment of a memory against its (current) files.
 * `pass` → score +1 (cap 5), clear needs-reverify, re-stamp every file hash, set
 * verified_at. `!pass` → tombstone (score 0, reason, removed from search) so it stops
 * being surfaced and the re-learn guard blocks re-storing it. Returns null if unknown;
 * a no-op (returns the record) if already tombstoned.
 */
export function verifyMemory(
  db: DatabaseSync,
  id: string,
  pass: boolean,
  root: string,
  reason?: string,
): MemoryRecord | null {
  const cur = queryOne<MemRow>(db, 'SELECT * FROM memories WHERE id = ?', id);
  if (!cur) return null;
  const prev = rowToRecord(cur);
  if (prev.status === 'tombstoned') return prev;
  if (pass) {
    const fileHashes = hashFiles(root, prev.files);
    const score = Math.min(SCORE_MAX, prev.score + 1);
    const verifiedAt = new Date().toISOString();
    tx(db, () => {
      db.prepare(
        'UPDATE memories SET score=?, needs_reverify=0, file_hashes=?, verified_at=? WHERE id=?',
      ).run(score, JSON.stringify(fileHashes), verifiedAt, id);
    });
    return { ...prev, score, needsReverify: false, fileHashes, verifiedAt };
  }
  const tombstoneReason = reason ?? 'refuted on verification';
  tx(db, () => {
    db.prepare(
      "UPDATE memories SET status='tombstoned', score=0, needs_reverify=0, tombstone_reason=? WHERE id=?",
    ).run(tombstoneReason, id);
    db.prepare('DELETE FROM memories_fts WHERE memory_id=?').run(id);
  });
  return { ...prev, status: 'tombstoned', score: 0, needsReverify: false, tombstoneReason };
}

/**
 * A file was edited: flag every ACTIVE memory referencing it whose stored hash no
 * longer matches — set needs-reverify, cap score at 2 (out of the inject bands), and
 * re-stamp that file's hash. Returns how many were flagged. Deterministic; the agent
 * does the actual re-judgment later.
 */
export function flagStaleForFile(db: DatabaseSync, root: string, relPath: string): number {
  const rows = queryAll<MemRow>(
    db,
    "SELECT * FROM memories WHERE status='active' AND EXISTS (SELECT 1 FROM json_each(files_json) WHERE value = ?)",
    relPath,
  );
  const current = hashFile(root, relPath);
  let flagged = 0;
  for (const r of rows) {
    const stored = parseFileHashes(r.file_hashes) ?? {};
    if (stored[relPath] === current) continue; // this memory already knows this version
    const merged = { ...stored, [relPath]: current };
    db.prepare('UPDATE memories SET needs_reverify=1, score=?, file_hashes=? WHERE id=?').run(
      Math.min(r.score, SCORE_STALE_CAP),
      JSON.stringify(merged),
      r.id,
    );
    flagged++;
  }
  return flagged;
}

/**
 * Out-of-band safety net (e.g. a git pull the Write hook never saw): scan a
 * collection's active, not-yet-flagged memories and flag any whose files changed.
 */
export function reconcileStale(db: DatabaseSync, root: string, collectionId: string): number {
  const rows = queryAll<MemRow>(
    db,
    "SELECT * FROM memories WHERE collection_id=? AND status='active' AND needs_reverify=0",
    collectionId,
  );
  let flagged = 0;
  for (const r of rows) {
    if (!anyFileChanged(root, parseFileHashes(r.file_hashes))) continue;
    const files = JSON.parse(r.files_json || '[]') as string[];
    db.prepare('UPDATE memories SET needs_reverify=1, score=?, file_hashes=? WHERE id=?').run(
      Math.min(r.score, SCORE_STALE_CAP),
      JSON.stringify(hashFiles(root, files)),
      r.id,
    );
    flagged++;
  }
  return flagged;
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

// Common words carry no signal and only dilute BM25 — drop them from queries.
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'to',
  'of',
  'in',
  'on',
  'and',
  'or',
  'for',
  'with',
  'this',
  'that',
  'it',
  'as',
  'at',
  'by',
  'we',
  'you',
  'do',
  'does',
  'how',
  'why',
  'what',
  'when',
  'from',
  'our',
  'its',
]);

/** Split an identifier into parts: camelCase/PascalCase → words (snake/kebab already split). */
function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/);
}

/**
 * Build a lenient FTS5 query from free text: split identifiers so `renderPrMarkdown`
 * matches memories mentioning "render"/"markdown", drop stopwords, and prefix-match
 * longer terms (`autolink*`) for stem-ish recall. Tokens are alnum-only, so no FTS5
 * operator can be injected. OR keeps recall broad; BM25 does the ranking.
 */
function toFtsQuery(text: string): string | null {
  const tokens = new Set<string>();
  for (const word of text.match(/[A-Za-z0-9]+/g) ?? []) {
    for (const part of splitIdentifier(word)) {
      const t = part.toLowerCase();
      if (t.length < 2 || STOPWORDS.has(t)) continue;
      tokens.add(t);
    }
  }
  if (tokens.size === 0) return null;
  return [...tokens].map((t) => (t.length >= 3 ? `${t}*` : t)).join(' OR ');
}

export interface QueryOpts {
  text?: string;
  type?: MemoryType;
  ticket?: string;
  file?: string;
  since?: string;
  limit?: number;
  /** Minimum veracity score (inclusive) — used to band-gate injection. */
  minScore?: number;
  /** Include tombstoned memories (default false). */
  includeTombstoned?: boolean;
}

/** A search hit: the memory plus its BM25 relevance (separate from its veracity `score`). */
export type QueryHit = MemoryRecord & { bm25?: number };

/**
 * Retrieve within a collection: free-text BM25 match (when `text` given) plus any of
 * the metadata filters, newest-first when there is no text. Excludes tombstoned by
 * default and can band-gate by `minScore`. `limit` defaults to 10.
 */
export function queryMemories(db: DatabaseSync, collectionId: string, opts: QueryOpts): QueryHit[] {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
  const filters = ['m.collection_id = ?'];
  const params: (string | number)[] = [collectionId];
  const addFilter = (clause: string, param: string | number) => {
    filters.push(clause);
    params.push(param);
  };
  if (!opts.includeTombstoned) filters.push("m.status = 'active'");
  if (opts.type) addFilter('m.type = ?', opts.type);
  if (opts.ticket) addFilter('m.ticket = ?', opts.ticket);
  if (opts.minScore != null) addFilter('m.score >= ?', opts.minScore);
  // Match the path against actual array ELEMENTS (json_each), not the raw JSON text,
  // so brackets/quotes/other paths can't cause a false hit — but still a substring so
  // a basename or partial path matches.
  if (opts.file)
    addFilter(
      'EXISTS (SELECT 1 FROM json_each(m.files_json) WHERE value LIKE ?)',
      `%${opts.file}%`,
    );
  if (opts.since) addFilter('m.created_at >= ?', opts.since);

  const fts = opts.text ? toFtsQuery(opts.text) : null;
  if (fts) {
    // Weight the title column above content (memory_id is UNINDEXED → weight 0). Pull a
    // pool of the strongest BM25 matches, then re-rank in JS with a gentle recency
    // penalty so a newer, equally-relevant memory wins — text relevance still dominates.
    // NB: alias is `bm25`, NOT `score` — `score` is now the veracity column on m.*.
    const pool = Math.max(limit * 3, 30);
    const sql = `SELECT m.*, bm25(memories_fts, 0.0, 1.0, 2.0) AS bm25
      FROM memories_fts f JOIN memories m ON m.id = f.memory_id
      WHERE memories_fts MATCH ? AND ${filters.join(' AND ')}
      ORDER BY bm25 ASC LIMIT ?`;
    const rows = queryAll<MemRow>(db, sql, fts, ...params, pool);
    const now = Date.now();
    return rows
      .map((r) => {
        const ageDays = Math.max(0, (now - Date.parse(r.created_at)) / 86_400_000);
        return { r, blended: (r.bm25 ?? 0) + 0.03 * ageDays };
      })
      .sort((a, b) => a.blended - b.blended)
      .slice(0, limit)
      .map(({ r }) => ({ ...rowToRecord(r), bm25: r.bm25 }));
  }
  // rowid (insertion order) breaks created_at ties so "newest-first" is deterministic
  // even for inserts that land in the same millisecond.
  const sql = `SELECT m.* FROM memories m WHERE ${filters.join(' AND ')} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`;
  return queryAll<MemRow>(db, sql, ...params, limit).map(rowToRecord);
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
  // Export only ACTIVE memories — tombstoned (refuted) knowledge must not travel to
  // another store where it would re-import as fresh, defeating the refutation.
  const rows = type
    ? queryAll<MemRow>(
        db,
        "SELECT * FROM memories WHERE collection_id = ? AND status='active' AND type = ? ORDER BY created_at ASC",
        collectionId,
        type,
      )
    : queryAll<MemRow>(
        db,
        "SELECT * FROM memories WHERE collection_id = ? AND status='active' ORDER BY created_at ASC",
        collectionId,
      );
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
  root: string,
  type?: MemoryType,
): ImportResult {
  let added = 0;
  let skipped = 0;
  for (const r of records) {
    if (type && r.type !== type) continue;
    const hash = contentHash(r.content);
    // Skip both an existing active dupe AND a tombstoned match (re-learn guard).
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
      fileHashes: hashFiles(root, r.files),
    });
    added++;
  }
  return { added, skipped };
}
