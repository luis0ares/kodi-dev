import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TICKET_STATUSES, type TicketStatus } from '../templates/ticket.js';

/**
 * Internal status-index module — the single code path that owns the
 * `docs/tickets/status.yaml` document (data-model §1, Alternative B; ADR-0001
 * §2.1/§2.2/§2.4). It centralises the two-place edit (index entry + on-disk
 * folder) so a ticket can never end up "indexed in one column but filed under
 * another". Commands are wired to it in a later slice (KODI-004); it is
 * intentionally unused by commands for now.
 *
 * Security posture (guidance pass SR-1..SR-7):
 *  - all paths are validated BEFORE composition and rejected, never sanitised;
 *  - index `file` pointers are resolved with containment inside the tickets root;
 *  - YAML is parsed with the default safe schema (no custom tags/reviver/merge)
 *    and rebuilt into a null-prototype map (no prototype pollution);
 *  - mutating helpers refuse a schema `version` they do not understand;
 *  - writes go through a same-dir temp file cleaned up on failure.
 */

/** Current on-disk schema version (data-model §6 forward-evolution seam). */
export const SCHEMA_VERSION = 1 as const;

/** One placement record in `status.yaml` — column + relative pointer, nothing else. */
export interface StatusIndexEntry {
  /** Authoritative column placement (one of the four statuses). */
  column: TicketStatus;
  /** POSIX-relative pointer `<folder-slug>/<KEY>-<slug>.md` (relative to the tickets root). */
  file: string;
}

/** The Alternative-B `status.yaml` document. */
export interface StatusIndexDocument {
  /** Integer schema version. */
  version: number;
  /** Ordered canonical list of the four status strings (render order + empty-column presence). */
  columns: TicketStatus[];
  /** Flat map keyed by ticket key → placement record. */
  tickets: Record<string, StatusIndexEntry>;
}

/** Shape accepted by {@link upsert}. */
export interface UpsertInput {
  key: string;
  column: TicketStatus;
  slug: string;
}

/** Frozen status → on-disk folder slug map (data-model §3; ADR-0001 §2.1). */
const STATUS_TO_SLUG: Readonly<Record<TicketStatus, string>> = {
  Pending: 'pending',
  'In progress': 'in-progress',
  'To review': 'to-review',
  Done: 'done',
};

/** Inverse of {@link STATUS_TO_SLUG}. */
const SLUG_TO_STATUS: ReadonlyMap<string, TicketStatus> = new Map(
  TICKET_STATUSES.map((status) => [STATUS_TO_SLUG[status], status] as const),
);

/** Frontmatter `key` shape (SR-1). Exported so the legacy-detection guard reuses the same regex. */
export const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
/** Strict kebab-case `slug` (SR-1): no `.`/`/`/`\`, no leading/trailing/double hyphen, non-empty. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A composed `file`: `<folder-slug>/<KEY>-<slug>.md`. */
const FILE_RE = /^([A-Z][A-Z0-9]*-\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/** Folder slug for a status (frozen map). Throws on an unknown status. */
export function slugForStatus(status: TicketStatus): string {
  const slug = STATUS_TO_SLUG[status];
  if (slug === undefined) {
    throw new Error(`unknown ticket status: ${String(status)}`);
  }
  return slug;
}

/** Status for a folder slug (inverse of the frozen map), or `undefined`. */
export function statusForSlug(slug: string): TicketStatus | undefined {
  return SLUG_TO_STATUS.get(slug);
}

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(`invalid ticket key ${JSON.stringify(key)}: must match ${KEY_RE.source}`);
  }
}

function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `invalid slug ${JSON.stringify(slug)}: must be strict kebab-case (${SLUG_RE.source})`,
    );
  }
}

function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

/** A fresh null-prototype tickets map (SR-3: no prototype pollution). */
function freshTickets(): Record<string, StatusIndexEntry> {
  return Object.create(null) as Record<string, StatusIndexEntry>;
}

/**
 * Compose an index `file` pointer from a status + frontmatter `key`/`slug`.
 * SR-1: validates `key` and `slug` BEFORE building the string and throws on any
 * violation (never sanitise-and-continue). Always emits POSIX `/` separators (SR-7).
 */
export function composeFile(status: TicketStatus, key: string, slug: string): string {
  assertKey(key);
  assertSlug(slug);
  return `${slugForStatus(status)}/${key}-${slug}.md`;
}

/** A fresh, empty document (`version: 1`, four columns in frozen order, no tickets). */
export function emptyDocument(): StatusIndexDocument {
  return {
    version: SCHEMA_VERSION,
    columns: [...TICKET_STATUSES],
    tickets: freshTickets(),
  };
}

/**
 * Deterministically serialise a document to a YAML string. Same input → byte-
 * identical output: `tickets` keys are lexicographically sorted on every write,
 * `columns` is emitted in the frozen order, encoding is UTF-8/LF with a trailing
 * newline (data-model §1; SR-7).
 */
