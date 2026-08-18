import type { ColumnMap } from '../config.js';
import { execMutate, execRead } from '../exec.js';
import { writeTempFile } from '../tmpfile.js';
import {
  renderTicketMarkdown,
  slugify,
  TicketSchema,
  type StoredTicket,
  type Ticket,
  type TicketStatus,
} from '../templates/ticket.js';
import {
  currentIteration,
  fetchIterationConfiguration,
  fetchProjectMeta,
  iterationByTitle,
  listIterationField,
  optionIdFor,
  type IterationCatalog,
  type IterationFieldRef,
  type IterationValue,
  type ProjectMeta,
} from './github-discovery.js';
import { readyFromActive } from './ready.js';
import type {
  Iteration,
  ListOptions,
  ReadyResult,
  StartProvenance,
  TicketProvider,
  TicketRef,
} from './types.js';

/**
 * GitHub ticket provider. Tickets are repo issues whose canonical record rides in
 * the issue body as a hidden `<!-- kodi:ticket … -->` marker (markdown survives
 * verbatim, so no base64 needed — unlike Azure). Status is the source of truth on
 * a Projects v2 board: each issue is also an item on the board, and status maps to
 * the board's single-select Status field via the column map from `kodi init`. All
 * `gh` calls are proxied here; mutations respect dry-run.
 */

const MARKER_RE = /<!--\s*kodi:ticket\s+(\{[\s\S]*?\})\s*-->/;

/** Fallback columns matching GitHub's built-in board template (has no "To Review"). */
export const DEFAULT_COLUMNS: ColumnMap = {
  todo: 'Todo',
  inProgress: 'In Progress',
  toReview: 'In Progress',
  done: 'Done',
};

/** Status → board column name (new/Pending issues land in the todo column). */
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

/** Inverse mapping: a board column name back to a ticket status (first match wins). */
export function statusFromColumn(column: string, cols: ColumnMap): TicketStatus | undefined {
  if (column === cols.todo) return 'Pending';
  if (column === (cols.inProgress ?? DEFAULT_COLUMNS.inProgress)) return 'In progress';
  if (column === (cols.toReview ?? DEFAULT_COLUMNS.toReview)) return 'To review';
  if (column === (cols.done ?? DEFAULT_COLUMNS.done)) return 'Done';
  return undefined;
}

/** Serialize a ticket into an issue body: human markdown + hidden marker block. */
export function serializeBody(t: StoredTicket): string {
  const canonical = JSON.stringify({ ...t, key: undefined });
  return `${renderTicketMarkdown(t)}\n<!-- kodi:ticket ${canonical} -->\n`;
}

/** Recover the canonical ticket (sans key) from an issue body, or null if unmarked. */
export function parseMarker(body: string | null | undefined): Ticket | null {
  const m = body ? MARKER_RE.exec(body) : null;
  if (!m) return null;
  const parsed = TicketSchema.safeParse(JSON.parse(m[1]));
  return parsed.success ? parsed.data : null;
}

/** A board item projected to what we need: issue number, body (marker), and status column. */
export interface ProjectItem {
  itemId: string;
  issueNumber: number;
  statusName?: string;
  body?: string;
  /** The item's raw `item-list` object — every field value `gh` returned for
   * it, unparsed. Custom fields (like an Iteration field) are read from here
   * lazily, once the field's own name is known (see {@link iterationValueFromRaw}) —
   * `gh` already fetches every field's value per item unconditionally, so no
   * extra API call is needed. */
  raw: Record<string, unknown>;
}

/** Parse `gh project item-list --format json`, keeping only issue items. */
export function parseItems(json: string): ProjectItem[] {
  const data = JSON.parse(json);
  const items: any[] = Array.isArray(data) ? data : (data.items ?? []);
  const out: ProjectItem[] = [];
  for (const it of items) {
    const content = it?.content ?? {};
    if (
      content.type !== 'Issue' ||
      typeof content.number !== 'number' ||
      typeof it?.id !== 'string'
    )
      continue;
    out.push({
      itemId: it.id,
      issueNumber: content.number,
      statusName: typeof it?.status === 'string' ? it.status : undefined,
      body: typeof content.body === 'string' ? content.body : undefined,
      raw: it,
    });
  }
  return out;
}

