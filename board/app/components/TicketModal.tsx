'use client';

// TicketModal — the ticket detail dialog (replaces the in-card collapse, §2.3).
// The card face now shows ONLY identity + tags; every heavier §7 field is read
// here, in a modal opened on card click. One dialog lives at the Board level and
// is rendered ONLY while a ticket is selected, so a closed board has no dialog in
// the DOM at all.
//
// Native <dialog> + daisyUI `modal` markup: `showModal()` gives real modal
// semantics (focus trap, ESC, inert background) in the browser; where that API is
// absent (jsdom / very old engines) we fall back to the `open` attribute so the
// content is still shown and testable. ESC / backdrop / ✕ all route back through
// `onClose` so the Board's selection state stays the single source of truth.
//
// Content rules are unchanged from the old card body: §7 fields ONLY, absence
// renders NOTHING (§3 — no "—"/"None"/placeholder), every string is a React text
// node (auto-escaped — security req 1: no dangerouslySetInnerHTML, no markdown→HTML),
// and the prUrl passes the scheme allow-list at the render seam (security req 2).

import { useEffect, useRef } from 'react';
import type { BoardTicket } from '@/lib/tickets/types';
import { STATUS_BADGE, hasText, safeHttpUrl } from './ui';

interface TicketModalProps {
  ticket: BoardTicket;
  /** True when there is a ticket to return to (we drilled in via a dependency). */
  canGoBack: boolean;
  /** Pop the navigation stack — return to the ticket we came from. */
  onBack: () => void;
  onClose: () => void;
  /** Resolve a dependency KEY to a real ticket, or undefined when it is unknown. */
  resolveDependency: (key: string) => BoardTicket | undefined;
  /** Navigate INTO a dependency ticket (pushes onto the stack). */
  onOpenDependency: (ticket: BoardTicket) => void;
}

export function TicketModal({
  ticket,
  canGoBack,
  onBack,
  onClose,
  resolveDependency,
  onOpenDependency,
}: TicketModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `modal-title-${ticket.key}`;

  // Open on mount, close on unmount. Feature-detect showModal so a runtime without
  // the native modal API (jsdom) still reveals the dialog via the `open` attribute.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch {
        dialog.open = true;
      }
    } else {
      dialog.open = true;
    }
    return () => {
      if (typeof dialog.close === 'function' && dialog.open) {
        try {
          dialog.close();
        } catch {
          dialog.open = false;
        }
      } else {
        dialog.open = false;
      }
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal modal-bottom sm:modal-middle"
      aria-labelledby={titleId}
      // ESC / native close both settle back into the Board's selection state.
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="modal-box max-w-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="btn btn-sm btn-circle btn-ghost absolute top-2 right-2"
        >
          ✕
        </button>

        {/* Present only when we drilled in via a dependency — walks the stack back. */}
        {canGoBack && (
          <button type="button" onClick={onBack} className="btn btn-ghost btn-xs mb-2 -ml-1">
            ← Back
          </button>
        )}

        <header className="flex flex-col gap-2 pr-8">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs break-words opacity-70">{ticket.key}</span>
            <span className={`badge badge-sm ${STATUS_BADGE[ticket.status]}`}>{ticket.status}</span>
          </div>
          <h2 id={titleId} className="text-lg font-semibold break-words">
            {ticket.title}
          </h2>
        </header>

        {hasText(ticket.summary) && (
          <p className="mt-3 break-words text-base-content/80">{ticket.summary}</p>
        )}

        <TicketDetails
          ticket={ticket}
          resolveDependency={resolveDependency}
          onOpenDependency={onOpenDependency}
        />
      </div>

      {/* Clicking outside the box closes the modal (daisyUI backdrop pattern). */}
      <button type="button" onClick={onClose} aria-label="Close" className="modal-backdrop">
        close
      </button>
    </dialog>
  );
}

/** The §7 detail rows. Each section is omitted entirely when its value is absent. */
function TicketDetails({
  ticket,
  resolveDependency,
  onOpenDependency,
}: {
  ticket: BoardTicket;
  resolveDependency: (key: string) => BoardTicket | undefined;
  onOpenDependency: (ticket: BoardTicket) => void;
}) {
  const { dependencies, drivers, acceptanceCriteria, prUrl, notes } = ticket;
  const href = safeHttpUrl(prUrl); // security req 2 — scheme allow-list

  return (
    <div className="mt-4 flex flex-col gap-3 text-sm">
      {dependencies.length > 0 && (
        <section>
          <h3 className="mb-1 font-semibold">Dependencies</h3>
          <ul className="list-inside list-disc break-words">
            {dependencies.map((dep) => {
              // A dependency KEY that resolves to a real card on this board becomes a
              // link that navigates INTO it (recursive drill-down); an unresolved key
              // (not on the board) stays plain text — never a dead link.
              const target = resolveDependency(dep);
              return (
                <li key={dep}>
                  {target ? (
                    <button
                      type="button"
                      onClick={() => onOpenDependency(target)}
                      className="link link-primary break-words"
                    >
                      {dep}
                    </button>
                  ) : (
                    dep
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {drivers.adr.length > 0 && (
        <section>
          <h3 className="mb-1 font-semibold">ADR</h3>
          <ul className="list-inside list-disc break-words">
            {drivers.adr.map((adr) => (
              <li key={adr}>{adr}</li>
            ))}
          </ul>
        </section>
      )}

      {hasText(drivers.prd) && (
        <section>
          <h3 className="mb-1 font-semibold">PRD</h3>
          <p className="break-words">{drivers.prd}</p>
        </section>
      )}

      {hasText(drivers.security) && (
        <section>
          <h3 className="mb-1 font-semibold">Security</h3>
          <p className="break-words">{drivers.security}</p>
        </section>
      )}

      {acceptanceCriteria.length > 0 && (
        <section>
          <h3 className="mb-1 font-semibold">Acceptance criteria</h3>
          <ul className="list-inside list-disc break-words">
            {acceptanceCriteria.map((ac, i) => (
              <li key={i}>{ac}</li>
            ))}
          </ul>
        </section>
      )}

      {href !== null && (
        <p>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="link link-primary break-words"
          >
            {href}
          </a>
        </p>
      )}

      {hasText(notes) && (
        <section>
          <h3 className="mb-1 font-semibold">Notes</h3>
          <p className="break-words whitespace-pre-wrap">{notes}</p>
        </section>
      )}
    </div>
  );
}
