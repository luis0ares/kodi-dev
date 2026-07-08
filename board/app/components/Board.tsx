'use client';

// Board — the whole app (design-system §2.1). A 5-track horizontal grid of fixed
// columns in enum order (never reordered by data — R-012). This client component
// OWNS the expansion registry: a Set of expanded ticket.key values (§5.4). Toggling
// updates the set only — no disk write, no server call (view-state, R-014). Cards
// are keyed by ticket.key so KODI-013/014 can add live moves + arrival highlights
// without a refactor; NO SSE/watch/animation/live-region is implemented here.

import { useCallback, useState } from 'react';
import type { BoardModel } from '@/lib/tickets/types';
import { Column } from './Column';

export function Board({ model }: { model: BoardModel }) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Empty-board register (register 2) is DERIVED: every column has 0 tickets.
  const isEmptyBoard = model.columns.every((col) => col.tickets.length === 0);

  return (
    <main className="flex h-screen flex-col gap-4 bg-base-100 p-4">
      <h1 className="sr-only">kodi board</h1>

      {isEmptyBoard && <EmptyBoardHint />}

      <div className="grid min-h-0 flex-1 grid-cols-5 gap-4">
        {model.columns.map((column, i) => (
          <Column
            key={column.status}
            column={column}
            headingId={`col-heading-${i}`}
            expandedKeys={expandedKeys}
            onToggle={toggle}
          />
        ))}
      </div>
    </main>
  );
}

/**
 * Board-level empty hint (register 2 / §7). Informational — a plain `alert` WITHOUT
 * an error color, so it stays visually distinct from the in-column "No tickets"
 * (register 1) and the problem-styled read error (register 4).
 */
function EmptyBoardHint() {
  return (
    <div role="status" className="alert bg-base-200 text-base-content/80">
      <div className="flex flex-col">
        <span className="font-medium">No tickets yet.</span>
        <span className="text-sm">
          Create one with <code className="font-mono">kodi tickets create</code>.
        </span>
      </div>
    </div>
  );
}
