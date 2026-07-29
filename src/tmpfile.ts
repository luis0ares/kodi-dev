import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Write `content` to a fresh, uniquely-named temp file and return its absolute
 * path. The single home for the temp-file dance both proxies need: `gh` reads a
 * body from `--body-file <path>`, and `az` reads a value from `--description
 * @<path>` (see {@link azFileArg}). Each call gets its own `mkdtemp` directory so
 * concurrent creates never collide.
 */
export function writeTempFile(content: string, prefix: string, name: string): string {
  const file = join(mkdtempSync(join(tmpdir(), prefix)), name);
  writeFileSync(file, content, 'utf-8');
  return file;
}

/**
 * Route a (possibly multi-line) value to `az` through a temp file and return the
 * `@<path>` token az expands — i.e. `--description @<path>` instead of
 * `--description <inline html>`.
 *
 * WHY (the Windows bug this fixes): on Windows `az` is a `.cmd` shim, and
 * cmd.exe's `%*` argument forwarding TRUNCATES any argv value at its first
 * newline. An inline multi-line `--description` therefore reaches az as only its
 * first line — silently dropping the rest of the body AND every flag that came
 * after it (`--output json`, `--work-items`, …). cross-spawn escapes shell
 * metacharacters but cannot escape a literal newline for a batch file, so the
 * value itself must never carry one. The `@<path>` token is single-line (it
 * survives the shim intact) and az reads the full file content itself, so the
 * complete body round-trips on Windows exactly as it already does on Linux/macOS,
 * where az is a real binary invoked without cmd.exe.
 *
 * az treats a leading `@` as "read from file"; since we prefix the PATH (never the
 * content), a body that itself begins with `@` is unaffected.
 */
export function azFileArg(content: string, prefix: string): string {
  return `@${writeTempFile(content, prefix, 'body.html')}`;
}
