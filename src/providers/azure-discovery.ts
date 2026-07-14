import { execRead } from '../exec.js';

/** A read-only command runner (injectable for tests). Returns stdout. */
export type Runner = (args: string[]) => string;

const defaultRunner: Runner = (args) => execRead(args);

/**
 * Normalize an org input into the full URL `az` requires. Accepts a bare org
 * name ("acme"), a host path ("dev.azure.com/org"), or a full URL.
 */
export function normalizeOrgUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/\b(dev\.azure\.com|visualstudio\.com)\b/i.test(s)) return `https://${s.replace(/^\/+/, '')}`;
  return `https://dev.azure.com/${s}`;
}

/** Parse `az devops project list -o json` into project names. */
export function parseProjects(json: string): string[] {
  const data = JSON.parse(json);
  const items: any[] = Array.isArray(data) ? data : (data.value ?? []);
  return items.map((p) => p?.name).filter((n): n is string => typeof n === 'string');
}

/** List Azure DevOps projects in an organization (proxy `az devops project list`). */
export function listProjects(org: string, run: Runner = defaultRunner): string[] {
  const out = run(['az', 'devops', 'project', 'list', '--org', org, '--output', 'json']);
  return parseProjects(out);
}

export interface ProjectInfo {
  /** The process template name (e.g. "Basic", "Agile", "Scrum"). */
  processTemplate?: string;
}

/** Extract the process template name from `az devops project show` JSON. */
export function parseProjectInfo(json: string): ProjectInfo {
  const d = JSON.parse(json);
  return { processTemplate: d?.capabilities?.processTemplate?.templateName };
}

/**
 * Fetch a project's info (proxy `az devops project show`). Returns null when the
 * project is unreachable (the az call failed), so the caller can abort.
 */
export function getProjectInfo(
  org: string,
  project: string,
  run: Runner = defaultRunner,
): ProjectInfo | null {
  try {
    return parseProjectInfo(
      run([
        'az',
        'devops',
        'project',
        'show',
        '--project',
        project,
        '--org',
        org,
        '--output',
        'json',
      ]),
    );
  } catch {
    return null;
  }
}

/**
 * Whether a process template provides the "Issue" work-item type kodi creates.
 * Basic (and unknown/custom processes) do; Agile uses "User Story" and Scrum
 * uses "Product Backlog Item" instead, so those are rejected.
 */
export function processSupportsIssues(template: string | undefined): boolean {
  return template !== 'Agile' && template !== 'Scrum';
}

/** A work-item state and its meta-category (Proposed / InProgress / Completed / …). */
export interface IssueState {
  name: string;
  category: string;
}

/** Parse `az devops invoke … workItemTypeStates` output into states. */
export function parseStates(json: string): IssueState[] {
  const d = JSON.parse(json);
  const items: any[] = Array.isArray(d) ? d : (d.value ?? []);
  return items
    .map((s) => ({ name: s?.name, category: s?.category }))
    .filter((s): s is IssueState => typeof s.name === 'string');
}

/** List the states of the Issue work-item type in a project (with categories). */
export function listIssueStates(
  org: string,
  project: string,
  run: Runner = defaultRunner,
): IssueState[] {
  const out = run([
    'az',
    'devops',
    'invoke',
    '--area',
    'wit',
    '--resource',
    'workItemTypeStates',
    '--route-parameters',
    `project=${project}`,
    'type=Issue',
    '--org',
    org,
    '--detect',
    'false',
    '--output',
    'json',
  ]);
  return parseStates(out);
}

/** State names in a given meta-category (e.g. "Proposed" = the To Do-type columns). */
export function statesInCategory(states: IssueState[], category: string): string[] {
  return states.filter((s) => s.category === category).map((s) => s.name);
}

/** Parse `az devops team list -o json` into team names. */
export function parseTeams(json: string): string[] {
  const d = JSON.parse(json);
  const items: any[] = Array.isArray(d) ? d : (d.value ?? []);
  return items.map((t) => t?.name).filter((n): n is string => typeof n === 'string');
}

/** List the teams in a project (proxy `az devops team list`). */
export function listTeams(org: string, project: string, run: Runner = defaultRunner): string[] {
  return parseTeams(
    run(['az', 'devops', 'team', 'list', '--org', org, '--project', project, '--output', 'json']),
  );
}

/** Parse the `work/boards` invoke response into board names. */
export function parseBoards(json: string): string[] {
  const d = JSON.parse(json);
  const items: any[] = Array.isArray(d) ? d : (d.value ?? []);
  return items.map((b) => b?.name).filter((n): n is string => typeof n === 'string');
}

/** Parse `az repos ref list --filter heads -o json`, stripping the `refs/heads/` prefix. */
export function parseBranchRefs(json: string): string[] {
  const d = JSON.parse(json);
  const items: Array<{ name?: string }> = Array.isArray(d) ? d : (d.value ?? []);
  return items
    .map((r) => r?.name)
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.replace(/^refs\/heads\//, ''));
}

/** List a repository's branch names (proxy `az repos ref list --filter heads`). */
export function listBranches(
  org: string,
  project: string,
  repo: string,
  run: Runner = defaultRunner,
): string[] {
  return parseBranchRefs(
    run([
      'az',
      'repos',
      'ref',
      'list',
      '--repository',
      repo,
      '--org',
      org,
      '--project',
      project,
      '--filter',
      'heads',
      '--output',
      'json',
    ]),
  );
}

/** List a team's boards (proxy `az devops invoke … work/boards`). */
export function listBoards(
  org: string,
  project: string,
  team: string,
  run: Runner = defaultRunner,
): string[] {
  return parseBoards(
    run([
      'az',
      'devops',
      'invoke',
      '--area',
      'work',
      '--resource',
      'boards',
      '--route-parameters',
      `project=${project}`,
      `team=${team}`,
      '--org',
      org,
      '--detect',
      'false',
      '--output',
      'json',
    ]),
  );
}

/**
 * A single board column as the user sees it on the board — its display name, its
 * position type (incoming / inProgress / outgoing), and the work-item state it
 * maps to. Several columns can map to the SAME state.
 */
export interface BoardColumn {
  name: string;
  columnType: string;
  /** The `System.State` this column maps the Issue type to. */
  state: string;
}

/** Parse the `work/boards/{board}/columns` invoke response into ordered columns. */
export function parseBoardColumns(json: string): BoardColumn[] {
  const d = JSON.parse(json);
  const items: any[] = Array.isArray(d) ? d : (d.value ?? []);
  return items
    .map((c) => ({
      name: c?.name,
      columnType: c?.columnType ?? '',
      state: c?.stateMappings?.Issue ?? '',
    }))
    .filter((c): c is BoardColumn => typeof c.name === 'string');
}

/**
 * List a board's columns in board order (left-to-right, exactly as shown on
 * screen), with the state each maps to (proxy `az devops invoke … columns`).
 */
export function listBoardColumns(
  org: string,
  project: string,
  team: string,
  board: string,
  run: Runner = defaultRunner,
): BoardColumn[] {
  return parseBoardColumns(
    run([
      'az',
      'devops',
      'invoke',
      '--area',
      'work',
      '--resource',
      'columns',
      '--route-parameters',
      `project=${project}`,
      `team=${team}`,
      `board=${board}`,
      '--org',
      org,
      '--detect',
      'false',
      '--output',
      'json',
    ]),
  );
}
