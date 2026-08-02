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
 * How a (possibly multi-line) value reaches `az` — **inline everywhere except
 * Windows**.
 *
 * WHY WINDOWS NEEDS ANYTHING ELSE: there `az` is a `.cmd` shim, and cmd.exe's
 * `%*` argument forwarding TRUNCATES any argv value at its first newline. An
 * inline multi-line `--description` reaches az as only its first line — silently
 * dropping the rest of the body AND every flag that came after it (`--output
 * json`, `--work-items`, …). cross-spawn escapes shell metacharacters but cannot
 * escape a literal newline for a batch file, so on Windows the value itself must
 * never carry one: the body goes to a temp file and az gets the single-line
 * `@<path>` token, which it expands by reading the file.
 *
 * WHY EVERY OTHER PLATFORM KEEPS THE INLINE VALUE: on Linux/macOS `az` is a real
 * binary invoked without cmd.exe, so the multi-line argv value already arrives
 * intact — there is no bug to fix. Routing it through a file anyway would change
 * behaviour that works: it would leave a temp file behind on every description
 * write, and turn kodi's dry-run preview into `--description @/tmp/…/body.html`,
 * a command the user can no longer read or re-run once the temp file is gone.
 * So the fix is scoped to the platform that has the defect, and non-Windows argv
 * stays byte-for-byte what it has always been.
 *
 * `platform` is injectable so both shapes are testable from one machine.
 *
 * az treats a leading `@` as "read from file"; the prefix goes on the PATH, never
 * the content, so a body that itself begins with `@` is unaffected — and on
 * non-Windows the value is passed through untouched, exactly as before.
 */
export function azFileArg(
  content: string,
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return content;
  return `@${writeTempFile(content, prefix, 'body.html')}`;
}