/** A per-item `ProjectV2ItemFieldIterationValue`, as `gh project item-list` serializes it —
 * an OBJECT, unlike a single-select field's flat string value. */
export interface RawIterationValue {
  title: string;
  startDate: string;
  duration: number;
  iterationId: string;
}

/**
 * Read a custom field's raw value off an item, keyed by the field's own
 * (`gh`-camelCased) name — `gh` only lowercases the FIRST character
 * (`"Iteration"` → `iteration`, but `"StoryPoints"` → `storyPoints`, not
 * `storypoints`), so this must NOT be a full `.toLowerCase()`.
 */
export function iterationValueFromRaw(
  raw: Record<string, unknown> | undefined,
  fieldName: string,
): RawIterationValue | undefined {
  if (!raw || !fieldName) return undefined;
  const key = fieldName[0].toLowerCase() + fieldName.slice(1);
  const v = raw[key] as any;
  if (!v || typeof v !== 'object') return undefined;
  if (typeof v.title !== 'string') return undefined;
  return {
    title: v.title,
    startDate: typeof v.startDate === 'string' ? v.startDate : '',
    duration: typeof v.duration === 'number' ? v.duration : 0,
    iterationId: typeof v.iterationId === 'string' ? v.iterationId : '',
  };
}

/** `gh project item-edit --iteration-id` — assigns an item to a specific iteration/sprint. */
export function itemEditIterationArgs(
  projectId: string,
  itemId: string,
  fieldId: string,
  iterationId: string,
): string[] {
  return [
    'gh',
    'project',
    'item-edit',
    '--id',
    itemId,
    '--project-id',
    projectId,
    '--field-id',
    fieldId,
    '--iteration-id',
    iterationId,
  ];
}

/**
 * The board items a listing must actually READ. `gh project item-list` hands back
 * every item with its Status column for one API call, but recovering a ticket's
 * canonical record can cost a `gh issue view` PER ITEM — so a not-done listing
 * discards the Done column here, before any body is fetched. That is the whole
 * rate-limit saving on GitHub, where the budget is far narrower than Azure's.
 * An item with no Status yet cannot be classified from the column alone, so it is
 * kept and judged after hydration.
 */
export function itemsToHydrate(
  items: ProjectItem[],
  cols: ColumnMap,
  includeDone = false,
): ProjectItem[] {
  if (includeDone) return items;
  return items.filter((i) => !i.statusName || statusFromColumn(i.statusName, cols) !== 'Done');
}

export function createIssueArgs(
  repo: string | undefined,
  title: string,
  bodyFile: string,
): string[] {
  const args = ['gh', 'issue', 'create', '--title', title, '--body-file', bodyFile];
  if (repo) args.push('--repo', repo);
  return args;
}

export function itemAddArgs(owner: string, number: number, issueUrl: string): string[] {
  return [
    'gh',
    'project',
    'item-add',
    String(number),
    '--owner',
    owner,
    '--url',
    issueUrl,
    '--format',
    'json',
  ];
}

/**
 * Assign the authenticated `gh` user to an issue. `@me` is `gh`'s own literal for
 * "whoever is logged in" — no separate lookup of the user's login is needed.
 */
export function assignSelfArgs(key: string, repo?: string): string[] {
  const args = ['gh', 'issue', 'edit', key, '--add-assignee', '@me'];
  if (repo) args.push('--repo', repo);
  return args;
}

export function itemEditArgs(
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
): string[] {
  return [
    'gh',
    'project',
    'item-edit',
    '--id',
    itemId,
    '--project-id',
    projectId,
    '--field-id',
    fieldId,
    '--single-select-option-id',
    optionId,
  ];
}

