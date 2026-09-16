import { execRead } from './exec.js';

/**
 * `gh`-specific knowledge that is not about building a command line — how to ask
 * GitHub a question kodi needs the answer to, and how to translate a failure that
 * comes from `gh` itself into something actionable.
 */

/**
 * The repository's default branch, or `undefined` when it cannot be determined
 * (no `gh`, not authenticated, offline, repo not resolvable from cwd). Every
 * caller uses this for ADVICE only, so "don't know" must never become an error.
 */
export function defaultBranch(
  repo?: string,
  read: (args: string[]) => string = execRead,
): string | undefined {
  try {
    const out = read([
      'gh',
      'repo',
      'view',
      ...(repo ? [repo] : []),
      '--json',
      'defaultBranchRef',
      '-q',
      '.defaultBranchRef.name',
    ]).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * GitHub only populates a pull request's **Development** panel — the
 * "Successfully merging this pull request may close these issues" link that
 * closing keywords are supposed to create — when the PR's base IS the
 * repository's default branch. kodi's own model points `prTarget` at an
 * integration branch (`develop`, `integration/…`), which on a conventionally
 * configured repo is NOT the default branch, so the keywords render correctly,
 * read correctly to a human, and link to nothing.
 *
 * Returns the warning text, or `undefined` when there is nothing to warn about
 * (base IS the default branch, or the default branch is unknown). Azure DevOps
 * has no equivalent restriction — `--work-items` links close on completion
 * whatever the target branch is — so this is a GitHub-only advisory.
 */
export function baseBranchLinkWarning(base: string, def: string | undefined): string | undefined {
  if (!def || base === def) return undefined;
  return (
    `warning: PR base "${base}" is not the repository's default branch ("${def}").\n` +
    `  GitHub creates the Development link ("may close these issues") only when the base IS\n` +
    `  the default branch, so closing keywords in the body will not link or auto-close the\n` +
    `  referenced issues. Either target ${def}, make ${base} the default branch, or link the\n` +
    `  issues by hand in the PR sidebar.\n`
  );
}

/**
 * `gh` 2.46 and older still query GitHub's sunset `projectCards` (Projects
 * classic) field, so `gh pr edit` dies inside `gh` before kodi's body is ever
 * sent. The raw GraphQL text that surfaces reads like a kodi bug or a GitHub
 * outage; it is neither.
 */
const SUNSET_PROJECTS_RE = /projectCards|Projects \(classic\) is being deprecated/i;

/** The `gh` version string (`2.46.0`), or undefined when `gh` cannot be run. */
export function ghVersion(read: (args: string[]) => string = execRead): string | undefined {
  try {
    return /(\d+\.\d+\.\d+)/.exec(read(['gh', '--version']))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Re-shape a failure that came out of `gh` itself into an explanation with a fix.
 * Anything not recognized is returned untouched — kodi never swallows or rewrites
 * an error it does not actually understand.
 *
 * `bodyFile` is kodi's already-rendered, already-validated body: naming it turns
 * the workaround into something the user can paste rather than reconstruct.
 */
export function explainGhFailure(
  err: unknown,
  ctx: { bodyFile?: string; version?: () => string | undefined } = {},
): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (!SUNSET_PROJECTS_RE.test(message)) return err;
  const v = (ctx.version ?? ghVersion)();
  const bodyArg = ctx.bodyFile ? `--field body=@${ctx.bodyFile}` : '--field body=@<body-file>';
  return new Error(
    `your \`gh\` is too old for this command${v ? ` (detected gh ${v})` : ''}: it still queries ` +
      `GitHub's sunset Projects (classic) API, which the server now rejects — the failure is ` +
      `inside gh, before kodi's body is sent.\n` +
      `Upgrade gh (https://github.com/cli/cli/releases); distro packages lag well behind.\n` +
      `Workaround with the body kodi already rendered and validated:\n` +
      `  gh api -X PATCH repos/<owner>/<repo>/pulls/<id> ${bodyArg}\n` +
      `Original error: ${message}`,
  );
}
