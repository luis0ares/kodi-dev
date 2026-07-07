import { execRead } from '../exec.js';

/** A read-only command runner (injectable for tests). Returns stdout. */
export type Runner = (args: string[]) => string;

const defaultRunner: Runner = (args) => execRead(args);

/** A Projects v2 board, as returned by `gh project list`. */
export interface ProjectRef {
  number: number;
  title: string;
  id: string;
}

/** Parse `gh project list --format json` into board refs. */
export function parseProjects(json: string): ProjectRef[] {
  const data = JSON.parse(json);
  const items: any[] = Array.isArray(data) ? data : (data.projects ?? []);
  return items
    .map((p) => ({ number: p?.number, title: p?.title ?? '', id: p?.id ?? '' }))
    .filter((p): p is ProjectRef => typeof p.number === 'number');
}

/** List a owner's Projects v2 boards (proxy `gh project list`). */
export function listProjects(owner: string, run: Runner = defaultRunner): ProjectRef[] {
  const out = run([
    'gh',
    'project',
    'list',
    '--owner',
    owner,
    '--format',
    'json',
    '--limit',
    '100',
  ]);
  return parseProjects(out);
}

/** Resolve the authenticated user's login (proxy `gh api user`). */
export function resolveViewerLogin(run: Runner = defaultRunner): string {
  return run(['gh', 'api', 'user', '-q', '.login']).trim();
}

/**
 * The token's OAuth scopes, read from the `X-Oauth-Scopes` response header
 * (proxy `gh api -i user`). Returns null when unknown — e.g. fine-grained PATs
 * and GitHub App tokens don't expose the header — so callers must not treat
 * null as "no access".
 */
export function tokenScopes(run: Runner = defaultRunner): string[] | null {
  let out: string;
  try {
    out = run(['gh', 'api', '-i', 'user']);
  } catch {
    return null;
  }
  const m = /^x-oauth-scopes:\s*(.*)$/im.exec(out);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether the token can WRITE to Projects v2. Reads only need `read:project`,
 * but adding/moving cards needs the `project` scope. Returns null when the scope
 * set can't be determined (don't block on unknown).
 */
export function hasProjectWriteScope(run: Runner = defaultRunner): boolean | null {
  const scopes = tokenScopes(run);
  if (scopes == null) return null;
  return scopes.includes('project');
}

/** Auto-detect the current repo as `owner/repo` (proxy `gh repo view`). Throws outside a gh-recognized repo. */
export function detectRepo(run: Runner = defaultRunner): string {
  return run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
}

/** Parse `gh repo list --json nameWithOwner` into `owner/repo` names. */
export function parseRepos(json: string): string[] {
  const data = JSON.parse(json);
  const items: any[] = Array.isArray(data) ? data : (data.repositories ?? []);
  return items.map((r) => r?.nameWithOwner).filter((n): n is string => typeof n === 'string');
}

/** List an owner's repositories as `owner/repo` (proxy `gh repo list`). */
export function listRepos(owner: string, run: Runner = defaultRunner): string[] {
  const out = run(['gh', 'repo', 'list', owner, '--json', 'nameWithOwner', '--limit', '200']);
  return parseRepos(out);
}

/** A single-select "Status" field and its column options (id + name). */
export interface StatusField {
  id: string;
  options: Array<{ id: string; name: string }>;
}

/** Parse `gh project field-list --format json`, returning the single-select Status field (or null). */
export function parseStatusField(json: string): StatusField | null {
  const data = JSON.parse(json);
  const fields: any[] = Array.isArray(data) ? data : (data.fields ?? []);
  const status = fields.find(
    (f) =>
      typeof f?.name === 'string' && f.name.toLowerCase() === 'status' && Array.isArray(f?.options),
  );
  if (!status) return null;
  const options = status.options
    .map((o: any) => ({ id: o?.id, name: o?.name }))
    .filter(
      (o: any): o is { id: string; name: string } =>
        typeof o.id === 'string' && typeof o.name === 'string',
    );
  return { id: status.id, options };
}

/** Fetch a board's Status field + options (proxy `gh project field-list`). Returns null when absent. */
export function listStatusField(
  owner: string,
  number: number,
  run: Runner = defaultRunner,
): StatusField | null {
  const out = run([
    'gh',
    'project',
    'field-list',
    String(number),
    '--owner',
    owner,
    '--format',
    'json',
    '--limit',
    '100',
  ]);
  return parseStatusField(out);
}

/** The node IDs needed to move a card: the project itself + its Status field/options. */
export interface ProjectMeta {
  projectId: string;
  statusField: StatusField;
}

/** Parse `gh project view --format json` into the project's node id. */
export function parseProjectId(json: string): string {
  return JSON.parse(json)?.id ?? '';
}

/**
 * Resolve everything needed for writes: the project node id and the Status field
 * (id + option ids). Throws if the board has no Status field.
 */
export function fetchProjectMeta(
  owner: string,
  number: number,
  run: Runner = defaultRunner,
): ProjectMeta {
  const projectId = parseProjectId(
    run(['gh', 'project', 'view', String(number), '--owner', owner, '--format', 'json']),
  );
  const statusField = listStatusField(owner, number, run);
  if (!statusField) {
    throw new Error(`project #${number} (owner ${owner}) has no single-select "Status" field`);
  }
  return { projectId, statusField };
}

/** The option id for a column name on a Status field (case-insensitive), or undefined. */
export function optionIdFor(field: StatusField, columnName: string): string | undefined {
  return field.options.find((o) => o.name.toLowerCase() === columnName.toLowerCase())?.id;
}
