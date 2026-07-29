import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { azFileArg, writeTempFile } from '../src/tmpfile.js';

describe('tmpfile', () => {
  it('writeTempFile persists the exact content and returns an existing absolute path', () => {
    const content = '<h1>Title</h1>\nline two\nline three';
    const path = writeTempFile(content, 'kodi-test-', 'body.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(content);
  });

  it('azFileArg returns an @<path> token whose file holds the FULL multi-line body', () => {
    // This is the Windows fix: the multi-line HTML lives in the file, never in argv,
    // so az's `.cmd` shim (which truncates an argv value at its first newline) can
    // no longer drop everything after the first line.
    const html = '<h1>T</h1>\n<p>two</p>\n<pre>kodi:ticket:BASE64==</pre>';
    const arg = azFileArg(html, 'kodi-test-');
    expect(arg.startsWith('@')).toBe(true);
    const path = arg.slice(1);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(html);
    // The token az actually receives on argv is single-line — the property that
    // survives the Windows shim intact.
    expect(arg).not.toContain('\n');
  });

  it('gives each call a distinct path so concurrent writes never collide', () => {
    const a = azFileArg('a', 'kodi-test-');
    const b = azFileArg('b', 'kodi-test-');
    expect(a).not.toBe(b);
    expect(readFileSync(a.slice(1), 'utf-8')).toBe('a');
    expect(readFileSync(b.slice(1), 'utf-8')).toBe('b');
  });
});
