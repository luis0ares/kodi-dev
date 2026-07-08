// Shared temp-dir fixture helpers for the KODI-009 read-path tests.
//
// Every helper builds a REAL on-disk tickets root under os.tmpdir() with an
// Alternative-B `status.yaml` (data-model §1) plus ticket markdown under the
// canonical `<slug>/` folders (§2/§3). Tests own the lifecycle and delete the
// root in afterEach/afterAll via `cleanup()`.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TicketStatus } from '@/lib/tickets/types';

/** data-model §3 — the frozen status → folder-slug map (fixtures' own copy). */
export const SLUG: Readonly<Record<TicketStatus, string>> = {
  Pending: 'pending',
  'In progress': 'in-progress',
  'To review': 'to-review',
  Done: 'done',
  Blocked: 'blocked',
};

/** Create a fresh, empty tickets root and pre-create the five column folders. */
export function makeTicketsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kodi-board-'));
  for (const slug of Object.values(SLUG)) {
    mkdirSync(join(root, slug), { recursive: true });
  }
  return root;
}

/** Recursively remove a fixture root (safe to call on an already-gone path). */
export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Write raw text as `<root>/status.yaml`. */
export function writeStatusYaml(root: string, text: string): void {
  writeFileSync(join(root, 'status.yaml'), text, 'utf-8');
}

/**
 * Build one Alternative-B `tickets:` entry block for `status.yaml`. The `file`
 * pointer defaults to the canonical `<slug>/<KEY>-<slug>.md` composition, but a
 * caller can override it to inject a hostile pointer (SR-1/SR-2 tests).
 */
export function ticketEntry(
  key: string,
  column: TicketStatus,
  opts: { slug?: string; file?: string } = {},
): string {
  const slug = opts.slug ?? 'x';
  const file = opts.file ?? `${SLUG[column]}/${key}-${slug}.md`;
  return `  ${key}:\n    column: ${column}\n    file: ${file}\n`;
}

/** Assemble a full Alternative-B `status.yaml` from ready-made entry blocks. */
export function statusYaml(...entries: string[]): string {
  return (
    'version: 1\n' +
    'columns: [Pending, In progress, To review, Done, Blocked]\n' +
    'tickets:\n' +
    entries.join('')
  );
}

/** Options for a ticket markdown fixture; anything omitted stays out of the file. */
export interface TicketFileOptions {
  key: string;
  column: TicketStatus;
  slug?: string;
  frontmatter?: string; // full frontmatter body (between the fences); overrides fields
  title?: string;
  status?: string; // frontmatter status (may DISAGREE with the index column)
  dependencies?: string[];
  drivers?: Record<string, unknown>;
  summary?: string;
  acceptanceCriteria?: string[];
  nonGoals?: string[];
  prUrl?: string;
  notes?: string;
  extra?: Record<string, unknown>; // phantom/NG-1 fields to inject
  body?: string; // markdown body after the frontmatter
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function yamlList(name: string, items: string[]): string {
  if (items.length === 0) return `${name}: []\n`;
  return `${name}:\n${items.map((i) => `  - ${i}`).join('\n')}\n`;
}

/**
 * Write a ticket markdown file at its canonical path. When `frontmatter` is
 * given it is used verbatim (for malformed-block tests); otherwise a frontmatter
 * block is composed from the field options (including any `extra` phantom keys).
 * Returns the absolute path written.
 */
export function writeTicketFile(root: string, opts: TicketFileOptions): string {
  const slug = opts.slug ?? 'x';
  const filename = `${opts.key}-${slug}.md`;
  const dir = join(root, SLUG[opts.column]);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);

  let content: string;
  if (opts.frontmatter !== undefined) {
    content = opts.frontmatter;
  } else {
    let fm = '';
    fm += `key: ${opts.key}\n`;
    fm += `title: ${opts.title ?? `Ticket ${opts.key}`}\n`;
    fm += `slug: ${slug}\n`;
    fm += `status: ${opts.status ?? opts.column}\n`;
    if (opts.dependencies !== undefined) fm += yamlList('dependencies', opts.dependencies);
    if (opts.drivers !== undefined) {
      fm += 'drivers:\n';
      for (const [k, v] of Object.entries(opts.drivers)) {
        if (Array.isArray(v)) {
          fm += v.length === 0 ? `  ${k}: []\n` : `  ${k}:\n${v.map((i) => `    - ${i}`).join('\n')}\n`;
        } else {
          fm += `  ${k}: ${yamlScalar(v)}\n`;
        }
      }
    }
    if (opts.summary !== undefined) fm += `summary: ${opts.summary}\n`;
    if (opts.acceptanceCriteria !== undefined) fm += yamlList('acceptanceCriteria', opts.acceptanceCriteria);
    if (opts.nonGoals !== undefined) fm += yamlList('nonGoals', opts.nonGoals);
    if (opts.prUrl !== undefined) fm += `prUrl: ${opts.prUrl}\n`;
    if (opts.notes !== undefined) fm += `notes: ${opts.notes}\n`;
    for (const [k, v] of Object.entries(opts.extra ?? {})) {
      fm += `${k}: ${yamlScalar(v)}\n`;
    }
    const body = opts.body ?? `\n# ${opts.title ?? opts.key}\n`;
    content = `---\n${fm}---\n${body}`;
  }

  writeFileSync(path, content, 'utf-8');
  return path;
}

/** Re-export node symlink so tests can attempt SR-2 fixtures with one import. */
export { symlinkSync };