export class GithubTicketProvider implements TicketProvider {
  readonly name = 'github';
  private readonly columns: ColumnMap;
  private meta?: ProjectMeta;
  private itemsCache?: ProjectItem[];
  /** `undefined` = not yet resolved; `null` = resolved to "no such field/catalog". */
  private iterationFieldCache?: IterationFieldRef | null;
  private iterationCatalogCache?: IterationCatalog | null;

  constructor(
    private readonly opts: {
      repo?: string;
      owner: string;
      number: number;
      dryRun: boolean;
      cwd?: string;
      columns?: ColumnMap;
    },
  ) {
    this.columns = opts.columns ?? DEFAULT_COLUMNS;
  }

  private repoArgs(): string[] {
    return this.opts.repo ? ['--repo', this.opts.repo] : [];
  }

  /** Resolve (and cache) the project + Status field node ids needed for writes. */
  private projectMeta(): ProjectMeta {
    return (this.meta ??= fetchProjectMeta(this.opts.owner, this.opts.number));
  }

  /** Resolve (and cache) the board's Iteration field, if it has one. */
  private iterationField(): IterationFieldRef | null {
    if (this.iterationFieldCache === undefined) {
      this.iterationFieldCache = listIterationField(this.opts.owner, this.opts.number);
    }
    return this.iterationFieldCache;
  }

  /** Resolve (and cache) the Iteration field's full catalog, if it has one. */
  private iterationCatalog(): IterationCatalog | null {
    if (this.iterationCatalogCache === undefined) {
      const field = this.iterationField();
      this.iterationCatalogCache = field ? fetchIterationConfiguration(field.id) : null;
    }
    return this.iterationCatalogCache;
  }

  /**
   * Resolve a named iteration's title (case-insensitive). Throws when the
   * project has no Iteration field at all, or the name matches nothing — an
   * explicit ask (`--iteration <name>` filtering, or `setIteration`), where a
   * silent fallback would be wrong.
   */
  private resolveIterationTitle(name: string): string {
    const catalog = this.iterationCatalog();
    if (!catalog) {
      throw new Error(
        `project #${this.opts.number} (owner ${this.opts.owner}) has no Iteration field`,
      );
    }
    const match = iterationByTitle(catalog, name);
    if (!match) {
      const available =
        [...catalog.iterations, ...catalog.completedIterations].map((i) => i.title).join(', ') ||
        '(none configured)';
      throw new Error(`no iteration named "${name}" (available: ${available})`);
    }
    return match.title;
  }

  /**
   * Best-effort resolution of the current iteration's title, for the default
   * listing filter. Returns undefined — degrading the default listing to "no
   * iteration filter" — when the project has no Iteration field, or none of
   * its iterations covers today. Mirrors Azure's identical graceful-default
   * policy: only an explicit ask ever throws.
   */
  private defaultIterationTitle(): string | undefined {
    const catalog = this.iterationCatalog();
    if (!catalog) return undefined;
    return currentIteration(catalog)?.title;
  }

  /** Read (and cache) all board items in one call. */
  private items(): ProjectItem[] {
    if (this.itemsCache) return this.itemsCache;
    const out = execRead([
      'gh',
      'project',
      'item-list',
      String(this.opts.number),
      '--owner',
      this.opts.owner,
      '--format',
      'json',
      '--limit',
      '500',
    ]);
    return (this.itemsCache = parseItems(out));
  }

  /** Body for an item — from item-list when present, else a per-issue fallback fetch. */
  private bodyFor(item: ProjectItem): string {
    if (item.body != null) return item.body;
    return execRead([
      'gh',
      'issue',
      'view',
      String(item.issueNumber),
      '--json',
      'body',
      '-q',
      '.body',
      ...this.repoArgs(),
    ]);
  }

  /** Status from the board column alone — known without reading the issue body. */
  private columnStatus(item: ProjectItem): TicketStatus | undefined {
    return item.statusName ? statusFromColumn(item.statusName, this.columns) : undefined;
  }

