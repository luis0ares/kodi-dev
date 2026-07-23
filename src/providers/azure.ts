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
 *
 * `kodi init` lets the user map each status to a real BOARD COLUMN. The visible
 * `System.BoardColumn` field is a read-only computed mirror (Azure rejects writes
 * with TF401326), so a card is positioned in TWO steps: its `System.State` is set
 * (the writable state a column maps to via `columnStates`), AND — the crucial part
 * when several columns share one state (e.g. a "Doing" and a "To Review" column
 * both mapping to the "Doing" state) — its hidden, WRITABLE per-board Kanban column
 * field is set to the exact column name (see {@link kanbanColumnField}). Without
 * that second write, a hand-off to a shared-state review column would leave the
 * card sitting in the column it was already in. All `az` calls are proxied here;
 * mutations respect dry-run.
 */

// Azure sanitizes rich-text descriptions and STRIPS HTML comments, so the
// canonical record is stored base64-encoded inside a <pre> (which survives).
const MARKER_RE = /kodi:ticket:([A-Za-z0-9+/=]+)/;

/**
 * The per-board hidden field that POSITIONS a card within its column, e.g.
 * `WEF_807161377A2D4EA4BE01F1B411161E5F_Kanban.Column`. Unlike the read-only
 * `System.BoardColumn` mirror, this field is WRITABLE and is the only way to land
 * a card in a specific column when several columns share one `System.State`.
 * The GUID is board-specific, so the field is discovered from the work item
 * itself rather than hard-coded. Returns the field name, or undefined when the
 * card is not yet on a board (a freshly created item before placement).
 */
const KANBAN_COLUMN_FIELD_RE = /^WEF_[0-9A-Fa-f]+_Kanban\.Column$/;

export function kanbanColumnField(fields: Record<string, unknown>): string | undefined {
  return Object.keys(fields).find((k) => KANBAN_COLUMN_FIELD_RE.test(k));
}

/** Escape a value for a single-quoted WIQL string literal (a quote is doubled). */
function wiqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * The WIQL that hydrates the board in one query. The project is pinned via
 * `[System.TeamProject]` because `az boards query` does NOT honour `--project` —
 * it runs the WIQL across the whole ORGANIZATION, so without this filter a
 * multi-project org would leak every other project's Issues into `tickets list`.
 * Every field `parseWorkItem` needs is selected (Description carries the base64
 * marker) so the query batch-fetches all rows — ONE `az` call regardless of board
 * size, never a per-item `work-item show` (an N+1 that hung large boards).
 */
export function listWiql(project?: string): string {
  const scope = project ? ` AND [System.TeamProject] = '${wiqlLiteral(project)}'` : '';
  return (
    'SELECT [System.Id], [System.Title], [System.State], [System.BoardColumn], [System.Description] ' +
    `FROM WorkItems WHERE [System.WorkItemType] = 'Issue'${scope} ORDER BY [System.Id]`
  );
}

/**
 * Parse the rows from `az boards query --output json`. Az prints an EMPTY string
 * (not `[]`) when the query matches nothing — e.g. a project with no Issues yet —
 * so an empty/whitespace payload yields no rows rather than a JSON parse crash.
 */
export function parseQueryOutput(out: string): any[] {
  return out.trim() ? JSON.parse(out) : [];
}

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

/**
 * The `System.State` a board column maps to. Azure boards can have MORE columns
 * than states (several columns sharing one state). `System.BoardColumn` is
 * read-only (Azure rejects writes), so kodi drives the board via the writable
 * `System.State`: it translates the user's chosen column to its state and sets
 * that. A column with no recorded mapping falls back to itself — correct for a
 * board where the column name IS the state name (e.g. a default Basic board).
 */
