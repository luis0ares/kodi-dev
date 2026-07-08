// Card — the ticket scan unit (design-system §2.3, research §2). The card face is
// now a single click target that shows ONLY the ticket identity (key + title) and
// the driver/dependency TAGS; every heavier §7 field is read in the Board-level
// TicketModal opened by `onOpen` (progressive disclosure via a dialog, not an inline
// collapse). The trigger is a native <button> (button semantics, keyboard-operable),
// and opening is VIEW-STATE only — no mutation, no disk write (R-014).
//
// §7 fields ONLY. Absence renders NOTHING (§3): no "—"/"None"/placeholder for any
// absent optional field. All strings render as TEXT NODES (React auto-escape) —
// no dangerouslySetInnerHTML, no markdown-to-HTML (security req 1).

import type { BoardTicket } from '@/lib/tickets/types';
import { STATUS_ARRIVE, STATUS_LEFT, hasText } from './ui';

interface CardProps {
  ticket: BoardTicket;
  /**
   * One-shot arrival highlight (§5.2 / design-system §2.3 Card contract). EPHEMERAL
   * UI state only — a brief settle/pulse tint in the new column's status color that
   * auto-expires (~2s) via a Board timer. Never a persistent model flag.
   */
  arriving: boolean;
  /** Open the detail modal for this ticket (Board owns the selection state). */
  onOpen: (ticket: BoardTicket) => void;
}

export function Card({ ticket, arriving, onOpen }: CardProps) {
  const depCount = ticket.dependencies.length;
  const hasAdr = ticket.drivers.adr.length > 0;
  const hasPrd = hasText(ticket.drivers.prd);
  const hasSec = hasText(ticket.drivers.security);
  const hasMeta = depCount > 0 || hasAdr || hasPrd || hasSec;

  return (
    // Thin LEFT status edge (accent only, §2.2), lighter card surface over the slate
    // column. `data-ticket-key` is the STABLE handle Board's FLIP (§5.2) measures by:
    // a live move re-parents this element across column DOM subtrees, so the animation
    // is keyed to the ticket, not to a held (stale) node ref. When `arriving`, the
    // one-shot tint classes fire; `motion-reduce:animate-none` drops the pulse motion
    // under reduced motion while globals.css keeps the static tint (§5.6).
    <article
      data-ticket-key={ticket.key}
      className={`card card-sm border-l-4 bg-base-100 shadow-sm ${STATUS_LEFT[ticket.status]} ${
        arriving ? `kodi-arriving ${STATUS_ARRIVE[ticket.status]} motion-reduce:animate-none` : ''
      }`}
    >
      <button
        type="button"
        onClick={() => onOpen(ticket)}
        className="flex w-full cursor-pointer flex-col gap-2 p-3 text-left"
      >
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-xs break-words opacity-70">{ticket.key}</span>
          <span className="font-semibold break-words">{ticket.title}</span>
        </span>

        {hasMeta && (
          <span className="flex flex-wrap gap-1">
            {depCount > 0 && <span className="badge badge-sm badge-ghost">{depCount} deps</span>}
            {hasAdr && <span className="badge badge-sm badge-outline">ADR</span>}
            {hasPrd && <span className="badge badge-sm badge-outline">PRD</span>}
            {hasSec && <span className="badge badge-sm badge-outline">SEC</span>}
          </span>
        )}
      </button>
    </article>
  );
}
