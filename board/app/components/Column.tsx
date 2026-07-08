// Column — one fixed status track (design-system §2.2). Fixed width (w-72) and
// non-shrinking, sitting in a horizontally-scrollable row so tracks keep a stable
// size instead of squeezing; a slate `bg-base-200` fill makes each track boundary
// legible. Always renders with header + live count, even when empty (R-012). Header
// is a semantic <h2> with the VERBATIM enum label; the status color tints the count
// badge + a thin top status edge (accent, not a full fill). Body is independently
// vertically scrollable
// with the header staying visible. Empty column shows the quiet in-column "No tickets"
// placeholder (register 1) — the ONE intentional placeholder in the system (§3).

import type { BoardColumn, BoardTicket } from '@/lib/tickets/types';
import { STATUS_BADGE, STATUS_TOP } from './ui';
import { Card } from './Card';

interface ColumnProps {
  column: BoardColumn;
  headingId: string;
  /** Ephemeral set of ticket.key values currently showing the arrival highlight (§5.2). */
  arrivingKeys: Set<string>;
  /** Open the detail modal for a ticket (Board owns the selection state). */
  onOpen: (ticket: BoardTicket) => void;
}

export function Column({ column, headingId, arrivingKeys, onOpen }: ColumnProps) {
  const count = column.tickets.length;

  return (
    <section
      role="group"
      aria-labelledby={headingId}
      className={`flex min-h-0 min-w-96 w-1/4 shrink-0 flex-col rounded-box border-t-4 bg-base-200 ${STATUS_TOP[column.status]}`}
    >
      <div className="flex items-center justify-between gap-2 px-2 pt-3 pb-2">
        <h2 id={headingId} className="text-sm font-semibold">
          {column.status}
        </h2>
        <span className={`badge badge-sm ${STATUS_BADGE[column.status]}`}>{count}</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {count === 0 ? (
          <p className="text-sm text-base-content/60">No tickets</p>
        ) : (
          column.tickets.map((ticket) => (
            <Card
              key={ticket.key}
              ticket={ticket}
              arriving={arrivingKeys.has(ticket.key)}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </section>
  );
}
