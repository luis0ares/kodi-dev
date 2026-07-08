import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { localPaths } from '../config.js';
import {
  renderTicketMarkdown,
  slugify,
  TICKET_STATUSES,
  TicketSchema,
  type StoredTicket,
  type Ticket,
  type TicketStatus,
} from '../templates/ticket.js';
import {
  composeFile,
  emptyDocument,
  KEY_RE,
  load,
  remove,
  resolveFile,
  save,
  upsert,
  type StatusIndexEntry,
} from './status-index.js';
import type { ReadyResult, StartProvenance, TicketProvider, TicketRef } from './types.js';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Retired legacy layout folders (ADR-0001 §2.2). These are NOT part of
 * {@link localPaths}; they exist only as the target of the clean-start detection
 * guard (KODI-006 / data-model §5). Fixed names — never attacker-controlled.
 */
const LEGACY_FOLDERS = ['backlog', 'done'] as const;

/** Ticket-shaped filename gate (data-model §5), anchored, applied to the basename only. */
const LEGACY_FILENAME_RE = /^[A-Z][A-Z0-9]*-\d+-.*\.md$/;

/** Structured refusal payload emitted on both the human and `--json` surfaces. */
export interface LegacyDataReport {
  ok: false;
  reason: 'legacy-data-present';
  /** Which of the fixed legacy folder names (`backlog`/`done`) are present. */
  folders: string[];
  /** Confirmed ticket-shaped file count at short-circuit (>= 1). */
  ticketCount: number;
}

/**
 * Hard-stop, non-destructive clean-start refusal (ADR-0001 §2.6; data-model §5).
 * Thrown by {@link LocalTicketProvider} before any scaffold write when a legacy
 * `backlog/`/`done/` layout with ticket-shaped files is detected. Carries a
 * structured {@link LegacyDataReport} for the `--json` surface and a fixed-string
 * human message (no attacker-controlled data interpolated — SR-J). The command
 * layer catches it, renders both surfaces via `out()`, and exits non-zero.
 */
export class LegacyDataError extends Error {
  readonly report: LegacyDataReport;

  constructor(folders: string[], ticketCount: number) {
    super(
      `legacy ticket data present under docs/tickets/{${folders.join(', ')}} ` +
        `(${ticketCount} ticket-shaped file(s)); clean-start refuses to migrate`,
    );
    this.name = 'LegacyDataError';
    this.report = { ok: false, reason: 'legacy-data-present', folders: [...folders], ticketCount };
  }
}

/**
 * Local markdown ticket provider. Placement is owned by the authoritative
 * `docs/tickets/status.yaml` index (data-model §1, Alternative B); each ticket
 * markdown file lives under the folder for its status (`<slug>/<KEY>-<slug>.md`,
 * data-model §2/§3). The index is the source of truth for a ticket's column
 * (index-wins, §4); the file's frontmatter `status` is a mirrored value kept in
 * sync on every transition. All reads/enumeration are index-driven and all
 * writes follow the temp-then-rename, index-committed-last protocol (ADR-0001
 * §2.4).
 */
export class LocalTicketProvider implements TicketProvider {
  readonly name = 'local';
  private readonly prefix: string;
  private readonly paths: ReturnType<typeof localPaths>;

  constructor(prefix: string, cwd = process.cwd()) {
    this.prefix = prefix;
    this.paths = localPaths(cwd);
  }

  /**
   * Lazy idempotent scaffold (R-003, ADR-0001 §2.3): ensure `status.yaml` and
   * the five status folders exist. A valid pre-existing `status.yaml`
   * short-circuits the fresh-index write, so re-running never duplicates or
   * corrupts an existing index. `mkdirSync({recursive:true})` is itself
   * idempotent for the folders.
   */
  private scaffold() {
    // Clean-start guard (KODI-006, ADR-0001 §2.6 / data-model §5): detect a
    // pre-existing legacy backlog/done layout and HARD-STOP before any write. It
    // is synchronous and runs at the very top so nothing is scaffolded on the
    // abort path (SR-A/SR-I).
    this.detectLegacyData();
    if (!existsSync(this.paths.statusYaml)) {
      save(this.paths.statusYaml, emptyDocument());
    }
    for (const status of TICKET_STATUSES) {
      mkdirSync(this.paths.folderFor(status), { recursive: true });
    }
  }

