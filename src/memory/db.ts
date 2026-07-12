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
  UNIQUE(collection_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_memories_collection ON memories(collection_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  content,
  title
);
`;

/**
 * Open the memory DB (creating its directory and schema if needed) and return the
 * handle. Callers own the handle and should `close()` it when done. Defaults to the
 * shared {@link ragDbPath}; tests pass an explicit path under a temp `$KODI_HOME`.
 */
export function openDb(path: string = ragDbPath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new nodeSqlite.DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Tolerate brief lock contention when several agents touch the shared DB at once.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}
