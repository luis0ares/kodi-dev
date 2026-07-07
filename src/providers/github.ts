import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ColumnMap } from '../config.js';
import { execMutate, execRead } from '../exec.js';
import {
  renderTicketMarkdown,
  slugify,
  TicketSchema,
  type StoredTicket,
  type Ticket,
  type TicketStatus,
} from '../templates/ticket.js';
import { fetchProjectMeta, optionIdFor, type ProjectMeta } from './github-discovery.js';
import type { ReadyResult, StartProvenance, TicketProvider, TicketRef } from './types.js';

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

/** Status → board column name (new issues + Blocked land in the todo column). */
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
}

/** Parse `gh project item-list --format json`, keeping only issue items. */
export function parseItems(json: string): ProjectItem[] {
  const data = JSON.parse(json);
  const items: any[] = Array.isArray(data) ? data : data.items ?? [];
  const out: ProjectItem[] = [];
  for (const it of items) {
    const content = it?.content ?? {};
    if (content.type !== 'Issue' || typeof content.number !== 'number' || typeof it?.id !== 'string') continue;
    out.push({
      itemId: it.id,
      issueNumber: content.number,
      statusName: typeof it?.status === 'string' ? it.status : undefined,
      body: typeof content.body === 'string' ? content.body : undefined,
    });
  }
  return out;
}

export function createIssueArgs(repo: string | undefined, title: string, bodyFile: string): string[] {
  const args = ['gh', 'issue', 'create', '--title', title, '--body-file', bodyFile];
  if (repo) args.push('--repo', repo);
  return args;
}

export function itemAddArgs(owner: string, number: number, issueUrl: string): string[] {
  return ['gh', 'project', 'item-add', String(number), '--owner', owner, '--url', issueUrl, '--format', 'json'];
}

export function itemEditArgs(projectId: string, itemId: string, fieldId: string, optionId: string): string[] {
  return [
    'gh', 'project', 'item-edit',
    '--id', itemId, '--project-id', projectId, '--field-id', fieldId, '--single-select-option-id', optionId,
  ];
}

export class GithubTicketProvider implements TicketProvider {
  readonly name = 'github';
  private readonly columns: ColumnMap;
  private meta?: ProjectMeta;
  private itemsCache?: ProjectItem[];

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

  /** Read (and cache) all board items in one call. */
  private items(): ProjectItem[] {
    if (this.itemsCache) return this.itemsCache;
    const out = execRead([
      'gh', 'project', 'item-list', String(this.opts.number),
      '--owner', this.opts.owner, '--format', 'json', '--limit', '500',
    ]);
    return (this.itemsCache = parseItems(out));
  }

  /** Body for an item — from item-list when present, else a per-issue fallback fetch. */
  private bodyFor(item: ProjectItem): string {
    if (item.body != null) return item.body;
    return execRead(['gh', 'issue', 'view', String(item.issueNumber), '--json', 'body', '-q', '.body', ...this.repoArgs()]);
  }

  private toStored(item: ProjectItem): StoredTicket | null {
    const t = parseMarker(this.bodyFor(item));
    if (!t) return null;
    const mapped = item.statusName ? statusFromColumn(item.statusName, this.columns) : undefined;
    const status = mapped ?? t.status;
    return { ...t, key: String(item.issueNumber), slug: t.slug ?? slugify(t.title), status };
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
      execMutate(itemEditArgs('<project-id>', '<item-id>', '<status-field-id>', '<option-id>'), this.opts.dryRun);
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
      if (optionId) execMutate(itemEditArgs(meta.projectId, itemId, meta.statusField.id, optionId), false);
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

  async get(key: string): Promise<StoredTicket | null> {
    const item = this.items().find((i) => String(i.issueNumber) === key);
    return item ? this.toStored(item) : null;
  }

  async list(): Promise<TicketRef[]> {
    return this.items()
      .map((i) => this.toStored(i))
      .filter((t): t is StoredTicket => t !== null)
      .map(toRef);
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
    const item = this.items().find((i) => String(i.issueNumber) === key);
    if (!item) throw new Error(`issue ${key} is not on project #${this.opts.number}`);
    const current = this.toStored(item);
    if (!current) throw new Error(`issue ${key} has no kodi marker`);
    const meta = this.projectMeta();
    const optionId = optionIdFor(meta.statusField, columnForStatus(status, this.columns));
    if (!optionId) throw new Error(`no Status option maps to "${status}" on project #${this.opts.number}`);
    execMutate(itemEditArgs(meta.projectId, item.itemId, meta.statusField.id, optionId), this.opts.dryRun);
    return { ...current, status };
  }

  async start(key: string, _p: StartProvenance): Promise<StoredTicket> {
    return this.setStatus(key, 'In progress');
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
}

function toRef(t: StoredTicket): TicketRef {
  return { key: t.key, title: t.title, status: t.status, slug: t.slug, dependencies: t.dependencies };
}

/** Write an issue body to a temp file (gh reads --body-file). */
function writeTempBody(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'kodi-gh-')), 'body.md');
  writeFileSync(file, body, 'utf-8');
  return file;
}
