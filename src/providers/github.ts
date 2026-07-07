import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execRead, execMutate } from '../exec.js';
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
 * GitHub ticket provider. Tickets are GitHub issues; the canonical ticket record
 * is embedded in the issue body as a hidden marker block so it round-trips
 * losslessly. Status maps to open/closed + a `kodi:status:*` label. All `gh`
 * calls are proxied here; mutations respect dry-run.
 */

const MARKER_RE = /<!--\s*kodi:ticket\s+(\{[\s\S]*?\})\s*-->/;

export const STATUS_LABEL: Record<Exclude<TicketStatus, 'Done'>, string> = {
  Pending: 'kodi:pending',
  'In progress': 'kodi:in-progress',
  'To review': 'kodi:to-review',
  Blocked: 'kodi:blocked',
};

/** Serialize a ticket into an issue body: human markdown + hidden marker block. */
export function serializeBody(t: StoredTicket): string {
  const canonical = JSON.stringify({ ...t, key: undefined });
  return `${renderTicketMarkdown(t)}\n<!-- kodi:ticket ${canonical} -->\n`;
}

/** Reconstruct a stored ticket from an issue's number, state, and body. */
export function parseIssue(issue: {
  number: number;
  state: string;
  body?: string | null;
}): StoredTicket | null {
  const m = issue.body ? MARKER_RE.exec(issue.body) : null;
  if (!m) return null;
  const parsed = TicketSchema.safeParse(JSON.parse(m[1]));
  if (!parsed.success) return null;
  const status: TicketStatus = issue.state?.toUpperCase() === 'CLOSED' ? 'Done' : parsed.data.status;
  const key = String(issue.number);
  return { ...parsed.data, key, slug: parsed.data.slug ?? slugify(parsed.data.title), status };
}

export function createArgs(repo: string | undefined, title: string, bodyFile: string, label?: string): string[] {
  const args = ['gh', 'issue', 'create', '--title', title, '--body-file', bodyFile];
  if (label) args.push('--label', label);
  if (repo) args.push('--repo', repo);
  return args;
}

export class GithubTicketProvider implements TicketProvider {
  readonly name = 'github';
  constructor(
    private readonly opts: { repo?: string; dryRun: boolean; cwd?: string },
  ) {}

  private repoArgs(): string[] {
    return this.opts.repo ? ['--repo', this.opts.repo] : [];
  }

  async nextId(): Promise<string> {
    // GitHub assigns the number on create; there is no client-side next-id.
    return '(assigned by github on create)';
  }

  async create(input: Ticket): Promise<StoredTicket> {
    const slug = input.slug ?? slugify(input.title);
    const draft: StoredTicket = { ...input, key: '(pending)', slug };
    const label = input.status === 'Done' ? undefined : STATUS_LABEL[input.status];
    // body is passed via a temp file by the command layer; here we hand the args.
    const bodyFile = writeTempBody(serializeBody(draft));
    const res = execMutate(createArgs(this.opts.repo, input.title, bodyFile, label), this.opts.dryRun);
    if (!res.ran) return { ...draft, key: '(dry-run)' };
    const url = res.stdout.trim().split('\n').pop() ?? '';
    const num = url.match(/\/(\d+)$/)?.[1] ?? '?';
    return { ...draft, key: num };
  }

  async get(key: string): Promise<StoredTicket | null> {
    const out = execRead(['gh', 'issue', 'view', key, '--json', 'number,state,body', ...this.repoArgs()]);
    return parseIssue(JSON.parse(out));
  }

  async list(): Promise<TicketRef[]> {
    const out = execRead([
      'gh', 'issue', 'list', '--state', 'all', '--json', 'number,state,body', '--limit', '500',
      ...this.repoArgs(),
    ]);
    const issues: any[] = JSON.parse(out);
    return issues
      .map(parseIssue)
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
    const current = await this.get(key);
    if (!current) throw new Error(`issue ${key} not found`);
    if (status === 'Done') {
      execMutate(['gh', 'issue', 'close', key, ...this.repoArgs()], this.opts.dryRun);
    } else {
      execMutate(['gh', 'issue', 'reopen', key, ...this.repoArgs()], this.opts.dryRun);
      execMutate(
        ['gh', 'issue', 'edit', key, '--add-label', STATUS_LABEL[status], ...this.repoArgs()],
        this.opts.dryRun,
      );
    }
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

/** Write the issue body to a temp file (gh reads --body-file). */
function writeTempBody(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'kodi-gh-')), 'body.md');
  writeFileSync(file, body, 'utf-8');
  return file;
}
