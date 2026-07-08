// Ticket frontmatter extractor + §7 projector.
//
// Reads ONLY the leading `---`…`---` fenced block (SR-4: the markdown body is
// NEVER parsed as data), safe-parses it with the `yaml` default schema, and
// projects to the §7 allow-list by EXPLICIT field pick (SR-5: never spread the
// parsed object). No fs here — the caller hands in the already-read source.
//
// Anchors: PRD 0001 §7 (the exact, only fields), R-013 (do not surface
// slug/nonGoals), NG-1 (never read the phantom fields).

import { parse as parseYaml } from 'yaml';
import type { BoardDrivers } from './types';

/** SR-4: prototype-pollution keys never survive the rebuild. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The §7 fields we can derive from frontmatter. `status` is intentionally NOT
 * here — placement/status is index-wins and comes from `status.yaml`, not the
 * file (data-model §4). `title`/`summary` are optional at this layer because a
 * malformed file may omit them; the assembler applies safe defaults.
 */
export interface ProjectedFrontmatter {
  title?: string;
  dependencies: string[];
  drivers: BoardDrivers;
  summary?: string;
  acceptanceCriteria: string[];
  prUrl?: string;
  notes?: string;
}

/**
 * Extract the leading YAML frontmatter block from a ticket markdown source.
 * Returns the inner YAML text (WITHOUT the fences), or `null` when the source
 * does not begin with a `---` fence or the fence is never closed. Only the
 * leading block is considered — the body is ignored entirely (SR-4).
 */
export function extractFrontmatterBlock(source: string): string | null {
  // Tolerate a leading UTF-8 BOM, then require a `---` fence as the very first line.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? match[1] : null;
}

/** Rebuild a parsed value into a null-proto record, or `null` if not a map. */
function toNullProtoRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Coerce a value to a `string[]`, keeping only string members (default `[]`). */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** Coerce a value to a non-empty string, or `undefined`. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Rebuild `drivers` by picking ONLY its three known sub-keys (SR-5). Default is
 * `{ adr: [] }` (§7). `prd`/`security` present only when a string.
 */
function projectDrivers(value: unknown): BoardDrivers {
  const src = toNullProtoRecord(value);
  const drivers: BoardDrivers = { adr: src ? asStringArray(src.adr) : [] };
  if (src) {
    const prd = asOptionalString(src.prd);
    if (prd !== undefined) drivers.prd = prd;
    const security = asOptionalString(src.security);
    if (security !== undefined) drivers.security = security;
  }
  return drivers;
}

/**
 * Project a frontmatter YAML block to the §7 allow-list. Parses with the `yaml`
 * default/core schema (no custom tags, no reviver, merge off) then picks each
 * field EXPLICITLY — the parsed object is never spread, so keys outside the
 * allow-list (slug, nonGoals, status, and the NG-1 phantoms) cannot leak (SR-5).
 * Throws on a malformed block (→ caller degrades the card, SR-3).
 */
export function projectFrontmatter(block: string): ProjectedFrontmatter {
  const raw: unknown = parseYaml(block);
  const src = toNullProtoRecord(raw);
  if (src === null) {
    throw new Error('frontmatter is not a YAML mapping');
  }

  const projected: ProjectedFrontmatter = {
    dependencies: asStringArray(src.dependencies),
    drivers: projectDrivers(src.drivers),
    acceptanceCriteria: asStringArray(src.acceptanceCriteria),
  };

  const title = asOptionalString(src.title);
  if (title !== undefined) projected.title = title;
  const summary = asOptionalString(src.summary);
  if (summary !== undefined) projected.summary = summary;
  const prUrl = asOptionalString(src.prUrl);
  if (prUrl !== undefined) projected.prUrl = prUrl;
  const notes = asOptionalString(src.notes);
  if (notes !== undefined) projected.notes = notes;

  return projected;
}