  /**
   * Evaluate the data-model §5 legacy predicate and throw {@link LegacyDataError}
   * when it holds — non-destructively, before any scaffold write:
   *
   *   legacyPresent := !exists(status.yaml)
   *     AND (exists(backlog/) OR exists(done/))
   *     AND countTicketShapedMd(backlog/, done/) >= 1
   *
   * Security posture (guidance pass): zero writes on this path (SR-A); FAILS SAFE
   * — any error while *determining* presence aborts-and-reports rather than
   * falling through to scaffold writes (SR-B); a per-file parse/read failure is a
   * legitimate "not ticket-shaped" and never crashes (SR-C). It short-circuits at
   * the first confirmed ticket-shaped file (SR-H).
   */
  private detectLegacyData(): void {
    // SR-F: single consistent status.yaml gate — the same path the scaffold
    // short-circuit uses. A valid/adopted model skips the check entirely.
    if (existsSync(this.paths.statusYaml)) return;

    // Gate 2: which legacy folders are present, classified safely (SR-E).
    const states = LEGACY_FOLDERS.map((name) => ({ name, state: this.legacyDirState(name) }));
    const present = states.filter((s) => s.state !== 'absent');
    if (present.length === 0) return; // neither backlog/ nor done/ → predicate false → proceed
    const folders = present.map((s) => s.name);

    // SR-B/SR-E: a legacy folder we cannot safely enumerate (symlink, stat/perm
    // failure) means we cannot rule out legacy data → fail safe to abort.
    if (present.some((s) => s.state === 'unsafe')) {
      throw new LegacyDataError(folders, 1);
    }

    // Gate 3: countTicketShapedMd >= 1, short-circuiting at the first hit (SR-H).
    for (const { name, state } of states) {
      if (state !== 'dir') continue;
      const dir = join(this.paths.root, name);
      let entries: Dirent[];
      try {
        // SR-E: enumerate with dirents; count REGULAR FILES only, never follow symlinks.
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // SR-B: cannot enumerate → cannot determine presence → fail safe to abort.
        throw new LegacyDataError(folders, 1);
      }
      for (const dirent of entries) {
        if (!dirent.isFile()) continue; // SR-E: regular files only (skip dirs/symlinks)
        if (!LEGACY_FILENAME_RE.test(dirent.name)) continue; // filename gate, basename, anchored
        if (legacyFileHasKey(join(dir, dirent.name))) {
          throw new LegacyDataError(folders, 1); // SR-H: first confirmed ticket → stop
        }
      }
    }
    // Legacy folder(s) exist but hold no ticket-shaped md → not legacy → proceed
    // (data-model §5 edge case: empty / stray non-ticket files).
  }

  /**
   * Classify a candidate legacy folder without following symlinks (SR-E). Uses
   * `lstat` so a symlinked `backlog/`/`done/` is flagged `unsafe` (never followed
   * out of tree); a missing folder is `absent`; a stat/permission failure is
   * `unsafe` (SR-B fail-safe); a real directory is `dir`.
   */
  private legacyDirState(name: string): 'absent' | 'dir' | 'unsafe' {
    const dir = join(this.paths.root, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      return 'unsafe';
    }
    if (st.isSymbolicLink()) return 'unsafe';
    if (!st.isDirectory()) return 'absent'; // a non-dir entry named backlog/done is not the folder
    return 'dir';
  }

  private parseFile(path: string): StoredTicket | null {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
    const m = FRONTMATTER.exec(raw);
    if (!m) return null;
    const meta = parseYaml(m[1]) ?? {};
    const parsed = TicketSchema.safeParse(meta);
    if (!parsed.success || !parsed.data.key || !parsed.data.slug) return null;
    return parsed.data as StoredTicket;
  }

