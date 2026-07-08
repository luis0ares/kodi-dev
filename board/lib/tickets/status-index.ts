// Board-local `status.yaml` reader + containment resolver (Alternative B).
//
// This RE-IMPLEMENTS the CLI's `src/providers/status-index.ts` posture
// (`parse` + `resolveFile`) independently — the board is a separate project with
// its own deps and MUST NOT import across packages (ADR-0002 §2.6). It is
// READ-ONLY (R-014/SR-6): only `readFileSync`/`statSync`/`realpathSync` here.
//
// Anchors: data-model §1 (Alternative-B shape), §2 (path base = dir containing
// status.yaml = KODI_TICKETS_DIR), §3 (folder slugs), §4 (index-wins),
// invariants I2/I4. Security: SR-1 (path containment), SR-2 (symlink-out escape),
// SR-4 (safe YAML + null-proto), SR-8 (size cap).

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { TICKET_STATUSES, type TicketStatus } from './types';

/** SR-8: cap any single read (status.yaml or a ticket file) to a sane size. */
export const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB

/** Frontmatter/index `key` shape (SR-1/SR-4 key filter). */
export const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/** A composed filename: `<KEY>-<slug>.md` (data-model §2; I4). */
const FILE_RE = /^([A-Z][A-Z0-9]*-\d+)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** SR-4: prototype-pollution keys never survive the rebuild. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Frozen status → on-disk folder slug map (data-model §3). Board's own copy. */
const STATUS_TO_SLUG: Readonly<Record<TicketStatus, string>> = {
  Pending: 'pending',
  'In progress': 'in-progress',
  'To review': 'to-review',
  Done: 'done',
};

/** One placement record — column + relative pointer, nothing else (§1). */
export interface StatusIndexEntry {
  column: TicketStatus;
  file: string;
}

/** The parsed index: only the flat `tickets` map is consumed by the board. */
export interface StatusIndex {
  tickets: Record<string, StatusIndexEntry>;
}

function slugForStatus(status: TicketStatus): string {
  return STATUS_TO_SLUG[status];
}

function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

/** A fresh null-prototype map (SR-4: no prototype pollution). */
function freshTickets(): Record<string, StatusIndexEntry> {
  return Object.create(null) as Record<string, StatusIndexEntry>;
}

/**
 * Safe-parse a `status.yaml` string (SR-4). Uses the `yaml` DEFAULT/core schema
 * — no custom tags, no reviver, no merge keys (`merge` is off by default in
 * yaml v2). The `tickets` map is rebuilt into a null-prototype object; keys are
 * filtered against {@link KEY_RE} (which also drops `__proto__`/`constructor`/
 * `prototype`), and each entry is kept ONLY when it has a string `file` and a
 * `column` that is one of the four canonical statuses (data-model §4: a card is
 * only placeable when its index column is valid). Malformed entries are dropped,
 * never trusted. Absent/empty/non-object input → an empty index (ADR-0002 §2.5).
 */
export function safeParseStatusIndex(text: string): StatusIndex {
  const tickets = freshTickets();
  const raw: unknown = parseYaml(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tickets };
  }

  const rawTickets = (raw as Record<string, unknown>).tickets;
  if (rawTickets === null || typeof rawTickets !== 'object' || Array.isArray(rawTickets)) {
    return { tickets };
  }

  for (const [key, value] of Object.entries(rawTickets as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) continue; // SR-4
    if (!KEY_RE.test(key)) continue; // SR-4: only real ticket keys survive
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const column = entry.column;
    const file = entry.file;
    if (typeof column !== 'string' || typeof file !== 'string') continue;
    if (!isTicketStatus(column)) continue; // drop unknown-column entries
    // Explicit two-field pick — the index carries ONLY column + file (§1).
    tickets[key] = { column, file };
  }

  return { tickets };
}

/**
 * Resolve an index entry's `file` pointer to a REAL absolute path, contained
 * inside the tickets root. Throws (→ caller degrades the card, SR-3) on any
 * violation — pointers are REJECTED, never sanitised.
 *
 * SR-1 (lexical containment): rejects an empty pointer, an absolute path, a
 * Windows drive letter (`X:`), any backslash/UNC, any `..`/empty split segment,
 * and anything that is not exactly the two-segment `<folder-slug>/<KEY>-<slug>.md`
 * shape. Enforces I2 (folder segment === slug(column)) and I4 (`<KEY>` segment ===
 * map key). Then resolves against `root` and asserts containment BOUNDARY-SAFELY
 * (`path.relative` non-`..` check AND `=== root || startsWith(root + sep)` — never
 * a bare `startsWith(root)`).
 *
 * SR-2 (symlink-out escape): after lexical containment passes, `realpathSync` the
 * resolved file and re-assert the REAL path is inside `realRoot` (the caller's
 * pre-realpathed root). Done BEFORE the file's bytes are read. If `realpathSync`
 * throws (missing target / ELOOP) the error propagates — the card degrades and we
 * NEVER fall back to the lexical path.
 *
 * @param root     the tickets root as given (KODI_TICKETS_DIR).
 * @param realRoot `realpathSync(root)`, computed once by the caller.
 */
export function resolveContainedFile(
  root: string,
  realRoot: string,
  key: string,
  entry: StatusIndexEntry,
): string {
  if (!KEY_RE.test(key)) {
    throw new Error('invalid ticket key');
  }

  const file = entry.file;
  if (
    file.length === 0 ||
    isAbsolute(file) ||
    file.includes('\\') || // backslash / UNC
    /^[A-Za-z]:/.test(file) // Windows drive letter
  ) {
    throw new Error('unsafe index file pointer');
  }

  const segments = file.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error('unsafe index file pointer');
  }
  if (segments.length !== 2) {
    throw new Error('malformed index file pointer: expected <slug>/<file>');
  }

  const [folder, filename] = segments;

  // I2 — folder segment must equal slug(entry.column).
  if (folder !== slugForStatus(entry.column)) {
    throw new Error('index/folder disagreement');
  }

  // I4 — filename must be `<KEY>-<slug>.md` with <KEY> === the map key.
  const match = FILE_RE.exec(filename);
  if (!match || match[1] !== key) {
    throw new Error('index key mismatch');
  }

  // SR-1 lexical containment (boundary-safe, not a bare startsWith).
  const resolved = resolve(root, file);
  const rel = relative(root, resolved);
  const lexicallyContained =
    (resolved === root ||
      (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) &&
    (resolved === root || resolved.startsWith(root + sep));
  if (!lexicallyContained) {
    throw new Error('index file pointer escapes tickets root');
  }

  // SR-2 symlink-out containment. Throws (→ degrade) if the target is missing or
  // an ELOOP; we deliberately do NOT catch here so no lexical fallback happens.
  const realResolved = realpathSync(resolved);
  const realContained =
    realResolved === realRoot || realResolved.startsWith(realRoot + sep);
  if (!realContained) {
    throw new Error('index file pointer escapes tickets root via symlink');
  }

  return realResolved;
}
