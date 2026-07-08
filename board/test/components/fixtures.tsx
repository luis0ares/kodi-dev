// Deterministic in-memory fixtures for the KODI-010 UI component tests. No fs,
// no yaml, no network — just plain `BoardModel` / `BoardTicket` objects shaped
// like the KODI-009 §7 projection. `makeTicket` returns the minimal valid card
// (empty deps/drivers, one AC) and every field is overridable, so each test
// builds exactly the shape it needs (rich card, degraded card, hostile prUrl…).

import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { Card } from '@/app/components/Card';
import type { BoardModel, BoardTicket } from '@/lib/tickets/types';
import { TICKET_STATUSES } from '@/lib/tickets/types';

/** The verbatim §8 column labels in their fixed R-012 render order. */
export const ORDERED_LABELS = [
  'Pending',
  'In progress',
  'To review',
  'Done',
  'Blocked',
] as const;

/** A minimal, valid §7 card (no optional fields set). Fully overridable. */
export function makeTicket(overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    key: 'KODI-001',
    title: 'A ticket title',
    status: 'Pending',
    dependencies: [],
    drivers: { adr: [] },
    summary: 'A one-line summary.',
    acceptanceCriteria: ['The board renders.'],
    ...overrides,
  };
}

/** The empty board: all five columns present, every column with zero tickets. */
export function emptyBoardModel(): BoardModel {
  return { columns: TICKET_STATUSES.map((status) => ({ status, tickets: [] })) };
}

/**
 * Build a five-column model, distributing the given tickets into their columns
 * by `ticket.status` (columns with no tickets still render — R-012).
 */
export function boardWith(...tickets: BoardTicket[]): BoardModel {
  return {
    columns: TICKET_STATUSES.map((status) => ({
      status,
      tickets: tickets.filter((t) => t.status === status),
    })),
  };
}

const noop = () => {};

/**
 * Render a single `Card` with a controlled `arriving` prop and a no-op open handler.
 * `arriving` defaults to false (the KODI-014 one-shot arrival highlight is off unless
 * a test opts in). The card face is identity + tags only; the heavier §7 fields live
 * in the Board-level modal, so single-Card tests assert the face, and modal behavior
 * is covered through the full <Board> render.
 */
export function renderCard(ticket: BoardTicket, arriving = false) {
  return render(<Card ticket={ticket} arriving={arriving} onOpen={noop} />);
}

/** Cast a Next segment component (typed as prop-less) so tests may pass props. */
export function asComponent<P>(component: unknown): (props: P) => ReactElement {
  return component as (props: P) => ReactElement;
}
