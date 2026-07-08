// Board read-path TS types — the §7 projection surface and the board model.
//
// Anchors:
//  - PRD 0001 §7 "Corrected data contract" — the ONLY ticket fields the board
//    may read/expose (allow-list, SR-5).
//  - data-model §1/§3 — the four canonical statuses (Alternative B) and their
//    fixed order. These mirror the columns a remote (github/azure) board is
//    configured with (to-do/pending, in progress, in review, done) — there is
//    no "Blocked" status.
//
// This module is a leaf (no fs, no yaml) so both the reader and the (future)
// UI can depend on it without pulling node-only code into the client bundle.

/**
 * The four canonical ticket statuses, in FIXED render order (data-model §1/§3,
 * PRD §7 exact spelling). This is the board's own hardcoded copy of the CLI's
 * `TICKET_STATUSES` — the board is a self-contained project and MUST NOT import
 * across packages (ADR-0002 §2.6). Column order is derived from THIS enum, never
 * from `status.yaml`'s `columns` list (which may be absent — ADR-0002 §2.5).
 */
export const TICKET_STATUSES = ['Pending', 'In progress', 'To review', 'Done'] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * The §7 `drivers` object. `adr` always present (default `[]`); `prd`/`security`
 * optional strings, present only when set. Rebuilt by explicit sub-key pick —
 * never by spreading parsed frontmatter (SR-5).
 */
export interface BoardDrivers {
  adr: string[];
  prd?: string;
  security?: string;
}

/**
 * The §7 projection of a ticket as the board exposes it (SR-5 allow-list).
 *
 * `status` is the AUTHORITATIVE index column (data-model §4 index-wins): it comes
 * from `status.yaml`'s `tickets[KEY].column`, NOT from the file's frontmatter
 * `status`. A card in the "Blocked" column shows status "Blocked" even if its
 * frontmatter still says "Pending".
 *
 * The phantom NG-1 fields (priority/phase/created/implementedAt/branch/lastCommit)
 * and the non-surfaced `slug`/`nonGoals` (R-013) are DELIBERATELY absent — they
 * are never read and never exposed.
 */
export interface BoardTicket {
  key: string;
  title: string;
  status: TicketStatus;
  dependencies: string[];
  drivers: BoardDrivers;
  summary: string;
  acceptanceCriteria: string[];
  prUrl?: string;
  notes?: string;
}

/** One board column: a status header + the cards placed in it (may be empty). */
export interface BoardColumn {
  status: TicketStatus;
  tickets: BoardTicket[];
}

/** The whole board model: always the four columns, in the fixed enum order. */
export interface BoardModel {
  columns: BoardColumn[];
}
