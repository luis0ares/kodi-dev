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
  relatedIssues: z.array(z.string().min(1)).default([]),
  notes: z.string().optional(),
  reviewers: z.array(z.string().min(1)).default([]),
});

export type PrInput = z.input<typeof PrSchema>;
export type Pr = z.infer<typeof PrSchema>;

function bulletSection(title: string, items: string[]): string[] {
  if (!items.length) return [];
  return ['', `## ${title}`, '', ...items.map((i) => `- ${i}`)];
}

/** Render the PR body as Markdown (for gh --body-file). */
export function renderPrMarkdown(pr: Pr): string {
  const lines: string[] = ['## Summary', '', pr.summary];
  lines.push(...bulletSection('Included changes', pr.includedChanges));
  lines.push(...bulletSection('Features', pr.features));
  lines.push(...bulletSection('Fixes', pr.fixes));
  lines.push(...bulletSection('Improvements', pr.improvements));
  lines.push(...bulletSection('Related issues', pr.relatedIssues));
  if (pr.notes) lines.push('', '## Notes', '', pr.notes);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Render the PR body as HTML (for az --description). */
export function renderPrHtml(pr: Pr): string {
  return mdToHtml(renderPrMarkdown(pr));
}
