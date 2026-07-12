import { z } from 'zod';
import { mdToHtml } from '../html.js';

/**
 * The PR template IS this schema — same philosophy as the ticket template. A
 * draft is validated before anything is rendered or sent to gh/az. Optional
 * bullet sections are omitted from the rendered body when empty.
 */
export const PrSchema = z.object({
  title: z.string().min(3, 'title must be at least 3 characters'),
  summary: z.string().min(1, 'summary is required'),
  includedChanges: z.array(z.string().min(1)).default([]),
  features: z.array(z.string().min(1)).default([]),
  fixes: z.array(z.string().min(1)).default([]),
  improvements: z.array(z.string().min(1)).default([]),
  /**
   * Security vulnerabilities the slice surfaced, each referencing its report
   * (e.g. "CRITICAL — SQLi in login (docs/security/KODI-014-sqli-login.md)").
   * Rendered as a prominent section so reviewers see findings that still need
   * follow-up tickets. Empty when the slice produced no security reports.
   */
  vulnerabilities: z.array(z.string().min(1)).default([]),
  relatedIssues: z.array(z.string().min(1)).default([]),
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

function bulletSection(title: string, items: string[]): string[] {
  if (!items.length) return [];
  return ['', `## ${title}`, '', ...items.map((i) => `- ${i}`)];
}

/** Render the PR body as Markdown (for gh --body-file). */
export function renderPrMarkdown(pr: Pr): string {
  const s = neutralizeAutolinks;
  const lines: string[] = ['## Summary', '', s(pr.summary)];
  // Security findings surface right after the summary — they gate review and
  // seed follow-up tickets, so they must not be buried below feature bullets.
  lines.push(...bulletSection('Security vulnerabilities', pr.vulnerabilities.map(s)));
  lines.push(...bulletSection('Included changes', pr.includedChanges.map(s)));
  lines.push(...bulletSection('Features', pr.features.map(s)));
  lines.push(...bulletSection('Fixes', pr.fixes.map(s)));
  lines.push(...bulletSection('Improvements', pr.improvements.map(s)));
  // Related issues is the one section where "#123" is an intended reference — keep it raw.
  lines.push(...bulletSection('Related issues', pr.relatedIssues));
  if (pr.notes) lines.push('', '## Notes', '', s(pr.notes));
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
