import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z, ZodError } from 'zod';
import { slugify } from './ticket.js';

export { slugify };

/**
 * A kodi-managed doc artifact's frontmatter — Claude skill/agent-frontmatter
 * style. Exactly three fields are required on EVERY type; everything else
 * (a PRD's `status`/`owner`/`related-adrs`, …) is free-form per type and never
 * enforced here — `type` itself is validated against the project's configured
 * `docsTypes` (kodi-dev.yaml), not a fixed enum in code.
 */
export const DocFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    type: z.string().min(1),
  })
  .catchall(z.unknown());

export type DocFrontmatter = z.infer<typeof DocFrontmatterSchema>;

export interface ParsedDoc {
  frontmatter: DocFrontmatter;
  body: string;
}

/** Same shape as `local.ts`'s ticket-frontmatter regex — a leading `---\n...\n---\n` block. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/** The template is enforced entirely by {@link DocFrontmatterSchema}. Re-throw a
 * Zod failure as a readable, field-by-field message instead of a raw JSON dump. */
function parseFrontmatter(input: unknown): DocFrontmatter {
  try {
    return DocFrontmatterSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.issues.map((i) => `  - ${i.path.join('.') || '(frontmatter)'}: ${i.message}`);
      throw new Error(
        `doc frontmatter does not satisfy the required template:\n${lines.join('\n')}\n` +
          `"name", "description" and "type" are required on every doc.`,
      );
    }
    throw err;
  }
}

/** Split a raw doc file into its validated frontmatter and markdown body. */
export function parseDocMarkdown(raw: string): ParsedDoc {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) throw new Error('doc is missing its leading YAML frontmatter block (---...---)');
  const frontmatter = parseFrontmatter(parseYaml(m[1]) ?? {});
  // `renderDocMarkdown` always separates the closing fence from the body with one
  // blank line (matches the real EPR-V2 precedent) — strip exactly that one
  // leading newline so the round-trip is exact, without assuming every raw file
  // has it (a body with no blank separator is left untouched).
  return { frontmatter, body: raw.slice(m[0].length).replace(/^\n/, '') };
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
}

/** `titleCase('security')` -> `'Security'`, `titleCase('portal-query')` -> `'Portal Query'`. */
export function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface LenientDocFallback {
  /** The type context the file was found under (e.g. the folder / wiki path segment). */
  type: string;
  /** The filename/page-path slug, used as a last-resort `name`. */
  slug: string;
}

/**
 * Best-effort parse for ADOPTING pre-existing markdown that predates kodi's
 * frontmatter convention — or uses a different one, e.g. the real EPR-V2 PRDs'
 * bare `title:` field with no `description`/`type` at all. Unlike
 * {@link parseDocMarkdown}, this NEVER throws: `list`/`get`/`migrate` need to
 * surface every real file under a registered type folder, not only the ones
 * already frontmatter-perfect (confirmed live — a strict parse silently
 * skipped an entire copied EPR-V2 docs tree, since none of it has kodi's exact
 * shape yet). Missing pieces are synthesized, in order:
 *   name        <- frontmatter `name` -> `title` -> first `# ` heading -> the slug, title-cased
 *   description <- frontmatter `description` -> `summary` -> ''
 *   type        <- frontmatter `type` -> `fallback.type` (the folder/page path it lives under)
 * A doc adopted this way gets PROPER frontmatter the moment it's next written
 * through kodi (`create`/`put`/`migrate` always render the full required
 * shape) — reading is lenient, writing stays strict.
 */
export function parseDocMarkdownLenient(raw: string, fallback: LenientDocFallback): ParsedDoc {
  const m = FRONTMATTER_RE.exec(raw);
  let meta: Record<string, unknown> = {};
  let body = raw;
  if (m) {
    let parsedYaml: unknown;
    try {
      parsedYaml = parseYaml(m[1]);
    } catch {
      parsedYaml = null;
    }
    if (parsedYaml && typeof parsedYaml === 'object') {
      meta = parsedYaml as Record<string, unknown>;
      body = raw.slice(m[0].length).replace(/^\n/, '');
    }
  }
  const name =
    nonEmptyString(meta.name) ??
    nonEmptyString(meta.title) ??
    firstHeading(body) ??
    titleCase(fallback.slug);
  const description = nonEmptyString(meta.description) ?? nonEmptyString(meta.summary) ?? '';
  const type = nonEmptyString(meta.type) ?? fallback.type;
  return { frontmatter: { ...meta, name, description, type }, body };
}

/** Render a doc's frontmatter + body back to the on-disk/on-wiki markdown form.
 * Takes a plain `Record` (not the stricter `DocFrontmatter`) so an already-parsed
 * `DocContent.meta` round-trips without re-validating. */
export function renderDocMarkdown({
  frontmatter,
  body,
}: {
  frontmatter: Record<string, unknown>;
  body: string;
}): string {
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}`;
}

/** Canonical width of a doc id's numeric part — wider than tickets' 3 (`KEY_NUM_WIDTH`):
 * the real-world precedent this mirrors (EPR-V2's `/docs/prd`, `/docs/adr`) already needs
 * 4 (PRDs run 0000-0013, ADRs are referenced past 0020). */
export const DOC_ID_NUM_WIDTH = 4;

const DOC_ID_RE = /^([A-Za-z][A-Za-z0-9]*)-0*(\d+)$/;

export interface DocId {
  /** Lowercase type, e.g. "prd". */
  type: string;
  num: number;
}

/** Parse a doc id (`PRD-0009`, case/padding-insensitive) into its type + number. */
export function parseDocId(id: string): DocId | null {
  const m = DOC_ID_RE.exec(id.trim());
  if (!m) return null;
  return { type: m[1].toLowerCase(), num: Number(m[2]) };
}

/** Normalize a hand-typed doc id to its canonical form (`prd-9` -> `PRD-0009`) —
 * same purpose as `canonicalizeTicketKey`, just per-type and 4-digit padded. */
export function canonicalizeDocId(ref: string): string {
  const parsed = parseDocId(ref);
  if (!parsed) return ref.trim();
  return formatDocId(parsed.type, parsed.num);
}

/** Format a type + number into its canonical id string. */
export function formatDocId(type: string, num: number): string {
  return `${type.toUpperCase()}-${String(num).padStart(DOC_ID_NUM_WIDTH, '0')}`;
}

/** Next free number for `type` among `existingIds` (any type/casing; non-matching
 * ids are ignored) — same max-and-increment approach as `LocalTicketProvider.nextId`. */
export function nextDocNum(type: string, existingIds: string[]): number {
  let max = 0;
  for (const id of existingIds) {
    const parsed = parseDocId(id);
    if (parsed && parsed.type === type.toLowerCase()) max = Math.max(max, parsed.num);
  }
  return max + 1;
}

/** File/page basename for a doc: `<NNNN>-<slug>` (extension added by the caller). */
export function docFileStem(num: number, slug: string): string {
  return `${String(num).padStart(DOC_ID_NUM_WIDTH, '0')}-${slug}`;
}
