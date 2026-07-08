// Card — the progressive-disclosure ticket unit (design-system §2.3, research §2).
// One component, two variants driven by an EXTERNAL `expanded` boolean (the Board
// owns the registry keyed by ticket.key, §5.4). The disclosure control is a native
// <button> (button semantics, keyboard-operable, aria-expanded/aria-controls, §8);
// expansion is VIEW-STATE only — no mutation, no disk write (R-014).
//
// §7 fields ONLY. Absence renders NOTHING (§3): no "—"/"None"/placeholder for any
// absent optional field. All strings render as TEXT NODES (React auto-escape) —
// no dangerouslySetInnerHTML, no markdown-to-HTML (security req 1).

import type { BoardTicket } from '@/lib/tickets/types';
import { STATUS_LEFT, hasText, safeHttpUrl } from './ui';

interface CardProps {
  ticket: BoardTicket;
  expanded: boolean;
  onToggle: (key: string) => void;
}

export function Card({ ticket, expanded, onToggle }: CardProps) {
  const contentId = `card-content-${ticket.key}`;
  const depCount = ticket.dependencies.length;
  const hasAdr = ticket.drivers.adr.length > 0;
  const hasPrd = hasText(ticket.drivers.prd);
  const hasSec = hasText(ticket.drivers.security);
  const hasMeta = depCount > 0 || hasAdr || hasPrd || hasSec;

  return (
    // `card` + daisyUI `collapse`, EXTERNALLY controlled via collapse-open/close
    // (not the uncontrolled checkbox/tabindex self-state — §2.3). Keyed by
    // ticket.key at the Column level so KODI-014 can add arriving/transitions
    // without a refactor. Thin LEFT status edge (accent only, §2.2).
    <article
      className={`card card-sm collapse collapse-arrow border-l-4 bg-base-200 ${
        STATUS_LEFT[ticket.status]
      } ${expanded ? 'collapse-open' : 'collapse-close'}`}
    >
      <button
        type="button"
        onClick={() => onToggle(ticket.key)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className="collapse-title flex w-full cursor-pointer flex-col gap-2 text-left"
      >
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-xs break-words opacity-70">{ticket.key}</span>
          <span className="font-semibold break-words">{ticket.title}</span>
        </span>

        {hasText(ticket.summary) && (
          <span className="line-clamp-2 text-sm break-words text-base-content/80">
            {ticket.summary}
          </span>
        )}

        {hasMeta && (
          <span className="flex flex-wrap gap-1">
            {depCount > 0 && (
              <span className="badge badge-sm badge-ghost">{depCount} deps</span>
            )}
            {hasAdr && <span className="badge badge-sm badge-outline">ADR</span>}
            {hasPrd && <span className="badge badge-sm badge-outline">PRD</span>}
            {hasSec && <span className="badge badge-sm badge-outline">SEC</span>}
          </span>
        )}
      </button>

      <div id={contentId} className="collapse-content">
        <ExpandedBody ticket={ticket} />
      </div>
    </article>
  );
}

/** The expanded read unit (§2.3). Each row omitted entirely when its value is absent. */
function ExpandedBody({ ticket }: { ticket: BoardTicket }) {
  const { dependencies, drivers, acceptanceCriteria, prUrl, notes } = ticket;
  const href = safeHttpUrl(prUrl); // security req 2 — scheme allow-list

  return (
    <div className="flex flex-col gap-3 text-sm">
      {dependencies.length > 0 && (
        <section>
          <h3 className="mb-1 font-semibold">Dependencies</h3>
          <ul className="list-inside list-disc break-words">
            {dependencies.map((dep) => (
              <li key={dep}>{dep}</li>
            ))}
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
