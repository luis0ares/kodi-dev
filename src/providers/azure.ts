import { execRead, execMutate } from '../exec.js';
import { mdToHtml } from '../html.js';
import {
  renderTicketMarkdown,
  slugify,
  TicketSchema,
  type StoredTicket,
  type Ticket,
  type TicketStatus,
} from '../templates/ticket.js';
import type { ReadyResult, StartProvenance, TicketProvider, TicketRef } from './types.js';

/**
 * Azure DevOps Boards ticket provider. Work-items are tickets; the canonical
 * ticket record rides in the HTML description as a `<!-- kodi:ticket … -->`
 * marker so it round-trips losslessly. Status maps to System.BoardColumn. All
 * `az` calls are proxied here; mutations respect dry-run.
 */

const MARKER_RE = /<!--\s*kodi:ticket\s+(\{[\s\S]*?\})\s*-->/;

export const STATUS_COLUMN: Record<TicketStatus, string> = {
  Pending: 'AI Generated',
  'In progress': 'In Progress',
  'To review': 'To Review',
  Done: 'Done',
  Blocked: 'AI Generated',
};

/** Build the HTML description (human body + hidden canonical marker). */
export function descriptionHtml(t: StoredTicket): string {
  const canonical = JSON.stringify({ ...t, key: undefined });
  return `${mdToHtml(renderTicketMarkdown(t))}\n<!-- kodi:ticket ${canonical} -->`;
}

/** Reconstruct a stored ticket from a work-item's id, column, and description. */
export function parseWorkItem(fields: Record<string, any>, id: number): StoredTicket | null {
  const desc: string = fields['System.Description'] ?? '';
  const m = MARKER_RE.exec(desc);
  if (!m) return null;
  const parsed = TicketSchema.safeParse(JSON.parse(m[1]));
  if (!parsed.success) return null;
  const column: string = fields['System.BoardColumn'] ?? '';
  const status =
    (Object.entries(STATUS_COLUMN).find(([, c]) => c === column)?.[0] as TicketStatus) ??
    parsed.data.status;
  return { ...parsed.data, key: String(id), slug: parsed.data.slug ?? slugify(parsed.data.title), status };
}

export function createArgs(
  coords: { organization?: string; project?: string },
  title: string,
  html: string,
  column: string,
): string[] {
  const args = [
    'az', 'boards', 'work-item', 'create',
    '--title', title, '--type', 'Issue',
    '--fields', `System.BoardColumn=${column}`, '--description', html,
    '--output', 'json',
  ];
  if (coords.organization) args.push('--organization', coords.organization);
  if (coords.project) args.push('--project', coords.project);
  return args;
}

export class AzureTicketProvider implements TicketProvider {
  readonly name = 'azure';
  constructor(
    private readonly opts: {
      organization?: string;
      project?: string;
      dryRun: boolean;
      cwd?: string;
    },
  ) {}

  private coords() {
    return { organization: this.opts.organization, project: this.opts.project };
  }

  private orgArgs(): string[] {
    return this.opts.organization ? ['--organization', this.opts.organization] : [];
  }

  async nextId(): Promise<string> {
    return '(assigned by azure on create)';
  }

  async create(input: Ticket): Promise<StoredTicket> {
    const slug = input.slug ?? slugify(input.title);
    const draft: StoredTicket = { ...input, key: '(pending)', slug };
    const html = descriptionHtml(draft);
    const res = execMutate(
      createArgs(this.coords(), input.title, html, STATUS_COLUMN[input.status]),
      this.opts.dryRun,
    );
    if (!res.ran) return { ...draft, key: '(dry-run)' };
    const id = JSON.parse(res.stdout).id;
    return { ...draft, key: String(id) };
  }

  async get(key: string): Promise<StoredTicket | null> {
    const out = execRead(['az', 'boards', 'work-item', 'show', '--id', key, '--output', 'json', ...this.orgArgs()]);
    const wi = JSON.parse(out);
    return parseWorkItem(wi.fields ?? {}, wi.id);
  }

  async list(): Promise<TicketRef[]> {
    const wiql =
      'SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = \'Issue\' ORDER BY [System.Id]';
    const out = execRead(['az', 'boards', 'query', '--wiql', wiql, '--output', 'json', ...this.orgArgs()]);
    const rows: any[] = JSON.parse(out);
    const refs: TicketRef[] = [];
    for (const row of rows) {
      const id = row.id ?? row.fields?.['System.Id'];
      if (id == null) continue;
      const t = await this.get(String(id));
      if (t) refs.push(toRef(t));
    }
    return refs;
  }

  async listReady(): Promise<ReadyResult> {
    const all = await this.list();
    const done = new Set(all.filter((t) => t.status === 'Done').map((t) => t.key));
    const ready: TicketRef[] = [];
    const blocked: ReadyResult['blocked'] = [];
    for (const t of all) {
      if (t.status !== 'Pending') continue;
      const unmet = t.dependencies.filter((d) => !done.has(d));
      if (unmet.length === 0) ready.push(t);
      else blocked.push({ ticket: t, blockedBy: unmet });
    }
    return { ready, blocked };
  }

  async setStatus(key: string, status: TicketStatus): Promise<StoredTicket> {
    const current = await this.get(key);
    if (!current) throw new Error(`work-item ${key} not found`);
    execMutate(
      ['az', 'boards', 'work-item', 'update', '--id', key, '--fields', `System.BoardColumn=${STATUS_COLUMN[status]}`, ...this.orgArgs()],
      this.opts.dryRun,
    );
    return { ...current, status };
  }

  async start(key: string, _p: StartProvenance): Promise<StoredTicket> {
    return this.setStatus(key, 'In progress');
  }

  async amend(key: string, patch: Partial<Ticket>): Promise<StoredTicket> {
    const current = await this.get(key);
    if (!current) throw new Error(`work-item ${key} not found`);
    const merged: StoredTicket = { ...current, ...patch, key, slug: current.slug };
    const fields = [`System.Description=${descriptionHtml(merged)}`];
    if (patch.title) fields.push(`System.Title=${patch.title}`);
    const args = ['az', 'boards', 'work-item', 'update', '--id', key];
    for (const f of fields) args.push('--fields', f);
    execMutate([...args, ...this.orgArgs()], this.opts.dryRun);
    return merged;
  }

  async delete(key: string): Promise<void> {
    execMutate(['az', 'boards', 'work-item', 'delete', '--id', key, '--yes', ...this.orgArgs()], this.opts.dryRun);
  }
}

function toRef(t: StoredTicket): TicketRef {
  return { key: t.key, title: t.title, status: t.status, slug: t.slug, dependencies: t.dependencies };
}
