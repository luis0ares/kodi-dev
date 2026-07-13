import type { SpawnSyncReturns } from 'node:child_process';
import spawn from 'cross-spawn';

/**
 * The CLI is the sole owner of `gh`/`az` calls (proxy). Reads always execute;
 * mutations are gated by dry-run so a remote board/PR is never changed silently
 * — the command is shown and only runs with `--yes` (dryRun=false).
 *
 * Spawns go through `cross-spawn` (never `shell: true`): on Windows `gh`/`az` are
 * `.cmd` shims that Node's own spawn refuses to launch (fails with ENOENT and
 * `status === null`, i.e. the misleading "exit null"). cross-spawn resolves the
 * shim AND escapes arguments, so kodi keeps its shell-free posture — no injection
 * surface even though ticket titles / HTML descriptions flow through as args.
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

/**
 * Why a spawn failed. Surfaces the spawn `error.code` (e.g. ENOENT — binary not
 * found / not launchable) when the child never started, since a bare `exit null`
 * is indistinguishable from a real non-zero exit and reads like an auth/PATH bug.
 */
function exitReason(r: SpawnSyncReturns<string>): string {
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${r.error.message}` : r.error.message;
  }
  return `exit ${r.status}`;
}

/** Run a read-only command; always executes. Throws on non-zero exit. */
export function execRead(args: string[]): string {
  const [cmd, ...rest] = args;
  // stdin: 'ignore' so a proxied child (e.g. az) never drains the wizard's stdin.
  const r = spawn.sync(cmd, rest, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) {
    throw new Error(
      `\`${quote(args)}\` failed (${exitReason(r)}): ${r.stderr?.trim() || r.error?.message || ''}`,
    );
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
  const r = spawn.sync(cmd, rest, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) {
    throw new Error(
      `\`${command}\` failed (${exitReason(r)}): ${r.stderr?.trim() || r.error?.message || ''}`,
    );
  }
  return {
    command,
    ran: true,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? 0,
  };
}
