import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { localPaths } from '../config.js';
import {
  renderTicketMarkdown,
  slugify,
  TicketSchema,
  type StoredTicket,
  type Ticket,
  type TicketStatus,
} from '../templates/ticket.js';
import type {
  ReadyResult,
  StartProvenance,
  TicketProvider,
  TicketRef,
} from './types.js';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Local markdown ticket provider. Each ticket is one file under
 * `docs/tickets/backlog/<KEY>-<slug>.md` (or `done/` when Done). The YAML
 * frontmatter is the canonical machine-readable record; the markdown body is a
 * rendered human view regenerated from it on every write.
 */
export class LocalTicketProvider implements TicketProvider {
  readonly name = 'local';
  private readonly prefix: string;
  private readonly paths: ReturnType<typeof localPaths>;

  constructor(prefix: string, cwd = process.cwd()) {
    this.prefix = prefix;
    this.paths = localPaths(cwd);
  }

  private ensureDirs() {
    mkdirSync(this.paths.backlog, { recursive: true });
    mkdirSync(this.paths.done, { recursive: true });
  }

  private fileName(t: { key: string; slug: string }) {
    return `${t.key}-${t.slug}.md`;
  }

  /** Directory a ticket file lives in for a given status. */
  private dirFor(status: TicketStatus) {
    return status === 'Done' ? this.paths.done : this.paths.backlog;
  }

  private allFiles(): Array<{ dir: string; file: string }> {
    const out: Array<{ dir: string; file: string }> = [];
    for (const dir of [this.paths.backlog, this.paths.done]) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.md')) out.push({ dir, file });
      }
    }
    return out;
  }

  private parseFile(dir: string, file: string): StoredTicket | null {
    const raw = readFileSync(join(dir, file), 'utf-8');
    const m = FRONTMATTER.exec(raw);
    if (!m) return null;
    const meta = parseYaml(m[1]) ?? {};
    const parsed = TicketSchema.safeParse(meta);
    if (!parsed.success || !parsed.data.key || !parsed.data.slug) return null;
    return parsed.data as StoredTicket;
  }

  private locate(key: string): { dir: string; file: string; ticket: StoredTicket } | null {
    for (const { dir, file } of this.allFiles()) {
      const ticket = this.parseFile(dir, file);
      if (ticket && ticket.key === key) return { dir, file, ticket };
    }
    return null;
  }

  private persist(ticket: StoredTicket) {
    this.ensureDirs();
    const existing = this.locate(ticket.key);
    if (existing) rmSync(join(existing.dir, existing.file));
    const dir = this.dirFor(ticket.status);
    const body =
      `---\n${stringifyYaml(sortTicket(ticket)).trimEnd()}\n---\n\n` +
      renderTicketMarkdown(ticket);
    writeFileSync(join(dir, this.fileName(ticket)), body, 'utf-8');
    this.writeIndex();
  }

  async nextId(prefix = this.prefix): Promise<string> {
    let max = 0;
    for (const { dir, file } of this.allFiles()) {
      const t = this.parseFile(dir, file);
      if (!t) continue;
      const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(t.key);
      if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
    }
    return `${prefix}-${String(max + 1).padStart(3, '0')}`;
  }

  async create(input: Ticket): Promise<StoredTicket> {
    const key = input.key ?? (await this.nextId(this.prefix));
    if (this.locate(key)) throw new Error(`ticket ${key} already exists`);
    const slug = input.slug ?? slugify(input.title);
    const ticket: StoredTicket = { ...input, key, slug };
    this.persist(ticket);
    return ticket;
  }

  async get(key: string): Promise<StoredTicket | null> {
    return this.locate(key)?.ticket ?? null;
  }

  async list(): Promise<TicketRef[]> {
    const refs: TicketRef[] = [];
    for (const { dir, file } of this.allFiles()) {
      const t = this.parseFile(dir, file);
      if (t) refs.push(toRef(t));
    }
    return refs.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
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
    const ticket = { ...found.ticket, status };
    this.persist(ticket);
    return ticket;
  }

  async start(key: string, _provenance: StartProvenance): Promise<StoredTicket> {
    return this.setStatus(key, 'In progress');
  }

  async amend(key: string, patch: Partial<Ticket>): Promise<StoredTicket> {
    const found = this.locate(key);
    if (!found) throw new Error(`ticket ${key} not found`);
    const ticket: StoredTicket = { ...found.ticket, ...patch, key, slug: found.ticket.slug };
    this.persist(ticket);
    return ticket;
  }

  async delete(key: string): Promise<void> {
    const found = this.locate(key);
    if (!found) throw new Error(`ticket ${key} not found`);
    rmSync(join(found.dir, found.file));
    this.writeIndex();
  }

  private writeIndex() {
    const refs: TicketRef[] = [];
    for (const { dir, file } of this.allFiles()) {
      const t = this.parseFile(dir, file);
      if (t) refs.push(toRef(t));
    }
    refs.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const lines = ['# Tickets', '', '| Key | Title | Status | Depends on |', '|---|---|---|---|'];
    for (const t of refs) {
      lines.push(`| ${t.key} | ${t.title} | ${t.status} | ${t.dependencies.join(', ') || '—'} |`);
    }
    lines.push('');
    writeFileSync(this.paths.index, lines.join('\n'), 'utf-8');
  }
}

function toRef(t: StoredTicket): TicketRef {
  return { key: t.key, title: t.title, status: t.status, slug: t.slug, dependencies: t.dependencies };
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