export function serialize(doc: StatusIndexDocument): string {
  const tickets: Record<string, StatusIndexEntry> = {};
  for (const key of Object.keys(doc.tickets).sort()) {
    const entry = doc.tickets[key];
    tickets[key] = { column: entry.column, file: entry.file };
  }
  const out = {
    version: doc.version,
    columns: [...TICKET_STATUSES],
    tickets,
  };
  const text = stringifyYaml(out, { lineWidth: 0 });
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Parse a `status.yaml` string with the default safe schema (SR-3: no custom
 * tags/reviver/merge). `tickets` keys are filtered against the key regex (drops
 * `__proto__`/`constructor`/`prototype`) and rebuilt into a null-prototype map;
 * malformed entries are dropped rather than trusted.
 */
export function parse(text: string): StatusIndexDocument {
  const raw: unknown = parseYaml(text);
  const tickets = freshTickets();
  if (raw === null || typeof raw !== 'object') {
    return { version: SCHEMA_VERSION, columns: [...TICKET_STATUSES], tickets };
  }
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === 'number' ? obj.version : SCHEMA_VERSION;

  const rawTickets = obj.tickets;
  if (rawTickets !== null && typeof rawTickets === 'object') {
    for (const [key, value] of Object.entries(rawTickets as Record<string, unknown>)) {
      if (!KEY_RE.test(key)) continue; // SR-3: drops __proto__/constructor/prototype
      if (value === null || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      const { column, file } = entry;
      if (typeof column !== 'string' || typeof file !== 'string') continue;
      if (!isTicketStatus(column)) continue;
      tickets[key] = { column, file };
    }
  }

  return { version, columns: [...TICKET_STATUSES], tickets };
}

/** Load `status.yaml`, or an {@link emptyDocument} when the file is absent. */
export function load(statusYamlPath: string): StatusIndexDocument {
  if (!existsSync(statusYamlPath)) return emptyDocument();
  return parse(readFileSync(statusYamlPath, 'utf-8'));
}

/**
 * Persist a document via temp-then-rename (ADR-0001 §2.4; SR-5). The temp file
 * lives in the destination directory, is written non-world-writable, and is
 * cleaned up if the write or rename fails.
 */
export function save(statusYamlPath: string, doc: StatusIndexDocument): void {
  const dir = dirname(statusYamlPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${statusYamlPath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, serialize(doc), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    renameSync(tmp, statusYamlPath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup; surface the original failure
    }
    throw err;
  }
}

/** SR-4: refuse to mutate a document whose schema version we do not understand. */
function assertMutableVersion(doc: StatusIndexDocument): void {
  if (doc.version !== SCHEMA_VERSION) {
    throw new Error(
      `status.yaml schema version ${doc.version} is unsupported (expected ${SCHEMA_VERSION}); refusing to mutate`,
    );
  }
}

/**
 * Insert or update a ticket's placement, keeping `file` in sync with `column`.
 * Mutates `doc` in place. Validates key/slug via {@link composeFile} (SR-1) and
 * gates on schema version (SR-4).
 */
export function upsert(doc: StatusIndexDocument, input: UpsertInput): void {
  assertMutableVersion(doc);
  const file = composeFile(input.column, input.key, input.slug);
  doc.tickets[input.key] = { column: input.column, file };
}

/** Drop a ticket's placement entry. Mutates `doc` in place. Gates on version (SR-4). */
export function remove(doc: StatusIndexDocument, key: string): void {
  assertMutableVersion(doc);
  delete doc.tickets[key];
}

/**
 * Resolve an index entry's `file` pointer to an absolute path with containment
 * (SR-2). Rejects absolute paths, Windows drive letters, UNC/backslash paths and
 * any `..` segment; asserts the resolved path stays inside the tickets root; and
 * enforces I2 (folder segment equals `slugForStatus(column)`) and I4 (`<KEY>`
 * segment equals the map key). A mismatch is rejected, never repaired.
 */
export function resolveFile(statusYamlPath: string, key: string, entry: StatusIndexEntry): string {
  assertKey(key);
  const file = entry.file;

  if (
    file.length === 0 ||
    isAbsolute(file) ||
    file.includes('\\') || // backslash / UNC
    /^[A-Za-z]:/.test(file) // Windows drive letter
  ) {
    throw new Error(`unsafe index file pointer ${JSON.stringify(file)}`);
  }

  const segments = file.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error(`unsafe index file pointer ${JSON.stringify(file)}`);
  }
  if (segments.length !== 2) {
    throw new Error(`malformed index file pointer ${JSON.stringify(file)}: expected <slug>/<file>`);
  }

  const [folder, filename] = segments;

  // I2 — folder segment must match the slug of the entry's column.
  const expectedSlug = slugForStatus(entry.column);
  if (folder !== expectedSlug) {
    throw new Error(
      `index/folder disagreement for ${key}: file folder ${JSON.stringify(folder)} != slug(${entry.column})=${JSON.stringify(expectedSlug)}`,
    );
  }

  // I4 — filename must be `<KEY>-<slug>.md` with <KEY> equal to the map key.
  const match = FILE_RE.exec(filename);
  if (!match || match[1] !== key) {
    throw new Error(
      `index key mismatch: file ${JSON.stringify(filename)} does not belong to key ${JSON.stringify(key)}`,
    );
  }

  // Containment — resolve against the tickets root and assert we stayed inside it.
  const root = dirname(statusYamlPath);
  const resolved = resolve(root, file);
  const rel = relative(root, resolved);
  const contained =
    resolved === root ||
    (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!contained || !(resolved === root || resolved.startsWith(root + sep))) {
    throw new Error(`index file pointer escapes tickets root: ${JSON.stringify(file)}`);
  }

  return resolved;
}
