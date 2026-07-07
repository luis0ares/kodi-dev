import { spawnSync } from 'node:child_process';

/**
 * The CLI is the sole owner of `gh`/`az` calls (proxy). Reads always execute;
 * mutations are gated by dry-run so a remote board/PR is never changed silently
 * — the command is shown and only runs with `--yes` (dryRun=false).
 */

export interface ExecResult {
  command: string;
  ran: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

function quote(args: string[]): string {
  return args
    .map((a) => (/^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** Run a read-only command; always executes. Throws on non-zero exit. */
export function execRead(args: string[]): string {
  const [cmd, ...rest] = args;
  // stdin: 'ignore' so a proxied child (e.g. az) never drains the wizard's stdin.
  const r = spawnSync(cmd, rest, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(`\`${quote(args)}\` failed (exit ${r.status}): ${r.stderr?.trim() || ''}`);
  }
  return r.stdout ?? '';
}

/**
 * Run a mutating command, gated by dry-run. When `dryRun`, the command is NOT
 * executed — it is returned as a preview so the caller can show it. With
 * `dryRun=false` (i.e. `--yes`), it executes.
 */
export function execMutate(args: string[], dryRun: boolean): ExecResult {
  const command = quote(args);
  if (dryRun) {
    process.stderr.write(`[dry-run] ${command}\n  (re-run with --yes to execute)\n`);
    return { command, ran: false, stdout: '', stderr: '', code: 0 };
  }
  const [cmd, ...rest] = args;
  const r = spawnSync(cmd, rest, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(`\`${command}\` failed (exit ${r.status}): ${r.stderr?.trim() || ''}`);
  }
  return {
    command,
    ran: true,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? 0,
  };
}
