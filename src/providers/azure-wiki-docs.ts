import { execMutate, execRead } from '../exec.js';
import { writeTempFile } from '../tmpfile.js';
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

/** `docs/tickets/` is TicketProvider's — never enumerated/touched here. */
const RESERVED_TYPES = new Set(['tickets']);

export interface AzureWikiDocsOptions {
  organization: string;
  project: string;
  /** Wiki name/id. Defaults to `${project}.wiki` (Azure's own project-wiki naming). */
  wiki?: string;
  docsTypes: string[];
  dryRun: boolean;
}

// ---- pure argv builders / parsers (unit-testable without spawning `az`) ----

export function wikiListArgs(org: string, project: string): string[] {
  return ['az', 'devops', 'wiki', 'list', '--org', org, '--project', project, '--output', 'json'];
}

/** Parse `az devops wiki list -o json` into wiki names. */
export function parseWikiNames(json: string): string[] {
  const data = json.trim() ? JSON.parse(json) : [];
  const items: any[] = Array.isArray(data) ? data : (data.value ?? []);
  return items.map((w) => w?.name).filter((n): n is string => typeof n === 'string');
}

export function wikiCreateArgs(org: string, project: string, name: string): string[] {
  return ['az', 'devops', 'wiki', 'create', '--name', name, '--org', org, '--project', project];
}

export function wikiPageTreeArgs(org: string, project: string, wiki: string): string[] {
  return [
    'az',
    'devops',
    'wiki',
    'page',
    'show',
    '--path',
    '/',
    '--wiki',
    wiki,
    '--org',
    org,
    '--project',
    project,
    '--recursion-level',
    'full',
    '--output',
    'json',
  ];
}

export function wikiPageShowArgs(org: string, project: string, wiki: string, path: string): string[] {
  return [
    'az',
    'devops',
    'wiki',
    'page',
    'show',
    '--path',
    path,
    '--wiki',
    wiki,
    '--org',
    org,
    '--project',
    project,
    '--include-content',
    '--output',
    'json',
  ];
}

export function wikiPageWriteArgs(
  action: 'create' | 'update',
  org: string,
  project: string,
  wiki: string,
  path: string,
  filePath: string,
  version?: string,
  comment?: string,
): string[] {
  const args = [
    'az',
    'devops',
    'wiki',
    'page',
    action,
    '--path',
    path,
    '--wiki',
    wiki,
    '--org',
    org,
    '--project',
    project,
    '--file-path',
    filePath,
    '--encoding',
    'utf-8',
  ];
  if (action === 'update') args.push('--version', version ?? '');
  if (comment) args.push('--comment', comment);
  return args;
}

export function wikiPageDeleteArgs(org: string, project: string, wiki: string, path: string): string[] {
  return [
    'az',
    'devops',
    'wiki',
    'page',
    'delete',
    '--path',
    path,
    '--wiki',
    wiki,
    '--org',
    org,
    '--project',
    project,
    '--yes',
  ];
}

/** A node in the wiki page tree (`az devops wiki page show --recursion-level full`). */
export interface WikiPageNode {
  path: string;
  subPages?: WikiPageNode[];
}