  private toStored(item: ProjectItem): (StoredTicket & { iteration?: string }) | null {
    const t = parseMarker(this.bodyFor(item));
    if (!t) return null;
    const status = this.columnStatus(item) ?? t.status;
    const field = this.iterationField();
    const iteration = field ? iterationValueFromRaw(item.raw, field.name)?.title : undefined;
    return {
      ...t,
      key: String(item.issueNumber),
      slug: t.slug ?? slugify(t.title),
      status,
      ...(iteration ? { iteration } : {}),
    };
  }

  async nextId(): Promise<string> {
    return '(assigned by github on create)';
  }

  async create(input: Ticket): Promise<StoredTicket> {
    const slug = input.slug ?? slugify(input.title);
    const draft: StoredTicket = { ...input, key: '(pending)', slug };
    const bodyFile = writeTempBody(serializeBody(draft));
    const r1 = execMutate(createIssueArgs(this.opts.repo, input.title, bodyFile), this.opts.dryRun);
    if (!r1.ran) {
      // Preview the rest of the chain with placeholders (real URL/item-id unknown in dry-run).
      execMutate(itemAddArgs(this.opts.owner, this.opts.number, '<issue-url>'), this.opts.dryRun);
      execMutate(
        itemEditArgs('<project-id>', '<item-id>', '<status-field-id>', '<option-id>'),
        this.opts.dryRun,
      );
      return { ...draft, key: '(dry-run)' };
    }
    const url = r1.stdout.trim().split('\n').pop() ?? '';
    const num = url.match(/\/(\d+)\/?$/)?.[1] ?? '?';
    // The issue now EXISTS. If attaching it to the board fails (commonly a token
    // without the `project` write scope), don't leave a silent orphan — report
    // that the issue was created and exactly how to finish adding it.
    try {
      const add = execMutate(itemAddArgs(this.opts.owner, this.opts.number, url), false);
      const itemId = JSON.parse(add.stdout).id as string;
      const meta = this.projectMeta();
      const optionId = optionIdFor(meta.statusField, columnForStatus(input.status, this.columns));
      if (optionId)
        execMutate(itemEditArgs(meta.projectId, itemId, meta.statusField.id, optionId), false);
    } catch (e) {
      throw new Error(
        `issue #${num} was created (${url}) but could not be added to project #${this.opts.number}: ` +
          `${e instanceof Error ? e.message : String(e)}\n` +
          `If your gh token lacks the \`project\` scope, run \`gh auth refresh -s project --hostname github.com\`, then attach it with:\n` +
          `  gh project item-add ${this.opts.number} --owner ${this.opts.owner} --url ${url}`,
      );
    }
    return { ...draft, key: num };
  }

  async get(key: string): Promise<(StoredTicket & { iteration?: string }) | null> {
    const item = this.items().find((i) => String(i.issueNumber) === key);
    return item ? this.toStored(item) : null;
  }

  async list(opts?: ListOptions): Promise<TicketRef[]> {
    // Resolve the iteration filter ONCE, up front: undefined means "no filter"
    // (either --all-iterations, or the default gracefully degrading because
    // there's no Iteration field / no current sprint) — `--iteration <name>`
    // resolves strictly and throws if it doesn't match anything.
    let filter: { title: string; includeUnscheduled: boolean } | undefined;
    if (!opts?.allIterations) {
      if (opts?.iteration) {
        filter = { title: this.resolveIterationTitle(opts.iteration), includeUnscheduled: false };
      } else {
        const title = this.defaultIterationTitle();
        if (title) filter = { title, includeUnscheduled: true };
      }
    }
    const refs: TicketRef[] = [];
    for (const item of itemsToHydrate(this.items(), this.columns, opts?.includeDone)) {
      const t = this.toStored(item);
      if (!t) continue;
      // An item with no Status column yet is only classifiable after hydration.
      if (!opts?.includeDone && t.status === 'Done') continue;
      if (filter) {
        const matches = t.iteration === filter.title || (filter.includeUnscheduled && !t.iteration);
        if (!matches) continue;
      }
      refs.push(toRef(t));
    }
    return refs;
  }

  async listReady(): Promise<ReadyResult> {
    return readyFromActive(await this.list());
  }

