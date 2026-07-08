// Board model assembler — the READ path (KODI-009).
//
// Given the tickets root (KODI_TICKETS_DIR), reads `status.yaml` for placement
// (index-wins, data-model §4), resolves each `entry.file` with containment
// (SR-1/SR-2), reads + projects each ticket file's frontmatter to §7 (SR-5), and
// returns the five-column board. Every consumed value is index-authoritative for
// placement/status; frontmatter contributes content only.
//
// Robustness (SR-3): each entry is resolved/read/projected in its OWN try/catch —
// one bad entry (rejected pointer, missing file, ELOOP, EACCES, oversize,
// malformed frontmatter) degrades that ONE card while the rest render, and never
// unwinds getBoard(). Absent/empty status.yaml, a missing dir, or an
// absent/whitespace root all yield an EMPTY board, never an error (ADR-0002 §2.5,
// SR-7). READ-ONLY (R-014/SR-6): only statSync/readFileSync/realpathSync.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_FILE_BYTES,
  resolveContainedFile,
  safeParseStatusIndex,
  type StatusIndexEntry,
} from './status-index';
import { extractFrontmatterBlock, projectFrontmatter } from './frontmatter';
import {
  TICKET_STATUSES,
  type BoardColumn,
  type BoardModel,
  type BoardTicket,
  type TicketStatus,
} from './types';

/** The five columns in fixed enum order, all empty (ADR-0002 §2.5, R-012). */
function emptyColumns(): { model: BoardModel; byStatus: Map<TicketStatus, BoardColumn> } {
  const byStatus = new Map<TicketStatus, BoardColumn>();
  const columns: BoardColumn[] = TICKET_STATUSES.map((status) => {
    const column: BoardColumn = { status, tickets: [] };
    byStatus.set(status, column);
    return column;
  });
  return { model: { columns }, byStatus };
}

/**
 * A minimal, fully-trusted placeholder for a degraded card (SR-3). It carries
 * ONLY index-derived data — `key` (already validated by KEY_RE in the parse) and
 * the authoritative `status`/column — built by explicit pick. It is never a
 * partial unprojected frontmatter object.
 */
function placeholderCard(key: string, status: TicketStatus): BoardTicket {
  return {
    key,
    title: key,
    status,
    dependencies: [],
    drivers: { adr: [] },
    summary: '',
    acceptanceCriteria: [],
  };
}

/**
 * Resolve + read + project one index entry into a §7 card. Throws on any failure
 * so the caller can degrade this single card (SR-3). `status` is set from the
 * index column (index-wins, §4), never from the file's frontmatter.
 */
function buildCard(
  root: string,
  realRoot: string,
  key: string,
  entry: StatusIndexEntry,
): BoardTicket {
  // SR-1/SR-2: contained real path, or throw.
  const filePath = resolveContainedFile(root, realRoot, key, entry);

  // SR-8: bound the read via stat before touching the bytes.
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error('ticket file is not a regular file or exceeds the size cap');
  }

  const source = readFileSync(filePath, 'utf-8');
  const block = extractFrontmatterBlock(source);
  if (block === null) {
    throw new Error('ticket file has no frontmatter block');
  }
  const fm = projectFrontmatter(block); // §7 explicit pick (SR-5)

  // Explicit field construction (SR-5) — the parsed object is never spread.
  const card: BoardTicket = {
    key,
    title: fm.title !== undefined && fm.title.length > 0 ? fm.title : key,
    status: entry.column, // index-wins (§4)
    dependencies: fm.dependencies,
    drivers: fm.drivers,
    summary: fm.summary ?? '',
    acceptanceCriteria: fm.acceptanceCriteria,
  };
  if (fm.prUrl !== undefined) card.prUrl = fm.prUrl;
  if (fm.notes !== undefined) card.notes = fm.notes;
  return card;
}

/**
 * Assemble the board model from the tickets root. Never throws: any failure
 * short-circuits to an empty (or partially-degraded) board.
 *
 * @param dir the tickets root (KODI_TICKETS_DIR). Absent/empty/whitespace, a
 *            missing dir, or an absent/oversize/malformed status.yaml all yield
 *            the five empty columns (SR-7, ADR-0002 §2.5).
 */
export function buildBoard(dir: string | undefined | null): BoardModel {
  const { model, byStatus } = emptyColumns();

  if (dir === undefined || dir === null || dir.trim() === '') {
    return model; // SR-7: no target dir → empty board.
  }
  const root = dir;

  let statusText: string;
  let realRoot: string;
  try {
    // Absent status.yaml (or missing dir) → empty board (ADR-0002 §2.5).
    const statusPath = resolve(root, 'status.yaml');
    const stat = statSync(statusPath); // throws if absent → caught → empty board
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return model; // SR-8: oversize/non-file status.yaml → empty board
    }
    statusText = readFileSync(statusPath, 'utf-8');
    realRoot = realpathSync(root); // pre-realpath the root once for SR-2
  } catch {
    return model; // absent/unreadable → empty board, never a crash (SR-3/SR-7)
  }

  let index: ReturnType<typeof safeParseStatusIndex>;
  try {
    index = safeParseStatusIndex(statusText); // SR-4: safe YAML + null-proto
  } catch {
    return model; // unparseable status.yaml → empty board
  }

  for (const [key, entry] of Object.entries(index.tickets)) {
    const column = byStatus.get(entry.column); // always present (parse filtered)
    if (column === undefined) continue;
    try {
      column.tickets.push(buildCard(root, realRoot, key, entry));
    } catch {
      // SR-3: degrade this ONE card with trusted index-only data; keep going.
      column.tickets.push(placeholderCard(key, entry.column));
    }
  }

  return model;
}
