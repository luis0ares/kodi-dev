import type { Ticket, StoredTicket, TicketStatus } from '../templates/ticket.js';

export interface TicketRef {
  key: string;
  title: string;
  status: TicketStatus;
  slug: string;
  dependencies: string[];
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
 * The logical ticket interface. Every provider (local markdown, GitHub
 * Projects, Azure Boards) implements the SAME operations; callers never assume
 * where tickets live. Remote providers proxy `gh`/`az` internally.
 */
export interface TicketProvider {
  readonly name: string;
  /** Compute the next `PREFIX-NNN` key. */
  nextId(prefix?: string): Promise<string>;
  create(input: Ticket): Promise<StoredTicket>;
  get(key: string): Promise<StoredTicket | null>;
  list(): Promise<TicketRef[]>;
  listReady(): Promise<ReadyResult>;
  setStatus(key: string, status: TicketStatus): Promise<StoredTicket>;
  start(key: string, provenance: StartProvenance): Promise<StoredTicket>;
  delete(key: string): Promise<void>;
}
