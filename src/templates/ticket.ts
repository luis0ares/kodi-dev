import { z } from 'zod';

/**
 * The ticket template IS this schema. A draft is validated against it before
 * anything is written or sent to a provider. Same philosophy as the PR
 * template: the typed model is the single source of truth for a ticket's shape.
 */

export const TICKET_STATUSES = [
  'Pending',
  'In progress',
  'To review',
  'Done',
  'Blocked',
] as const;

export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const TicketDriversSchema = z.object({
  /** PRD this ticket advances, e.g. "docs/prd/0001". */
  prd: z.string().optional(),
  /** Governing ADR(s), e.g. ["docs/adr/0003"]. */
  adr: z.array(z.string()).default([]),
  /** Security finding remediated, e.g. "docs/security/AUTH-014". */
  security: z.string().optional(),
});
export type TicketDrivers = z.infer<typeof TicketDriversSchema>;

/**
 * A ticket draft as authored (before a key/slug is assigned by the provider).
 * `key` and `slug` are optional here and filled in on create.
 */
export const TicketSchema = z.object({
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9]*-\d+$/, 'key must look like PREFIX-123')
    .optional(),
  title: z.string().min(3, 'title must be at least 3 characters'),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case')
    .optional(),
  status: TicketStatusSchema.default('Pending'),
  summary: z.string().min(1, 'summary is required'),
  acceptanceCriteria: z
    .array(z.string().min(1))
    .min(1, 'at least one acceptance criterion is required'),
  nonGoals: z.array(z.string().min(1)).default([]),
  /** Ticket keys that must reach Done before this one can start. */
  dependencies: z.array(z.string()).default([]),
  drivers: TicketDriversSchema.default({}),
  /** Linked pull request (branch, URL, or id) — set by `link-pr` / `hand-off`. */
  prUrl: z.string().optional(),
  notes: z.string().optional(),
});

export type TicketInput = z.input<typeof TicketSchema>;
export type Ticket = z.infer<typeof TicketSchema>;

/** A fully-persisted ticket always has a key and slug. */
export type StoredTicket = Ticket & { key: string; slug: string };

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** Render the human-readable markdown body for a stored ticket. */
export function renderTicketMarkdown(t: StoredTicket): string {
  const lines: string[] = [];
  lines.push(`# ${t.key} — ${t.title}`, '');
  lines.push(`**Status:** ${t.status}`);
  if (t.dependencies.length) {
    lines.push(`**Depends on:** ${t.dependencies.join(', ')}`);
  }
  const drivers: string[] = [];
  if (t.drivers.prd) drivers.push(`PRD ${t.drivers.prd}`);
  if (t.drivers.adr.length) drivers.push(`ADR ${t.drivers.adr.join(', ')}`);
  if (t.drivers.security) drivers.push(`Security ${t.drivers.security}`);
  if (drivers.length) lines.push(`**Drivers:** ${drivers.join(' · ')}`);
  if (t.prUrl) lines.push(`**PR:** ${t.prUrl}`);
  lines.push('', '## Summary', '', t.summary, '');
  lines.push('## Acceptance criteria', '');
  for (const ac of t.acceptanceCriteria) lines.push(`- [ ] ${ac}`);
  lines.push('');
  if (t.nonGoals.length) {
    lines.push('## Non-goals', '');
    for (const ng of t.nonGoals) lines.push(`- ${ng}`);
    lines.push('');
  }
  if (t.notes) lines.push('## Notes', '', t.notes, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
