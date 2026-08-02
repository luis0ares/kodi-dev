import type { ReadyResult, TicketRef } from './types.js';

/**
 * Readiness computed from the NOT-DONE listing alone — the shared rule behind
 * every provider's `listReady`.
 *
 * A dependency blocks only while it is still VISIBLE in that listing. A key the
 * listing does not contain is Done (or matches nothing) and cannot block. That
 * inversion is what lets a provider skip the Done column entirely: the older rule
 * — "unmet unless proven Done" — had to fetch the whole Done set on every call
 * just to prove blockers were finished, which is precisely the cost that made
 * remote listings fail.
 *
 * The one behaviour it gives up: a typoed dependency key now reads as satisfied
 * instead of blocking its ticket forever. `tickets create` / `tickets amend` warn
 * about unknown keys at write time, which is where a typo is actually fixable.
 */
export function readyFromActive(refs: TicketRef[]): ReadyResult {
  // Tolerate a caller that passed an --all listing: Done can never block.
  const active = refs.filter((t) => t.status !== 'Done');
  const visible = new Set(active.map((t) => t.key));
  const ready: TicketRef[] = [];
  const blocked: ReadyResult['blocked'] = [];
  for (const t of active) {
    if (t.status !== 'Pending') continue;
    const unmet = t.dependencies.filter((d) => visible.has(d));
    if (unmet.length === 0) ready.push(t);
    else blocked.push({ ticket: t, blockedBy: unmet });
  }
  return { ready, blocked };
}
