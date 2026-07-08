'use client';

// Board — the whole app (design-system §2.1). A 5-track horizontal grid of fixed
// columns in enum order (never reordered by data — R-012). This client component
// OWNS the expansion registry (§5.4), the ephemeral arrival-highlight state (§5.2),
// the FLIP position transition (§5.2), and the single ARIA live region (§5.3).
//
// All live-update polish sits ON TOP of the existing key-based render path: cards are
// keyed by ticket.key so a move re-parents (not recreates) the element, and expansion
// stays keyed by ticket.key so it survives a move (§5.4). Nothing here touches the
// SSE transport (that is LiveBoard) or adds a field to the model.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BoardModel, BoardTicket, TicketStatus } from '@/lib/tickets/types';
import { Column } from './Column';
import { TicketModal } from './TicketModal';
import { prefersReducedMotion } from './ui';

/** How long the one-shot arrival highlight lingers before it self-decays (§5.2, ~2s). */
const ARRIVAL_MS = 2000;
/** FLIP position-transition duration (§5.2, within the 200–400ms band). */
const FLIP_MS = 300;

export function Board({ model }: { model: BoardModel }) {
  // The modal NAVIGATION STACK: the last entry is the ticket currently shown in the
  // detail dialog; earlier entries are the trail of tickets we drilled in FROM (via
  // dependency links), so "Back" can walk it recursively (A → dep X → dep Y → …). A
  // single Board-level dialog (rendered only while the stack is non-empty) replaces
  // the old per-card expansion registry — opening/navigating is view-state only
  // (R-014), never a mutation.
  const [navStack, setNavStack] = useState<BoardTicket[]>([]);
  const current = navStack.length > 0 ? navStack[navStack.length - 1] : null;

  // key → ticket, across every column, so a dependency KEY on the open ticket can be
  // resolved to a real card to navigate into (unknown keys stay plain text).
  const ticketsByKey = useMemo(() => {
    const map = new Map<string, BoardTicket>();
    for (const column of model.columns) {
      for (const ticket of column.tickets) map.set(ticket.key, ticket);
    }
    return map;
  }, [model]);

  // Ephemeral arrival-highlight state (§5.2): a Set of ticket.key values currently
  // pulsing, each cleared by its own ~2s timer. This is VIEW state only — there is NO
  // persistent "changed"/"unread" flag on BoardTicket/BoardModel.
  const [arrivingKeys, setArrivingKeys] = useState<Set<string>>(() => new Set());
  // Single polite announcement string (§5.3), composed ONLY from ticket.key + the
  // existing status label — no new projected field.
  const [announcement, setAnnouncement] = useState('');

  // The grid element the FLIP measures within (queried by [data-ticket-key]).
  const gridRef = useRef<HTMLDivElement>(null);
  // Previous status per ticket.key — to detect a column change between renders.
  const prevStatusRef = useRef<Map<string, TicketStatus> | null>(null);
  // Previous card geometry per ticket.key — the FLIP "first" rects.
  const prevRectsRef = useRef<Map<string, DOMRect>>(new Map());
  // Pending arrival timers, keyed by ticket.key, so we can clear them on unmount.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Detect moves, run the FLIP (§5.2), fire the arrival highlight (§5.2) + the polite
  // announcement (§5.3). Runs before paint so the inverse transform lands with no flash.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const nodes = grid.querySelectorAll<HTMLElement>('[data-ticket-key]');

    // "Last" rects — measured BEFORE any transform is applied, so this doubles as both
    // the FLIP end position and the snapshot for the next render.
    const lastRects = new Map<string, DOMRect>();
    nodes.forEach((node) => {
      const key = node.dataset.ticketKey;
      if (key) lastRects.set(key, node.getBoundingClientRect());
    });

    const prevStatus = prevStatusRef.current;
    const firstRects = prevRectsRef.current;

    // Which tickets changed column since the last render.
    const currentStatus = new Map<string, TicketStatus>();
    const moved: Array<{ key: string; status: TicketStatus }> = [];
    for (const column of model.columns) {
      for (const ticket of column.tickets) {
        currentStatus.set(ticket.key, ticket.status);
        const before = prevStatus?.get(ticket.key);
        if (before !== undefined && before !== ticket.status) {
          moved.push({ key: ticket.key, status: ticket.status });
        }
      }
    }

    if (moved.length > 0) {
      const reduced = prefersReducedMotion();

      // §5.2 FLIP — inverse-transform then transition back to rest. Geometry (numbers)
      // only; never derived from ticket string content. §5.6 guard: skip entirely under
      // reduced motion so the card simply appears in its new column (no slide).
      if (!reduced) {
        nodes.forEach((node) => {
          const key = node.dataset.ticketKey;
          if (!key) return;
          const first = firstRects.get(key);
          const last = lastRects.get(key);
          if (!first || !last) return;
          const dx = first.left - last.left;
          const dy = first.top - last.top;
          if (dx === 0 && dy === 0) return;

          // Invert: pin the element at its old position with no transition.
          node.style.transition = 'none';
          node.style.transform = `translate(${dx}px, ${dy}px)`;

          // Play: on the next frame, transition the transform away to its new home.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const clear = () => {
                node.style.transition = '';
                node.style.transform = '';
              };
              node.addEventListener('transitionend', clear, { once: true });
              node.style.transition = `transform ${FLIP_MS}ms ease`;
              node.style.transform = '';
            });
          });
        });
      }

      // §5.2 arrival highlight + §5.3 announcement. Deferred to the next frame so the
      // state updates are not dispatched synchronously inside the layout effect (React
      // cascading-render guard); the FLIP above has already started the move motion, so
      // a one-frame-later pulse is imperceptible. Fires under reduced motion too
      // (globals.css keeps a static tint there). Each key is cleared by its own ~2s timer.
      requestAnimationFrame(() => {
        setArrivingKeys((prev) => {
          const next = new Set(prev);
          for (const m of moved) next.add(m.key);
          return next;
        });
        for (const m of moved) {
          const existing = timersRef.current.get(m.key);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            timersRef.current.delete(m.key);
            setArrivingKeys((prev) => {
              if (!prev.has(m.key)) return prev;
              const next = new Set(prev);
              next.delete(m.key);
              return next;
            });
          }, ARRIVAL_MS);
          timersRef.current.set(m.key, timer);
        }

        // §5.3 ONE polite announcement, terse and combined for a multi-move update.
        // Text is JSX-escaped downstream; key + verbatim status label only.
        setAnnouncement(moved.map((m) => `${m.key} moved to ${m.status}.`).join(' '));
      });
    }

    prevRectsRef.current = lastRects;
    prevStatusRef.current = currentStatus;
  }, [model]);

  // Clean up any still-pending arrival timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // Empty-board register (register 2) is DERIVED: every column has 0 tickets.
  const isEmptyBoard = model.columns.every((col) => col.tickets.length === 0);

  return (
    <main className="flex h-screen flex-col gap-4 bg-base-100 p-4">
      <h1 className="sr-only">kodi board</h1>

      {/*
        §5.3 — the ONE polite, visually-hidden live region for the whole board. A move
        (or a burst of moves) is announced here as a single terse message; column-count
        changes are conveyed by the same announcement (no per-count region → no chatter).
        Polite, never assertive: the move is confirmation, not an alert (research §4).
      */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      {isEmptyBoard && <EmptyBoardHint />}

      <div ref={gridRef} className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2">
        {model.columns.map((column, i) => (
          <Column
            key={column.status}
            column={column}
            headingId={`col-heading-${i}`}
            arrivingKeys={arrivingKeys}
            // Opening a card from the board STARTS a fresh navigation stack.
            onOpen={(ticket) => setNavStack([ticket])}
          />
        ))}
      </div>

      {/* The ONE detail dialog for the whole board — mounted only while the stack is
          non-empty, so a board with nothing open has no dialog in the DOM. Dependency
          links push onto the stack; Back pops it; Close clears it. */}
      {current && (
        <TicketModal
          ticket={current}
          canGoBack={navStack.length > 1}
          onBack={() => setNavStack((stack) => stack.slice(0, -1))}
          onClose={() => setNavStack([])}
          resolveDependency={(key) => ticketsByKey.get(key)}
          onOpenDependency={(ticket) => setNavStack((stack) => [...stack, ticket])}
        />
      )}
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