/** Flatten a wiki page tree into every descendant page's path (depth-first). */
export function flattenWikiPagePaths(node: WikiPageNode): string[] {
  const out: string[] = [];
  const walk = (n: WikiPageNode) => {
    for (const child of n.subPages ?? []) {
      out.push(child.path);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** A doc-shaped wiki page path is exactly `/<type>/<NNNN>-<slug>` — kodi's own
 * convention, distinct from whatever else the org keeps in the same wiki. */
export function parseDocPagePath(path: string): { type: string; num: number; slug: string } | null {
  const m = /^\/([a-z0-9-]+)\/(\d+)-(.+)$/i.exec(path);
  if (!m) return null;
  return { type: m[1].toLowerCase(), num: Number(m[2]), slug: m[3] };
}

/** `docFileStem` reused for wiki page names too — the mapping between local file
 * stem and wiki page path segment is deliberately identical (lossless round-trip). */
function docPagePath(type: string, num: number, slug: string): string {
  return `/${type}/${docFileStem(num, slug)}`;
}

/**
 * The book-style index/table-of-contents page. NOT the literal wiki root
 * (`/`) — `az devops wiki page create/update` refuses that path outright
 * ("path value is either null, empty or wiki root", confirmed live), so
 * kodi's index lives at this well-known, prominent top-level page instead.
 * (Making it the wiki's actual configured landing page is an Azure DevOps
 * *wiki settings* action with no `az devops wiki` CLI equivalent — outside
 * what kodi can automate.)
 */
export const INDEX_PAGE_PATH = '/Index';

export type EnsureWikiAction = 'exists' | 'create' | 'unavailable';

/**
 * The pure decision `ensureWiki()` makes, split out from the `az` calls around it
 * so it's unit-testable without spawning anything (same split `azure-discovery.ts`
 * uses between `getProjectInfo`/the network call and `processSupportsIssues`/the
 * pure decision). `wikis === null` means the `az devops wiki list` read itself
 * failed — the Wiki feature is unavailable, not "no wikis yet".
 */
export function decideEnsureWikiAction(wikis: string[] | null, wikiName: string): EnsureWikiAction {
  if (wikis === null) return 'unavailable';
  return wikis.includes(wikiName) ? 'exists' : 'create';
}

interface DocCandidate {
  path: string;
  type: string;
  num: number;
  slug: string;
}

/**
 * Azure DevOps Wiki doc-artifact provider — proxies `az devops wiki`/`az devops
 * wiki page` (never raw REST), gated by `dryRun` exactly like `AzureTicketProvider`.
 * The wiki is a standalone Azure **project wiki**, not the app's code repository:
 * `organization`/`project` come straight off `BoardConfig`, `repository` is never
 * consulted. Path mapping to/from the local provider is lossless and direct:
 * `<type>/<NNNN>-<slug>` (file stem) <-> `/<type>/<NNNN>-<slug>` (wiki path).
 */
export class AzureWikiDocsProvider implements DocsProvider {
  readonly name = 'azure-wiki';
  private readonly org: string;
  private readonly project: string;
  private readonly wikiName: string;
  private readonly types: string[];
  private readonly dryRun: boolean;
  private wikiEnsured = false;

  constructor(opts: AzureWikiDocsOptions) {
    this.org = opts.organization;
    this.project = opts.project;
    this.wikiName = opts.wiki || `${opts.project}.wiki`;
    this.types = opts.docsTypes.filter((t) => !RESERVED_TYPES.has(t.toLowerCase()));
    this.dryRun = opts.dryRun;
  }

  /**
   * Verify the Wiki feature is enabled, then create the wiki if it doesn't exist
   * yet — never guess past a real failure. `az devops wiki list` is a safe,
   * project-scoped read: if IT fails, the Wiki feature itself is unavailable
   * (disabled in Project Settings -> Overview -> Features, or the project/org is
   * unreachable) and we abort rather than attempt a create that would only fail
   * the same way. If it succeeds and the target wiki is absent, create it
   * (project-wiki type, the default). Idempotent + lazy: called once before the
   * first mutating call in a process.
   */
  async ensureWiki(): Promise<void> {
    if (this.wikiEnsured) return;
    let wikis: string[] | null;
    try {
      wikis = parseWikiNames(execRead(wikiListArgs(this.org, this.project)));
    } catch {
      wikis = null;
    }
    const action = decideEnsureWikiAction(wikis, this.wikiName);
    if (action === 'unavailable') {
      throw new Error(
        `Azure DevOps Wiki is not enabled for project "${this.project}". Enable it in ` +
          `Project Settings -> Overview -> Features, then try again.`,
      );
    }
    if (action === 'create') {
      execMutate(wikiCreateArgs(this.org, this.project, this.wikiName), this.dryRun);
    }
    this.wikiEnsured = true;
  }

  private fetchTree(): DocCandidate[] {
    let out: string;
    try {
      out = execRead(wikiPageTreeArgs(this.org, this.project, this.wikiName));
    } catch {
      return [];
    }
    const root = JSON.parse(out).page as WikiPageNode | undefined;
    if (!root) return [];
    const candidates: DocCandidate[] = [];
    for (const path of flattenWikiPagePaths(root)) {
      const parsed = parseDocPagePath(path);
      if (parsed) candidates.push({ path, ...parsed });
    }
    return candidates;
  }

  private docCandidates(type?: string): DocCandidate[] {
    const all = this.fetchTree();
    const types = type ? [type.toLowerCase()] : this.types;
    return all.filter((c) => types.includes(c.type));
  }

  /** Fetch a page's raw content + eTag, or null if it doesn't exist / is unreachable
   * (same blanket-catch convention `getProjectInfo` uses in azure-discovery.ts). */
  private getRaw(path: string): { content: string; eTag: string } | null {
    try {
      const data = JSON.parse(execRead(wikiPageShowArgs(this.org, this.project, this.wikiName, path)));
      return { content: data.page?.content ?? '', eTag: data.eTag };
    } catch {
      return null;
    }
  }

  private writePage(path: string, content: string, comment?: string): void {
    const tmp = writeTempFile(content, 'kodi-docs-', 'page.md');
    const existing = this.getRaw(path);
    const args = existing
      ? wikiPageWriteArgs('update', this.org, this.project, this.wikiName, path, tmp, existing.eTag, comment)
      : wikiPageWriteArgs('create', this.org, this.project, this.wikiName, path, tmp, undefined, comment);
    execMutate(args, this.dryRun);
  }

  /**
   * Azure DevOps Wiki refuses to create a page whose ANCESTOR path segment
   * doesn't exist yet (`ERROR: One or more ancestor pages of the page '...'
   * does not exist.` — confirmed live against a fresh KodiTest wiki with no
   * `/prd` page yet). So before the first doc of a type is written, create its
   * `/<type>` parent page with placeholder content. Idempotent — a no-op once
   * the type page exists.
   */
  private ensureTypePage(type: string): void {
    const path = `/${type}`;
    if (this.getRaw(path)) return;
    this.writePage(path, `# ${titleCase(type)}\n`);
  }

  async nextId(type: string): Promise<string> {
    // list() surfaces every `/type/NNNN-slug`-shaped page (lenient parsing
    // adopts pre-kodi content too), so numbering continues from whatever's
    // already there instead of colliding with it.
    const ids = (await this.list(type)).map((r) => r.id);
    return formatDocId(type, nextDocNum(type, ids));
  }

  async list(type?: string): Promise<DocRef[]> {
    // N+1 by design: the wiki tree call returns paths only (no content, even
    // recursively — confirmed live), and there is no batch "many pages with
    // content" API, so each doc's name/description costs one extra `az` call.
    // Acceptable at doc-artifact scale (dozens, not thousands, of pages).
    const refs: DocRef[] = [];
    for (const c of this.docCandidates(type)) {
      const raw = this.getRaw(c.path);
      if (!raw) continue;
      // lenient: adopts pages that predate kodi's frontmatter convention too
      // (see parseDocMarkdownLenient) — never skipped for that reason alone.
      const parsed = parseDocMarkdownLenient(raw.content, { type: c.type, slug: c.slug });
      refs.push({
        id: formatDocId(c.type, c.num),
        type: c.type,
        slug: c.slug,
        name: String(parsed.frontmatter.name),
        description: String(parsed.frontmatter.description),
      });
    }
    return refs;
  }

  async get(id: string): Promise<DocContent | null> {
    const parsed = parseDocId(id);
    if (!parsed) return null;
    const candidate = this.docCandidates(parsed.type).find((c) => c.num === parsed.num);
    if (!candidate) return null;
    const raw = this.getRaw(candidate.path);
    if (!raw) return null;
    const doc = parseDocMarkdownLenient(raw.content, { type: candidate.type, slug: candidate.slug });
    return {
      id: formatDocId(candidate.type, candidate.num),
      type: candidate.type,
      slug: candidate.slug,
      name: String(doc.frontmatter.name),
      description: String(doc.frontmatter.description),
      meta: doc.frontmatter,
      body: doc.body,
    };
  }

  async create(type: string, input: CreateDocInput): Promise<DocContent> {
    const id = await this.nextId(type);
    return this.put(id, input);
  }

  async put(id: string, input: CreateDocInput): Promise<DocContent> {
    await this.ensureWiki();
    const canonical = canonicalizeDocId(id);
    const parsed = parseDocId(canonical);
    if (!parsed) throw new Error(`invalid doc id: ${id}`);
    const existing = this.docCandidates(parsed.type).find((c) => c.num === parsed.num);
    const slug = slugify(input.name);
    const path = docPagePath(parsed.type, parsed.num, slug);
    const frontmatter = {
      name: input.name,
      description: input.description,
      type: parsed.type,
      ...input.meta,
    };
    const raw = renderDocMarkdown({ frontmatter, body: input.body });
    this.ensureTypePage(parsed.type);
    this.writePage(path, raw, input.comment);
    // the id kept its number but changed slug (a renamed title) -> drop the old page.
    if (existing && existing.path !== path) {
      execMutate(wikiPageDeleteArgs(this.org, this.project, this.wikiName, existing.path), this.dryRun);
    }
    return { id: canonical, type: parsed.type, slug, name: input.name, description: input.description, meta: frontmatter, body: input.body };
  }

  async delete(id: string): Promise<void> {
    await this.ensureWiki();
    const parsed = parseDocId(canonicalizeDocId(id));
    if (!parsed) throw new Error(`doc ${id} not found`);
    const candidate = this.docCandidates(parsed.type).find((c) => c.num === parsed.num);
    if (!candidate) throw new Error(`doc ${canonicalizeDocId(id)} not found`);
    execMutate(wikiPageDeleteArgs(this.org, this.project, this.wikiName, candidate.path), this.dryRun);
  }

  async updateIndex(): Promise<void> {
    await this.ensureWiki();
    const lines = ['# Documentation index', ''];
    for (const type of this.types) {
      const refs = await this.list(type);
      if (refs.length === 0) continue;
      lines.push(`## ${titleCase(type)}`, '');
      for (const ref of refs) {
        lines.push(`- **[${ref.name}](${docPagePath(ref.type, parseDocId(ref.id)!.num, ref.slug)})** — ${ref.description}`);
      }
      lines.push('');
    }
    this.writePage(INDEX_PAGE_PATH, lines.join('\n').trimEnd() + '\n');
  }
}
