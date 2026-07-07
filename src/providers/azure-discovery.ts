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
  const items: any[] = Array.isArray(data) ? data : data.value ?? [];
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
export function getProjectInfo(org: string, project: string, run: Runner = defaultRunner): ProjectInfo | null {
  try {
    return parseProjectInfo(
      run(['az', 'devops', 'project', 'show', '--project', project, '--org', org, '--output', 'json']),
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
  const items: any[] = Array.isArray(d) ? d : d.value ?? [];
  return items
    .map((s) => ({ name: s?.name, category: s?.category }))
    .filter((s): s is IssueState => typeof s.name === 'string');
}

/** List the states of the Issue work-item type in a project (with categories). */
export function listIssueStates(org: string, project: string, run: Runner = defaultRunner): IssueState[] {
  const out = run([
    'az', 'devops', 'invoke', '--area', 'wit', '--resource', 'workItemTypeStates',
    '--route-parameters', `project=${project}`, 'type=Issue',
    '--org', org, '--detect', 'false', '--output', 'json',
  ]);
  return parseStates(out);
}

/** State names in a given meta-category (e.g. "Proposed" = the To Do-type columns). */
export function statesInCategory(states: IssueState[], category: string): string[] {
  return states.filter((s) => s.category === category).map((s) => s.name);
}
