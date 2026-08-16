import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../config.js';
import {
  canonicalizeDocId,
  docFileStem,
  formatDocId,
  nextDocNum,
  parseDocId,
  parseDocMarkdownLenient,
  renderDocMarkdown,
  slugify,
  titleCase,
} from '../templates/doc.js';
import type { CreateDocInput, DocContent, DocRef, DocsProvider } from './types.js';

const FILE_RE = /^(\d+)-(.+)\.md$/;

/** `docs/tickets/` is TicketProvider's — never enumerated/touched here. */
const RESERVED_TYPES = new Set(['tickets']);

/**
 * Local, filesystem-backed doc-artifact provider: one file per doc, under
 * `docs/<type>/<NNNN>-<slug>.md`. Unlike tickets, docs have no status/column to
 * track, so there is no separate index file — enumeration is a plain directory
 * scan. Writes are direct (no dry-run): local writes are safe and reversible,
 * same convention `LocalTicketProvider`/`providers/index.ts` already document.
 */
export class LocalDocsProvider implements DocsProvider {
  readonly name = 'local';
  private readonly root: string;
  private readonly types: string[];

  constructor(docsTypes: string[], cwd = process.cwd()) {
    this.root = join(findProjectRoot(cwd), 'docs');
    this.types = docsTypes.filter((t) => !RESERVED_TYPES.has(t.toLowerCase()));
  }

  private typeDir(type: string): string {
    return join(this.root, type.toLowerCase());
  }

  /**
   * Adopt every plain `<name>.md` file in `dir` that has NO `<NNNN>-` prefix —
   * confirmed live: `docs/plan`/`docs/diagrams` in a real copied EPR-V2 tree use
   * free-form names (`foundation-part1.md`, `container.md`) with no numbering at
   * all, unlike PRD/ADR/security's `<NNNN>-<slug>.md`. Each gets the next free
   * number for the type and is RENAMED on disk (not just given an in-memory id)
   * — the id has to be persisted, or it would drift across runs as files are
   * added/removed (an ephemeral id is not a stable id). Frontmatter is
   * normalized at adoption time too (writing is always strict, same as
   * `create`/`put`). `README.md` (case-insensitive) is never adopted — it's a
   * type-folder overview, not a doc artifact. Idempotent: a file already
   * matching `FILE_RE` is left untouched, so re-scanning never re-adopts.
   */
  private adoptUnnumbered(dir: string, type: string): void {
    const entries = readdirSync(dir);
    let max = 0;
    for (const entry of entries) {
      const m = FILE_RE.exec(entry);
      if (m) max = Math.max(max, Number(m[1]));
    }
    const unnumbered = entries
      .filter((e) => e.toLowerCase().endsWith('.md') && e.toLowerCase() !== 'readme.md' && !FILE_RE.test(e))
      .sort(); // deterministic order within one adoption pass
    for (const name of unnumbered) {
      const oldPath = join(dir, name);
      let raw: string;
      try {
        raw = readFileSync(oldPath, 'utf-8');
      } catch {
        continue; // vanished mid-scan — not this call's problem
      }
      max++;
      const slug = slugify(name.replace(/\.md$/i, ''));
      const parsed = parseDocMarkdownLenient(raw, { type, slug });
      const newPath = join(dir, `${docFileStem(max, slug)}.md`);
      writeFileSync(newPath, renderDocMarkdown(parsed), 'utf-8');
      unlinkSync(oldPath);
      process.stderr.write(`kodi: adopted docs/${type}/${name} -> docs/${type}/${docFileStem(max, slug)}.md\n`);
    }
  }

  private scanType(type: string): Array<{ path: string; num: number; slug: string }> {
    const dir = this.typeDir(type);
    if (!existsSync(dir)) return [];
    this.adoptUnnumbered(dir, type);
    const out: Array<{ path: string; num: number; slug: string }> = [];
    for (const entry of readdirSync(dir)) {
      const m = FILE_RE.exec(entry);
      if (!m) continue;
      out.push({ path: join(dir, entry), num: Number(m[1]), slug: m[2] });
    }
    return out.sort((a, b) => a.num - b.num);
  }

