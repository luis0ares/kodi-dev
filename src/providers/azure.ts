import type { ColumnMap } from '../config.js';
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
 * Azure DevOps Boards ticket provider. Tickets are ALWAYS created as Issue
 * work-items; the canonical ticket record rides base64-encoded inside a <pre> in
 * the description (Azure strips HTML comments) so it round-trips losslessly.
 * Status maps to System.State via the column map discovered by `kodi init` (for
 * the Basic process, state names == board column names). All `az` calls are
 * proxied here; mutations respect dry-run.
 */

// Azure sanitizes rich-text descriptions and STRIPS HTML comments, so the
// canonical record is stored base64-encoded inside a <pre> (which survives).
const MARKER_RE = /kodi:ticket:([A-Za-z0-9+/=]+)/;

/** Fallback column names when the state file has none yet. */
export const DEFAULT_COLUMNS: ColumnMap = {
  todo: 'To Do',
  inProgress: 'In Progress',
  toReview: 'To Review',
  done: 'Done',
};

/** Board column a status maps to (new/Pending issues land in the todo column). */
export function columnForStatus(status: TicketStatus, cols: ColumnMap): string {
  switch (status) {
    case 'In progress':
      return cols.inProgress ?? DEFAULT_COLUMNS.inProgress!;
    case 'To review':
      return cols.toReview ?? DEFAULT_COLUMNS.toReview!;
    case 'Done':
      return cols.done ?? DEFAULT_COLUMNS.done!;
    default:
      return cols.todo;
  }
}

/** Inverse mapping: a board column back to a ticket status. */
export function statusFromColumn(column: string, cols: ColumnMap): TicketStatus | undefined {
  if (column === cols.todo) return 'Pending';
  if (column === (cols.inProgress ?? DEFAULT_COLUMNS.inProgress)) return 'In progress';
  if (column === (cols.toReview ?? DEFAULT_COLUMNS.toReview)) return 'To review';
  if (column === (cols.done ?? DEFAULT_COLUMNS.done)) return 'Done';
  return undefined;
}

/** Build the HTML description (human body + base64 canonical marker in a <pre>). */
export function descriptionHtml(t: StoredTicket): string {
  const canonical = Buffer.from(JSON.stringify({ ...t, key: undefined })).toString('base64');
  return `${mdToHtml(renderTicketMarkdown(t))}\n<pre>kodi:ticket:${canonical}</pre>`;
}

/** Reconstruct a stored ticket from a work-item's id, state, and description. */
export function parseWorkItem(
  fields: Record<string, any>,
  id: number,
  cols: ColumnMap = DEFAULT_COLUMNS,
): StoredTicket | null {
  const desc: string = fields['System.Description'] ?? '';
  const m = MARKER_RE.exec(desc);
  if (!m) return null;
  let json: string;
  try {
    json = Buffer.from(m[1], 'base64').toString('utf-8');
  } catch {
    return null;
  }
  const parsed = TicketSchema.safeParse(JSON.parse(json));
  if (!parsed.success) return null;
  const column: string = fields['System.State'] ?? fields['System.BoardColumn'] ?? '';
  const status = statusFromColumn(column, cols) ?? parsed.data.status;
  return {
    ...parsed.data,
    key: String(id),
    slug: parsed.data.slug ?? slugify(parsed.data.title),
    status,
  };
}

export function createArgs(
  coords: { organization?: string; project?: string },
  title: string,
  html: string,
  column: string,
): string[] {
  const args = [
    'az',
    'boards',
    'work-item',
    'create',
    '--title',
    title,
    '--type',
    'Issue',
    '--fields',
    `System.State=${column}`,
    '--description',
    html,
    '--output',
    'json',
  ];
  if (coords.organization) args.push('--organization', coords.organization);
  if (coords.project) args.push('--project', coords.project);
  return args;
}

export class AzureTicketProvider implements TicketProvider {
  readonly name = 'azure';
  private readonly columns: ColumnMap;
  constructor(
    private readonly opts: {
      organization?: string;
      project?: string;
      dryRun: boolean;
      cwd?: string;
      columns?: ColumnMap;
    },
  ) {
    this.columns = opts.columns ?? DEFAULT_COLUMNS;
  }

  private coords() {
    return { organization: this.opts.organization, project: this.opts.project };
  }

  // `az boards work-item show/update` accept ONLY --organization; `delete` and
  // `query` also need --project. `az` flag support is inconsistent per subcommand.
  private orgArgs(): string[] {
    return this.opts.organization ? ['--organization', this.opts.organization] : [];
  }

  private scopeArgs(): string[] {
    const a: string[] = [...this.orgArgs()];
    if (this.opts.project) a.push('--project', this.opts.project);
    return a;
  }

  async nextId(): Promise<string> {
    return '(assigned by azure on create)';
  }

  async create(input: Ticket): Promise<StoredTicket> {
    const slug = input.slug ?? slugify(input.title);
    const draft: StoredTicket = { ...input, key: '(pending)', slug };
    const html = descriptionHtml(draft);
    const res = execMutate(
      createArgs(this.coords(), input.title, html, columnForStatus(input.status, this.columns)),
      this.opts.dryRun,
    );
    if (!res.ran) return { ...draft, key: '(dry-run)' };
    const id = JSON.parse(res.stdout).id;
    return { ...draft, key: String(id) };
  }

  async get(key: string): Promise<StoredTicket | null> {
    const out = execRead([
      'az',
      'boards',
      'work-item',
      'show',
      '--id',
      key,
      '--output',
      'json',
      ...this.orgArgs(),
    ]);
    const wi = JSON.parse(out);
    return parseWorkItem(wi.fields ?? {}, wi.id, this.columns);
  }

  async list(): Promise<TicketRef[]> {
    const wiql =
      "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Issue' ORDER BY [System.Id]";
    const out = execRead([
      'az',
      'boards',
      'query',
      '--wiql',
      wiql,
      '--output',
      'json',
      ...this.scopeArgs(),
    ]);
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
      [
        'az',
        'boards',
        'work-item',
        'update',
        '--id',
        key,
        '--fields',
        `System.State=${columnForStatus(status, this.columns)}`,
        ...this.orgArgs(),
      ],
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
    execMutate(
      ['az', 'boards', 'work-item', 'delete', '--id', key, '--yes', ...this.scopeArgs()],
      this.opts.dryRun,
    );
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
