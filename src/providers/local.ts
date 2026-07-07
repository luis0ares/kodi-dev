import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
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
    // legacy-detection insertion point (KODI-006): a detect-and-report guard for
    // pre-existing backlog/done data goes at the very top here, BEFORE any folder
    // or status.yaml write. Intentionally not implemented in this slice.
    if (!existsSync(this.paths.statusYaml)) {
      save(this.paths.statusYaml, emptyDocument());
    }
    for (const status of TICKET_STATUSES) {
      mkdirSync(this.paths.folderFor(status), { recursive: true });
    }
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
    this.writeIndex();
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
    this.writeIndex();
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
    this.writeIndex();
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
    this.writeIndex();
  }

  /**
   * Regenerate the human-readable `tickets.md` table from the index-driven
   * enumeration. Kept coherent + non-crashing; its retirement is a separate
   * downstream slice (ADR-0001 §2.5, KODI-005).
   */
  private writeIndex() {
    const refs = this.collectRefs();
    const lines = ['# Tickets', '', '| Key | Title | Status | Depends on |', '|---|---|---|---|'];
    for (const t of refs) {
      lines.push(`| ${t.key} | ${t.title} | ${t.status} | ${t.dependencies.join(', ') || '—'} |`);
    }
    lines.push('');
    writeFileSync(this.paths.index, lines.join('\n'), 'utf-8');
  }
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