  /** Reads and parses a doc, tolerating pre-kodi content (missing/incomplete
   * frontmatter) — see {@link parseDocMarkdownLenient}. Returns null only when
   * the file itself can't be read (deleted mid-scan, permissions, …). */
  private toRef(type: string, num: number, slug: string, path: string): DocContent | null {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
    const parsed = parseDocMarkdownLenient(raw, { type, slug });
    return {
      id: formatDocId(type, num),
      type: type.toLowerCase(),
      slug,
      name: String(parsed.frontmatter.name),
      description: String(parsed.frontmatter.description),
      meta: parsed.frontmatter,
      body: parsed.body,
    };
  }

  async nextId(type: string): Promise<string> {
    // list() surfaces every `<NNNN>-<slug>.md` file under the type folder
    // (lenient parsing adopts pre-kodi content too), so numbering continues
    // from whatever's already there instead of colliding with it.
    const ids = (await this.list(type)).map((r) => r.id);
    return formatDocId(type, nextDocNum(type, ids));
  }

  async list(type?: string): Promise<DocRef[]> {
    const types = type ? [type.toLowerCase()] : this.types;
    const refs: DocRef[] = [];
    for (const t of types) {
      for (const entry of this.scanType(t)) {
        const doc = this.toRef(t, entry.num, entry.slug, entry.path);
        if (doc) refs.push({ id: doc.id, type: doc.type, slug: doc.slug, name: doc.name, description: doc.description });
      }
    }
    return refs;
  }

  async get(id: string): Promise<DocContent | null> {
    const parsed = parseDocId(id);
    if (!parsed) return null;
    const entry = this.scanType(parsed.type).find((e) => e.num === parsed.num);
    if (!entry) return null;
    return this.toRef(parsed.type, entry.num, entry.slug, entry.path);
  }

  async create(type: string, input: CreateDocInput): Promise<DocContent> {
    const id = await this.nextId(type);
    return this.put(id, input);
  }

  async put(id: string, input: CreateDocInput): Promise<DocContent> {
    const canonical = canonicalizeDocId(id);
    const parsed = parseDocId(canonical);
    if (!parsed) throw new Error(`invalid doc id: ${id}`);
    const dir = this.typeDir(parsed.type);
    mkdirSync(dir, { recursive: true });
    // an existing file at this num (any slug) is replaced — the id, not the slug,
    // is the stable identity migrate preserves across backends.
    const existing = this.scanType(parsed.type).find((e) => e.num === parsed.num);
    const slug = slugify(input.name);
    const stem = docFileStem(parsed.num, slug);
    const frontmatter = {
      name: input.name,
      description: input.description,
      type: parsed.type,
      ...input.meta,
    };
    const raw = renderDocMarkdown({ frontmatter, body: input.body });
    writeFileSync(join(dir, `${stem}.md`), raw, 'utf-8');
    if (existing && existing.slug !== slug) unlinkSync(existing.path);
    return {
      id: canonical,
      type: parsed.type,
      slug,
      name: input.name,
      description: input.description,
      meta: frontmatter,
      body: input.body,
    };
  }

  async delete(id: string): Promise<void> {
    const canonical = canonicalizeDocId(id);
    const parsed = parseDocId(canonical);
    if (!parsed) throw new Error(`doc ${id} not found`);
    const entry = this.scanType(parsed.type).find((e) => e.num === parsed.num);
    if (!entry) throw new Error(`doc ${canonical} not found`);
    unlinkSync(entry.path);
  }

  async updateIndex(): Promise<void> {
    const lines = ['# Documentation index', ''];
    for (const type of this.types) {
      const refs = await this.list(type);
      if (refs.length === 0) continue;
      lines.push(`## ${titleCase(type)}`, '');
      for (const ref of refs) {
        lines.push(`- **[${ref.name}](./${ref.type}/${docFileStem(parseDocId(ref.id)!.num, ref.slug)}.md)** — ${ref.description}`);
      }
      lines.push('');
    }
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, 'README.md'), lines.join('\n').trimEnd() + '\n', 'utf-8');
  }
}
