import type { Ticket, StoredTicket, TicketStatus } from '../templates/ticket.js';

export interface TicketRef {
  key: string;
  title: string;
  status: TicketStatus;
  slug: string;
  dependencies: string[];
  /** Provider-native iteration/sprint name, when the provider supports iterations
   * (azure/github) and the ticket has one assigned. Always undefined for local. */
  iteration?: string;
}

/**
 * One iteration/sprint on a board that supports them (azure/github only).
 * `id` is the provider-native identifier — Azure's full iteration path
 * (`"Proj\Sprint 3"`), GitHub's iteration node id — while `name` is what a
 * human types back on the CLI (`--iteration <name>`).
 */
export interface Iteration {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  current: boolean;
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
  /**
   * Restrict to one named iteration/sprint (azure/github only — see
   * {@link TicketProvider.listIterations}). Omitted defaults to the CURRENT
   * iteration plus anything not yet scheduled into any iteration; the local
   * provider throws if this is set (it has no iteration concept).
   */
  iteration?: string;
  /** Disable iteration filtering entirely — every ticket regardless of sprint. */
  allIterations?: boolean;
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
  get(key: string): Promise<(StoredTicket & { iteration?: string }) | null>;
  /** Board listing; Done is excluded unless {@link ListOptions.includeDone}. */
  list(opts?: ListOptions): Promise<TicketRef[]>;
  listReady(): Promise<ReadyResult>;
  setStatus(key: string, status: TicketStatus): Promise<StoredTicket>;
  start(key: string, provenance: StartProvenance): Promise<StoredTicket>;
  /** Patch a ticket's editable fields (summary, criteria, deps, prUrl, …). */
  amend(key: string, patch: Partial<Ticket>): Promise<StoredTicket>;
  delete(key: string): Promise<void>;
  /** List every iteration/sprint (azure/github only). Throws on the local
   * provider, or on azure/github when iterations aren't configured at all
   * (no team, or no Iteration field) — this is always an explicit ask. */
  listIterations(): Promise<Iteration[]>;
  /** Assign a ticket to a named iteration (azure/github only) — board-native
   * metadata, deliberately outside `create`/`amend`'s `Ticket` patch so it
   * never rides inside the portable marker (see status's identical rule:
   * the board's real value always wins over anything embedded there). */
  setIteration(key: string, iteration: string): Promise<StoredTicket & { iteration?: string }>;
}
