import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { azFileArg, writeTempFile } from '../src/tmpfile.js';

const HTML = '<h1>T</h1>\n<p>two</p>\n<pre>kodi:ticket:BASE64==</pre>';

describe('tmpfile', () => {
  it('writeTempFile persists the exact content and returns an existing absolute path', () => {
    const content = '<h1>Title</h1>\nline two\nline three';
    const path = writeTempFile(content, 'kodi-test-', 'body.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(content);
  });

  it('passes the body through UNCHANGED off Windows — no temp file, no rewritten arg', () => {
    // The platform gate. On Linux/macOS az is a real binary, the multi-line value
    // already arrives intact, and the dry-run preview must keep showing the real
    // body rather than a path that stops resolving once /tmp is swept.
    for (const platform of ['linux', 'darwin'] as const) {
      expect(azFileArg(HTML, 'kodi-test-', platform)).toBe(HTML);
    }
  });

  it('returns an @<path> token on Windows whose file holds the FULL multi-line body', () => {
    // The Windows fix: the multi-line HTML lives in the file, never in argv, so az's
    // `.cmd` shim (which truncates an argv value at its first newline) can no longer
    // drop everything after the first line.
    const arg = azFileArg(HTML, 'kodi-test-', 'win32');
    expect(arg.startsWith('@')).toBe(true);
    const path = arg.slice(1);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(HTML);
    // The token az actually receives on argv is single-line — the property that
    // survives the shim intact.
    expect(arg).not.toContain('\n');
  });

  it('gives each Windows call a distinct path so concurrent writes never collide', () => {
    const a = azFileArg('a', 'kodi-test-', 'win32');
    const b = azFileArg('b', 'kodi-test-', 'win32');
    expect(a).not.toBe(b);
    expect(readFileSync(a.slice(1), 'utf-8')).toBe('a');
    expect(readFileSync(b.slice(1), 'utf-8')).toBe('b');
  });
});