  /**
   * Resolve a ticket through the index (index-wins). Returns the absolute file
   * path, the index entry (authoritative column), and the parsed ticket, or
   * null when the key is not indexed / the pointer does not resolve.
   */
  private locate(
    key: string,
  ): { path: string; entry: StatusIndexEntry; ticket: StoredTicket } | null {
    const doc = load(this.paths.statusYaml);
    const entry = doc.tickets[key];
    if (!entry) return null;
    let path: string;
    try {
      path = resolveFile(this.paths.statusYaml, key, entry);
    } catch {
      return null;
    }
    const ticket = this.parseFile(path);
    if (!ticket) return null;
    return { path, entry, ticket };
  }

  /**
   * Write a ticket markdown file for its `ticket.status` column: render the body
   * (frontmatter `status` mirrors the column) and land it via a random-suffixed,
   * exclusively-opened temp file IN THE SAME target folder, then an intra-folder
   * atomic rename over the final `<KEY>-<slug>.md` (ADR-0001 §2.4; SR-4/SR-5).
   * Returns the final absolute path. `sortTicket()` output is byte-identical to
   * the previous model (R-005).
   */
  private writeTicketFile(ticket: StoredTicket): string {
    const dir = this.paths.folderFor(ticket.status);
    mkdirSync(dir, { recursive: true });
    // SR-1: never trust the caller's key/slug — route them through composeFile's
    // assertKey/assertSlug validation and take the basename for the final filename.
    const finalName = basename(composeFile(ticket.status, ticket.key, ticket.slug));
    const finalPath = join(dir, finalName);
    const body =
      `---\n${stringifyYaml(sortTicket(ticket)).trimEnd()}\n---\n\n` + renderTicketMarkdown(ticket);
    const tmp = join(dir, `.${finalName}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, body, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      renameSync(tmp, finalPath);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best-effort cleanup; surface the original failure
      }
      throw err;
    }
    return finalPath;
  }

  /** Index-driven enumeration: one ref per `status.yaml` entry, column-authoritative. */
  private collectRefs(): TicketRef[] {
    const doc = load(this.paths.statusYaml);
    const refs: TicketRef[] = [];
    for (const [key, entry] of Object.entries(doc.tickets)) {
      let path: string;
      try {
        path = resolveFile(this.paths.statusYaml, key, entry);
      } catch {
        continue; // keep enumeration coherent + non-crashing on a bad pointer
      }
      const t = this.parseFile(path);
      if (t) refs.push(toRef({ ...t, status: entry.column }));
    }
    return refs.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  }

  async nextId(prefix = this.prefix): Promise<string> {
    const doc = load(this.paths.statusYaml);
    let max = 0;
    for (const key of Object.keys(doc.tickets)) {
      const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(key);
      if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
    }
    return `${prefix}-${String(max + 1).padStart(3, '0')}`;
  }

  async create(input: Ticket): Promise<StoredTicket> {
    this.scaffold();
    const key = input.key ?? (await this.nextId(this.prefix));
    // dedupe via the authoritative index
    if (load(this.paths.statusYaml).tickets[key]) {
      throw new Error(`ticket ${key} already exists`);
    }
    const slug = input.slug ?? slugify(input.title);
    const ticket: StoredTicket = { ...input, key, slug };
    // file lands first via rename; index committed last (ADR-0001 §2.4)
    this.writeTicketFile(ticket);
    const doc = load(this.paths.statusYaml);
    upsert(doc, { key, column: ticket.status, slug });
    save(this.paths.statusYaml, doc);
    return ticket;
  }

  async get(key: string): Promise<StoredTicket | null> {
    const found = this.locate(key);
    if (!found) return null;
    // index-wins: the index column is authoritative, frontmatter may be stale
    return { ...found.ticket, status: found.entry.column };
  }

  async list(): Promise<TicketRef[]> {
    return this.collectRefs();
  }

  async listReady(): Promise<ReadyResult> {
    const all = await this.list();
    const doneKeys = new Set(all.filter((t) => t.status === 'Done').map((t) => t.key));
    const ready: TicketRef[] = [];
    const blocked: ReadyResult['blocked'] = [];
    for (const t of all) {
      if (t.status !== 'Pending') continue;
      const unmet = t.dependencies.filter((d) => !doneKeys.has(d));
      if (unmet.length === 0) ready.push(t);
      else blocked.push({ ticket: t, blockedBy: unmet });
    }
    return { ready, blocked };
  }

  async setStatus(key: string, status: TicketStatus): Promise<StoredTicket> {
    const found = this.locate(key);
    if (!found) throw new Error(`ticket ${key} not found`);
    const oldPath = found.path;
    const ticket: StoredTicket = { ...found.ticket, status };
    // destination file first, then index commit, then drop the old file
    const newPath = this.writeTicketFile(ticket);
    const doc = load(this.paths.statusYaml);
    upsert(doc, { key, column: status, slug: ticket.slug });
    save(this.paths.statusYaml, doc);
    if (oldPath !== newPath) unlinkSync(oldPath);
    return ticket;
  }

  async start(key: string, _provenance: StartProvenance): Promise<StoredTicket> {
    return this.setStatus(key, 'In progress');
  }

  async amend(key: string, patch: Partial<Ticket>): Promise<StoredTicket> {
    const found = this.locate(key);
    if (!found) throw new Error(`ticket ${key} not found`);
    // column is unchanged by amend (index-wins); never change key/slug
    const column = found.entry.column;
    const ticket: StoredTicket = {
      ...found.ticket,
      ...patch,
      key,
      slug: found.ticket.slug,
      status: column,
    };
    // same folder → rename-over; index upsert is idempotent
    this.writeTicketFile(ticket);
    const doc = load(this.paths.statusYaml);
    upsert(doc, { key, column, slug: ticket.slug });
    save(this.paths.statusYaml, doc);
    return ticket;
  }

  async delete(key: string): Promise<void> {
    const found = this.locate(key);
    if (!found) throw new Error(`ticket ${key} not found`);
    // index committed first (stops advertising the ticket), then unlink the file
    const doc = load(this.paths.statusYaml);
    remove(doc, key);
    save(this.paths.statusYaml, doc);
    unlinkSync(found.path);
  }
}

/**
 * Ticket-shaped frontmatter test for the legacy guard (data-model §5): the file
 * parses with a frontmatter `key` matching {@link KEY_RE}. Deliberately NOT
 * `parseFile`/`TicketSchema.safeParse` — that under-counts and would be a bypass
 * (SR-D). Parses the frontmatter with the default SAFE yaml schema (no custom
 * tags/reviver/merge) WRAPPED in try/catch, and treats any read/parse failure as
 * "not ticket-shaped" rather than crashing (SR-C) — distinct from a directory
 * enumeration failure, which fails safe to abort in {@link LocalTicketProvider}.
 */
function legacyFileHasKey(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return false; // per-file read error → not ticket-shaped (must not crash)
  }
  const m = FRONTMATTER.exec(raw); // reuse the existing frontmatter regex (SR-G)
  if (!m) return false;
  let meta: unknown;
  try {
    meta = parseYaml(m[1]); // SR-C: default safe schema; wrapped (parseFile does NOT wrap)
  } catch {
    return false; // malformed frontmatter → not ticket-shaped, not a crash
  }
  if (meta === null || typeof meta !== 'object') return false;
  const key = (meta as Record<string, unknown>).key;
  return typeof key === 'string' && KEY_RE.test(key); // SR-D: `key` present + matches KEY_RE
}

function toRef(t: StoredTicket): TicketRef {
  return {
    key: t.key,
    title: t.title,
    status: t.status,
    slug: t.slug,
    dependencies: t.dependencies,
  };
}

/** Stable field ordering for readable frontmatter. */
function sortTicket(t: StoredTicket) {
  return {
    key: t.key,
    title: t.title,
    slug: t.slug,
    status: t.status,
    dependencies: t.dependencies,
    drivers: t.drivers,
    summary: t.summary,
    acceptanceCriteria: t.acceptanceCriteria,
    nonGoals: t.nonGoals,
    ...(t.prUrl ? { prUrl: t.prUrl } : {}),
    ...(t.notes ? { notes: t.notes } : {}),
  };
}
