import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';

/**
 * The memory template IS this schema — same philosophy as the ticket/PR templates.
 * A finding is validated before it is stored or imported. The store is lexical
 * (FTS5), so `content` is the searchable body and the rest is filterable metadata.
 */

/** The kind of knowledge a memory captures. Small, filterable, and extensible. */
export const MEMORY_TYPES = [
  'decision', // a choice made + why (mini-ADR)
  'gotcha', // a trap / bug root-cause to not repeat
  'convention', // a project rule/pattern to follow
  'architecture', // how a subsystem/flow works
  'reference', // pointer to a doc/URL/resource
  'task-note', // context tied to a ticket's implementation
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** What a caller supplies to `kodi memory store` (flags or a -f draft). */
export const MemoryDraftSchema = z.object({
  content: z.string().trim().min(1, 'content is required'),
  type: z.enum(MEMORY_TYPES),
  /** Ticket/task in flight when this was learned — optional (null when absent). */
  ticket: z
    .string()
    .trim()
    .min(1)
    .nullish()
    .transform((v) => v ?? null),
  /** Repo-relative paths the finding touches (0..N). Names are derived, not stored. */
  files: z.array(z.string().trim().min(1)).default([]),
  /** Optional display title; a preview of `content` is derived when omitted. */
  title: z.string().trim().min(1).optional(),
});
export type MemoryDraft = z.infer<typeof MemoryDraftSchema>;

/** A stored memory: a validated draft plus its identity and provenance. */
export interface MemoryRecord {
  id: string;
  /** Collection (project) id this belongs to. */
  collection: string;
  content: string;
  title: string;
  type: MemoryType;
  ticket: string | null;
  files: string[];
  /** ISO-8601, UTC (Z). */
  createdAt: string;
  /** sha256 of the normalized content — the dedup key within a collection. */
  contentHash: string;
}

/**
 * Import is lenient: a hand-edited or exported YAML must round-trip, but we own
 * identity/provenance on the way in (id + contentHash recomputed, collection set to
 * the current one). So only content/type are required; the rest is best-effort.
 */
export const MemoryImportRecordSchema = z.object({
  content: z.string().trim().min(1),
  type: z.enum(MEMORY_TYPES),
  ticket: z
    .string()
    .trim()
    .min(1)
    .nullish()
    .transform((v) => v ?? null),
  files: z.array(z.string().trim().min(1)).default([]),
  title: z.string().trim().min(1).optional(),
  /** Preserved when present so an export→import keeps the original timestamp. */
  createdAt: z.string().trim().min(1).optional(),
});
export type MemoryImportRecord = z.infer<typeof MemoryImportRecordSchema>;

/** The YAML document shape produced by `export` and consumed by `import`. */
export const MemoryExportDocSchema = z.object({
  collection: z.string().optional(),
  exportedAt: z.string().optional(),
  memories: z.array(MemoryImportRecordSchema).default([]),
});
export type MemoryExportDoc = z.infer<typeof MemoryExportDocSchema>;

/** sha256 of the normalized (trimmed) content — the per-collection dedup key. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

/** A one-line title derived from content when the caller didn't supply one. */
export function derivePreview(content: string, max = 80): string {
  const firstLine = content.trim().split('\n', 1)[0].trim();
  return firstLine.length > max ? firstLine.slice(0, max - 1).trimEnd() + '…' : firstLine;
}

/** Basenames of the referenced files, for display/search (derived, never stored). */
export function fileNames(files: string[]): string[] {
  return files.map((f) => basename(f));
}
