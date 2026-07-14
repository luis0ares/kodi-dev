import { z } from 'zod';
import { mdToHtml } from '../html.js';

/**
 * The PR template IS this schema — same philosophy as the ticket template. A
 * draft is validated before anything is rendered or sent to gh/az.
 *
 * Unlike the ticket body, the PR body has a FIXED shape: every top-level section
 * (Summary, Type of Change, Included Changes, Related Issues / Work Items,
 * Testing, Checklist) is always rendered so the created PR matches the repo's
 * template exactly. Notes is the only optional section. The three checkbox
 * groups that carry data — Type of Change and Testing — must have at least one
 * box checked or validation fails; the Checklist is rendered blank for the human
 * to tick after the PR exists.
 */

/** At least one boolean in a checkbox group must be set. */
const anyChecked = (o: Record<string, boolean>) => Object.values(o).some(Boolean);

// The "at least one box checked" rule lives ON each checkbox schema (not as a
// top-level refine) so Zod reports a missing group alongside any other section
// error in a single pass, rather than only after every other field validates.
const TypeOfChangeSchema = z
  .object({
    feature: z.boolean().default(false),
    fix: z.boolean().default(false),
    improvement: z.boolean().default(false),
    refactor: z.boolean().default(false),
    documentation: z.boolean().default(false),
  })
  .default({})
  .refine(anyChecked, {
    message: 'Type of Change: select at least one (feature/fix/improvement/refactor/documentation)',
  });

const TestingSchema = z
  .object({
    unit: z.boolean().default(false),
    integration: z.boolean().default(false),
    manual: z.boolean().default(false),
    na: z.boolean().default(false),
  })
  .default({})
  .refine(anyChecked, {
    message: 'Testing: select at least one (unit/integration/manual/na)',
  });

export const PrSchema = z.object({
  title: z.string().min(3, 'title must be at least 3 characters'),
  summary: z.string().min(1, 'summary is required'),
  /** Type of Change checkboxes — at least one must be selected. */
  typeOfChange: TypeOfChangeSchema,
  features: z.array(z.string().min(1)).default([]),
  fixes: z.array(z.string().min(1)).default([]),
  improvements: z.array(z.string().min(1)).default([]),
  /** Required section (the template marks it non-deletable). Pass "N/A" when a
   * PR genuinely references no issue or work item. */
  relatedIssues: z
    .array(z.string().min(1))
    .min(1, 'Related Issues / Work Items: add at least one entry (use "N/A" if none)'),
  /** Testing checkboxes — at least one must be selected (N/A counts). */
  testing: TestingSchema,
  notes: z.string().optional(),
  reviewers: z.array(z.string().min(1)).default([]),
});

export type PrInput = z.input<typeof PrSchema>;
export type Pr = z.infer<typeof PrSchema>;

/**
 * Both GitHub and Azure DevOps turn "#" immediately followed by a number into a
 * link to an internal resource (issue / work item / PR). Nothing in our free-text
 * fields intends that, so break the "#<number>" adjacency with a zero-width space:
 * it renders as "#1010" but no longer autolinks. A ZWSP is used rather than a
 * backslash escape because it survives the markdown→HTML conversion Azure uses (a
 * backslash is stripped, re-exposing "#1010" to Azure's linkifier). The one place
 * a reference IS intended — the Related issues section — is left untouched.
 */
function neutralizeAutolinks(text: string): string {
  return text.replace(/#(?=\d)/g, '#\u200B');
}

/** Hard cap on the PR body length. Azure DevOps rejects descriptions over 4000
 * chars; we enforce the same ceiling for every provider so bodies stay portable. */
export const MAX_PR_BODY = 4000;

/** Enforce {@link MAX_PR_BODY} on a rendered body. Throws so the CLI refuses to
 * create an over-limit PR rather than let the provider reject or truncate it. */
export function assertWithinBodyLimit(body: string): void {
  if (body.length > MAX_PR_BODY) {
    throw new Error(
      `PR body is ${body.length} chars; the limit is ${MAX_PR_BODY}. ` +
        `Shorten the summary/notes or trim bullets, then retry.`,
    );
  }
}

/** A required bullet section: renders its items, or "n/a" when empty so the
 * section is never silently dropped from the fixed template. */
function bullets(items: string[]): string[] {
  return items.length ? items.map((i) => `- ${i}`) : ['- n/a'];
}

/** A checkbox group: "- [x] Label" when set, "- [ ] Label" when not. */
function checkboxes(items: [label: string, on: boolean][]): string[] {
  return items.map(([label, on]) => `- [${on ? 'x' : ' '}] ${label}`);
}

/** Render the PR body as Markdown (for gh --body-file). Every section except
 * Notes is always present, matching the repository PR template. */
export function renderPrMarkdown(pr: Pr): string {
  const s = neutralizeAutolinks;
  const lines: string[] = [];

  lines.push('## Summary', '', s(pr.summary));

  lines.push('', '## Type of Change', '');
  lines.push(
    ...checkboxes([
      ['Feature', pr.typeOfChange.feature],
      ['Fix', pr.typeOfChange.fix],
      ['Improvement', pr.typeOfChange.improvement],
      ['Refactor', pr.typeOfChange.refactor],
      ['Documentation', pr.typeOfChange.documentation],
    ]),
  );

  lines.push('', '## Included Changes');
  lines.push('', '### Features', '', ...bullets(pr.features.map(s)));
  lines.push('', '### Fixes', '', ...bullets(pr.fixes.map(s)));
  lines.push('', '### Improvements', '', ...bullets(pr.improvements.map(s)));

  // Related issues is the one section where "#123" is an intended reference — keep it raw.
  lines.push('', '## Related Issues / Work Items', '', ...bullets(pr.relatedIssues));

  lines.push('', '## Testing', '');
  lines.push(
    ...checkboxes([
      ['Unit tests', pr.testing.unit],
      ['Integration tests', pr.testing.integration],
      ['Manual testing', pr.testing.manual],
      ['N/A', pr.testing.na],
    ]),
  );

  if (pr.notes) lines.push('', '## Notes', '', s(pr.notes));

  // The checklist is authored by the human on the created PR, never by the CLI —
  // it always renders blank.
  lines.push('', '## Checklist', '');
  lines.push(
    ...checkboxes([
      ['Self-review completed', false],
      ['Created on a dedicated branch (not the default branch)', false],
      ['CI passing', false],
      ['Ready to merge', false],
    ]),
  );

  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

/** Render the PR body as HTML (for az --description). */
export function renderPrHtml(pr: Pr): string {
  return mdToHtml(renderPrMarkdown(pr));
}