export function stateForColumn(column: string, columnStates?: Record<string, string>): string {
  return columnStates?.[column] ?? column;
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
  // Prefer the BOARD COLUMN (specific — distinguishes columns that share a state)
  // and fall back to the raw state for items not yet placed on the board.
  const column: string = fields['System.BoardColumn'] ?? fields['System.State'] ?? '';
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
  state: string,
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
    `System.State=${state}`,
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
  private readonly columnStates?: Record<string, string>;
  constructor(
    private readonly opts: {
      organization?: string;
      project?: string;
      dryRun: boolean;
      cwd?: string;
      columns?: ColumnMap;
      /** Board-column → System.State map (see BoardConfig.columnStates). */
      columnStates?: Record<string, string>;
    },
  ) {
    this.columns = opts.columns ?? DEFAULT_COLUMNS;
    this.columnStates = opts.columnStates;
  }

  /**
   * The writable state for a logical status. The user maps each status to a BOARD
   * COLUMN in `kodi init`, but `System.BoardColumn` is a read-only computed field
   * (Azure rejects writes with TF401326), so the state kodi can set is
   * `System.State`. We translate the chosen column → the state it maps to (via
   * `columnStates`) and set that. On its own this cannot distinguish columns that
   * share a state — {@link moveArgs} also writes the Kanban column field for that.
   */
  private stateFor(status: TicketStatus): string {
    return stateForColumn(columnForStatus(status, this.columns), this.columnStates);
  }

  /**
   * Move work-item `id` to the column a logical status maps to. Sets `System.State`
   * (the writable state field) AND, when the card is already on the board so its
   * hidden Kanban column field exists, that column field — the only field that
   * lands the card in the exact column when several columns share a state. Passing
   * both keeps the card's state and column consistent in a single update; when the
   * Kanban field is absent (a not-yet-placed item) the state write alone still
   * moves it, and Azure places it in the default column for that state.
   */
  private moveArgs(id: string, status: TicketStatus, kanbanField?: string): string[] {
    const column = columnForStatus(status, this.columns);
    const fields = [`System.State=${stateForColumn(column, this.columnStates)}`];
    if (kanbanField) fields.push(`${kanbanField}=${column}`);
    const args = ['az', 'boards', 'work-item', 'update', '--id', id];
    for (const f of fields) args.push('--fields', f);
    return [...args, ...this.orgArgs()];
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
      createArgs(this.coords(), input.title, html, this.stateFor(input.status)),
      this.opts.dryRun,
    );
    if (!res.ran) return { ...draft, key: '(dry-run)' };
    const id = String(JSON.parse(res.stdout).id);
    return { ...draft, key: id };
  }

  /** Fetch a work item's raw id + fields (the fields carry both the canonical
   * marker AND the hidden Kanban column field a move needs). */
  private showRaw(key: string): { id: number; fields: Record<string, unknown> } {
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
    return { id: wi.id, fields: wi.fields ?? {} };
  }

  async get(key: string): Promise<StoredTicket | null> {
    const { id, fields } = this.showRaw(key);
    return parseWorkItem(fields, id, this.columns);
  }

  async list(): Promise<TicketRef[]> {
    const out = execRead([
      'az',
      'boards',
      'query',
      '--wiql',
      listWiql(this.opts.project),
      '--output',
      'json',
      ...this.scopeArgs(),
    ]);
    const rows = parseQueryOutput(out);
    const refs: TicketRef[] = [];
    for (const row of rows) {
      const id = row.id ?? row.fields?.['System.Id'];
      if (id == null) continue;
      const t = parseWorkItem(row.fields ?? {}, Number(id), this.columns);
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
    const { id, fields } = this.showRaw(key);
    const current = parseWorkItem(fields, id, this.columns);
    if (!current) throw new Error(`work-item ${key} not found`);
    // Move by state AND the card's own Kanban column field, so a hand-off reaches
    // the mapped column even when several columns share the target state.
    execMutate(this.moveArgs(key, status, kanbanColumnField(fields)), this.opts.dryRun);
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