  async setStatus(key: string, status: TicketStatus): Promise<StoredTicket> {
    const item = this.items().find((i) => String(i.issueNumber) === key);
    if (!item) throw new Error(`issue ${key} is not on project #${this.opts.number}`);
    const current = this.toStored(item);
    if (!current) throw new Error(`issue ${key} has no kodi marker`);
    const meta = this.projectMeta();
    const optionId = optionIdFor(meta.statusField, columnForStatus(status, this.columns));
    if (!optionId)
      throw new Error(`no Status option maps to "${status}" on project #${this.opts.number}`);
    execMutate(
      itemEditArgs(meta.projectId, item.itemId, meta.statusField.id, optionId),
      this.opts.dryRun,
    );
    return { ...current, status };
  }

  async start(key: string, _p: StartProvenance): Promise<StoredTicket> {
    const t = await this.setStatus(key, 'In progress');
    // Assign the issue to whoever is running `start`, so it doesn't land on the
    // board unowned.
    execMutate(assignSelfArgs(key, this.opts.repo), this.opts.dryRun);
    return t;
  }

  async amend(key: string, patch: Partial<Ticket>): Promise<StoredTicket> {
    const current = await this.get(key);
    if (!current) throw new Error(`issue ${key} not found`);
    const merged: StoredTicket = { ...current, ...patch, key, slug: current.slug };
    const bodyFile = writeTempBody(serializeBody(merged));
    const args = ['gh', 'issue', 'edit', key, '--body-file', bodyFile, ...this.repoArgs()];
    if (patch.title) args.push('--title', patch.title);
    execMutate(args, this.opts.dryRun);
    return merged;
  }

  async delete(key: string): Promise<void> {
    execMutate(['gh', 'issue', 'delete', key, '--yes', ...this.repoArgs()], this.opts.dryRun);
  }

  async listIterations(): Promise<Iteration[]> {
    const catalog = this.iterationCatalog();
    if (!catalog) {
      throw new Error(
        `project #${this.opts.number} (owner ${this.opts.owner}) has no Iteration field`,
      );
    }
    const current = currentIteration(catalog);
    const toIteration = (v: IterationValue): Iteration => {
      const start = new Date(v.startDate).getTime();
      // Match startDate's plain YYYY-MM-DD shape (the GitHub API's own format) —
      // not a full ISO timestamp, which would read inconsistently next to it.
      const end = new Date(start + v.duration * 86_400_000).toISOString().slice(0, 10);
      return {
        id: v.id,
        name: v.title,
        startDate: v.startDate,
        endDate: end,
        current: v.id === current?.id,
      };
    };
    return [...catalog.iterations, ...catalog.completedIterations].map(toIteration);
  }

  async setIteration(
    key: string,
    iteration: string,
  ): Promise<StoredTicket & { iteration?: string }> {
    const title = this.resolveIterationTitle(iteration);
    const catalog = this.iterationCatalog()!; // resolveIterationTitle already proved this is non-null
    const value = iterationByTitle(catalog, title)!;
    const item = this.items().find((i) => String(i.issueNumber) === key);
    if (!item) throw new Error(`issue ${key} is not on project #${this.opts.number}`);
    const current = this.toStored(item);
    if (!current) throw new Error(`issue ${key} has no kodi marker`);
    const field = this.iterationField()!;
    const meta = this.projectMeta();
    execMutate(
      itemEditIterationArgs(meta.projectId, item.itemId, field.id, value.id),
      this.opts.dryRun,
    );
    return { ...current, iteration: title };
  }
}

function toRef(t: StoredTicket & { iteration?: string }): TicketRef {
  return {
    key: t.key,
    title: t.title,
    status: t.status,
    slug: t.slug,
    dependencies: t.dependencies,
    ...(t.iteration ? { iteration: t.iteration } : {}),
  };
}

/** Write an issue body to a temp file (gh reads --body-file). */
function writeTempBody(body: string): string {
  return writeTempFile(body, 'kodi-gh-', 'body.md');
}
