import type { Ticket, StoredTicket, TicketStatus } from '../templates/ticket.js';

export interface TicketRef {
  key: string;
  title: string;
  status: TicketStatus;
  slug: string;
  dependencies: string[];
}

/**
 * Scope of a listing. Done is EXCLUDED by default — the Done column is the only
 * one that grows without bound, and nothing that reads a listing renders it:
 * `tickets list` shows open work, `tree` drops Done nodes outright, and readiness
 * treats an invisible dependency as satisfied. Paying for it on every call is
 * what made remote boards fail — a real Azure board spends 87 of its 118 issues
 * (and 1.06 MB of the 1.33 MB payload) on Done, past the spawn buffer; on GitHub
 * each Done item can cost an extra API call against a much narrower rate limit.
 * Done tickets are fetched ON DEMAND instead: `tickets list --all`, or a targeted
 * `get` (which never filters).
 */
export interface ListOptions {
  includeDone?: boolean;
}

export interface ReadyResult {
  ready: TicketRef[];
  blocked: Array<{ ticket: TicketRef; blockedBy: string[] }>;
}

export interface StartProvenance {
  branch?: string;
  branchedFrom?: string;
  startedBy?: string;
}

/**
 * The logical ticket interface. Every provider (local markdown, Azure Boards,
 * GitHub Projects) implements the SAME operations; callers never assume where
 * tickets live. Remote providers proxy `az`/`gh` internally.
 */
export interface TicketProvider {
  readonly name: string;
  /** Compute the next `PREFIX-NNN` key. */
  nextId(prefix?: string): Promise<string>;
  create(input: Ticket): Promise<StoredTicket>;
  get(key: string): Promise<StoredTicket | null>;
  /** Board listing; Done is excluded unless {@link ListOptions.includeDone}. */
  list(opts?: ListOptions): Promise<TicketRef[]>;
  listReady(): Promise<ReadyResult>;
  setStatus(key: string, status: TicketStatus): Promise<StoredTicket>;
  start(key: string, provenance: StartProvenance): Promise<StoredTicket>;
  /** Patch a ticket's editable fields (summary, criteria, deps, prUrl, …). */
  amend(key: string, patch: Partial<Ticket>): Promise<StoredTicket>;
  delete(key: string): Promise<void>;
}
