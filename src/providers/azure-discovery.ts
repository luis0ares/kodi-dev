import { execRead } from '../exec.js';

/** A read-only command runner (injectable for tests). Returns stdout. */
export type Runner = (args: string[]) => string;

const defaultRunner: Runner = (args) => execRead(args);

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
