// Shared presentational helpers for the board UI (design-system §4 color map,
// §7 render rules). No data access, no mutation — pure mapping/validation.

import type { TicketStatus } from '@/lib/tickets/types';

// §4 status → daisyUI semantic color. daisyUI SEMANTIC classes only (never raw
// Tailwind palette). `primary` is RESERVED for the prUrl link accent (§4), so no
// status claims it. Full class literals so Tailwind's JIT scanner picks them up.

/** Count-badge color per status (the tinted accent, §2.2). */
export const STATUS_BADGE: Record<TicketStatus, string> = {
  Pending: 'badge-neutral',
  'In progress': 'badge-info',
  'To review': 'badge-warning',
  Done: 'badge-success',
};

/** Column thin TOP status edge color (§2.2 — accent, not a full fill). */
export const STATUS_TOP: Record<TicketStatus, string> = {
  Pending: 'border-t-neutral',
  'In progress': 'border-t-info',
  'To review': 'border-t-warning',
  Done: 'border-t-success',
};

/** Card thin LEFT status edge color (§2.2 — matches the card's column). */
export const STATUS_LEFT: Record<TicketStatus, string> = {
  Pending: 'border-l-neutral',
  'In progress': 'border-l-info',
  'To review': 'border-l-warning',
  Done: 'border-l-success',
};

/**
 * One-shot arrival tint per status (§5.2 / §5.6). Selects the CSS custom-property
 * hook (`arrive-*`) that `.kodi-arriving` in globals.css color-mixes into the card
 * background at low intensity — the NEW column's status color. Driven purely by the
 * ticket's (index-derived) status via a class name, NEVER by an inline style built
 * from ticket data (security: no dynamic style from ticket content).
 */
export const STATUS_ARRIVE: Record<TicketStatus, string> = {
  Pending: 'arrive-neutral',
  'In progress': 'arrive-info',
  'To review': 'arrive-warning',
  Done: 'arrive-success',
};

/**
 * SSR/test-safe reduced-motion probe (§5.6). Returns false when `window` or
 * `matchMedia` is absent, and never throws — a missing/absent matchMedia must not
 * break the SSE render path. Used to guard the JS FLIP (skip transforms) while the
 * static arrival tint + ARIA announcement still fire.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Security req 2 — the prUrl scheme allow-list. Returns the normalized href ONLY
 * when the value is a non-empty `http:`/`https:` URL; otherwise null (rejecting
 * `javascript:`/`data:`/`vbscript:`/`file:` and protocol-relative `//host`).
 * The caller renders the anchor iff this returns non-null.
 */
export function safeHttpUrl(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('//')) return null; // protocol-relative — reject
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/**
 * Treat empty / whitespace-only optional strings as ABSENT (§3 + KODI-009 edge
 * note). Used to gate the `notes` block and any optional string field.
 */
export function hasText(value: string | undefined | null): value is string {
  return value != null && value.trim().length > 0;
}
