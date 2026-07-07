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

/**
 * Confirm a project is reachable (proxy `az devops project show`). Returns true
 * on success; throws are caught by the caller to report a reachability failure.
 */
export function projectReachable(org: string, project: string, run: Runner = defaultRunner): boolean {
  try {
    run(['az', 'devops', 'project', 'show', '--project', project, '--org', org, '--output', 'json']);
    return true;
  } catch {
    return false;
  }
}
