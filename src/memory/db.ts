import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ragDbPath } from '../config.js';

// node:sqlite is newer than the bundler's builtin list, and marking it `external`
// still rewrites the specifier to a bare `sqlite` package. Loading it through
// createRequire with a NON-LITERAL id defeats that static rewrite, so the runtime
// import stays `node:sqlite`. (The type above is erased — `import type` only.)
const nodeRequire = createRequire(import.meta.url);
const nodeSqlite = nodeRequire(['node', 'sqlite'].join(':')) as typeof import('node:sqlite');

/**
 * The memory store is a single SQLite database (Node's built-in `node:sqlite`,
 * FTS5 included — no native module, no external service). It lives OUTSIDE any
 * repo (see {@link ragDbPath}) and is partitioned into one collection per project.
 *
 * The FTS table is a standalone index carrying `memory_id` so it can be kept in
 * sync explicitly on insert/amend/remove — simpler and more predictable than
 * external-content triggers.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  root_path  TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  content      TEXT NOT NULL,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL,
  ticket       TEXT,
  files_json   TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  -- veracity score (see docs/memory-veracity-score.md): 0-5, fresh = 3.
  score            INTEGER NOT NULL DEFAULT 3,
  status           TEXT NOT NULL DEFAULT 'active',   -- active | tombstoned
  needs_reverify   INTEGER NOT NULL DEFAULT 0,
  file_hashes      TEXT,                              -- JSON { path: sha256 }
  verified_at      TEXT,
  tombstone_reason TEXT,
  UNIQUE(collection_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_memories_collection ON memories(collection_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  content,
  title
);
`;

/** Veracity columns added after v1; ALTER them onto a pre-existing memories table. */
const VERACITY_COLUMNS: Array<[name: string, ddl: string]> = [
  ['score', 'INTEGER NOT NULL DEFAULT 3'],
  ['status', "TEXT NOT NULL DEFAULT 'active'"],
  ['needs_reverify', 'INTEGER NOT NULL DEFAULT 0'],
  ['file_hashes', 'TEXT'],
  ['verified_at', 'TEXT'],
  ['tombstone_reason', 'TEXT'],
];

/** Bring a pre-v2 memories table up to the veracity schema (idempotent). */
function migrate(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA table_info(memories)').all() as unknown as Array<{
    name: string;
  }>;
  const cols = new Set(rows.map((c) => c.name));
  for (const [name, ddl] of VERACITY_COLUMNS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${ddl}`);
  }
}

/**
 * Open the memory DB (creating its directory and schema if needed) and return the
 * handle. Callers own the handle and should `close()` it when done. Defaults to the
 * shared {@link ragDbPath}; tests pass an explicit path under a temp `$KODI_HOME`.
 */
export function openDb(path: string = ragDbPath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new nodeSqlite.DatabaseSync(path);
  // Arm busy_timeout FIRST: it makes SQLite wait (its own timed retry) for a lock
  // instead of throwing SQLITE_BUSY. It must precede the WAL switch and the schema
  // DDL below, since those take write locks and, under many parallel sessions
  // opening at once, would otherwise throw before any wait is configured.
  db.exec('PRAGMA busy_timeout = 5000;');
  // WAL lets many sessions read while one writes; NORMAL sync is safe under WAL and
  // much faster. Together with BEGIN IMMEDIATE (see store `tx`) this is what makes
  // the shared ~/.kodi DB safe across parallel sessions.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
