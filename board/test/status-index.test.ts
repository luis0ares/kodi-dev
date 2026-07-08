// Pure-lib unit tests for the status-index resolver (SR-1 lexical containment,
// SR-2 symlink-out escape, I2/I4) and the safe YAML parser (SR-4 null-proto +
// key filter + merge-key rejection). These are the security-critical seams, so
// they are exercised directly rather than only through the board assembler.

import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  resolveContainedFile,
  safeParseStatusIndex,
  type StatusIndexEntry,
} from '@/lib/tickets/status-index';
import { cleanup, makeTicketsRoot, symlinkSync, writeTicketFile } from './fixtures';

let root: string | undefined;
let outside: string | undefined;

afterEach(() => {
  if (root) cleanup(root);
  if (outside) cleanup(outside);
  root = undefined;
  outside = undefined;
});

describe('safeParseStatusIndex — SR-4 safe YAML (scenario 8)', () => {
  it('keeps only well-formed ticket-key entries with valid column + string file', () => {
    const text = [
      'version: 1',
      'tickets:',
      '  KODI-001:',
      '    column: Pending',
      '    file: pending/KODI-001-x.md',
      '  KODI-002:',
      '    column: NotAColumn', // invalid column → dropped
      '    file: pending/KODI-002-x.md',
      '  KODI-003:',
      '    column: Done', // missing file → dropped
      '  not-a-key:', // fails KEY_RE → dropped
      '    column: Pending',
      '    file: pending/whatever.md',
    ].join('\n');
    const index = safeParseStatusIndex(text);
    expect(Object.keys(index.tickets)).toEqual(['KODI-001']);
    expect(index.tickets['KODI-001']).toEqual({ column: 'Pending', file: 'pending/KODI-001-x.md' });
  });

  it('drops __proto__/constructor/prototype keys and does not pollute Object.prototype', () => {
    const text = [
      'tickets:',
      '  __proto__:',
      '    column: Pending',
      '    file: pending/x.md',
      '  constructor:',
      '    column: Pending',
      '    file: pending/x.md',
      '  prototype:',
      '    column: Pending',
      '    file: pending/x.md',
      '  KODI-001:',
      '    column: Pending',
      '    file: pending/KODI-001-x.md',
    ].join('\n');
    const index = safeParseStatusIndex(text);
    expect(Object.keys(index.tickets)).toEqual(['KODI-001']);
    // The map is null-proto: no inherited pollution surfaced through it.
    expect((index.tickets as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not honor YAML merge keys (<<); the merged column/file is not injected', () => {
    const text = [
      'defaults: &d',
      '  column: Pending',
      '  file: pending/KODI-999-x.md',
      'tickets:',
      '  KODI-001:',
      '    <<: *d', // merge into the entry — must NOT be honored
      '  KODI-002:',
      '    column: Done',
      '    file: done/KODI-002-x.md',
    ].join('\n');
    const index = safeParseStatusIndex(text);
    // KODI-001 gained neither column nor file via merge → dropped entirely.
    expect(index.tickets['KODI-001']).toBeUndefined();
    expect(Object.keys(index.tickets)).toEqual(['KODI-002']);
  });

  it('absent / empty / non-object input → an empty index, never a throw', () => {
    expect(Object.keys(safeParseStatusIndex('').tickets)).toEqual([]);
    expect(Object.keys(safeParseStatusIndex('null').tickets)).toEqual([]);
    expect(Object.keys(safeParseStatusIndex('- a\n- b').tickets)).toEqual([]);
    expect(Object.keys(safeParseStatusIndex('tickets: [1, 2]').tickets)).toEqual([]);
  });
});

describe('resolveContainedFile — SR-1 lexical containment + I2/I4 (scenario 4)', () => {
  const rejects: Array<{ name: string; key: string; entry: StatusIndexEntry }> = [
    { name: 'absolute path', key: 'KODI-001', entry: { column: 'Pending', file: '/etc/passwd' } },
    { name: 'Windows drive letter', key: 'KODI-001', entry: { column: 'Pending', file: 'C:\\Windows\\win.ini' } },
    { name: 'backslash / UNC', key: 'KODI-001', entry: { column: 'Pending', file: '\\\\server\\share\\x.md' } },
    { name: '.. traversal', key: 'KODI-001', entry: { column: 'Pending', file: '../../../etc/passwd' } },
    { name: 'traversal inside a valid-looking folder', key: 'KODI-001', entry: { column: 'Pending', file: 'pending/../../../etc/passwd' } },
    { name: 'empty segment', key: 'KODI-001', entry: { column: 'Pending', file: 'pending//KODI-001-x.md' } },
    { name: 'too many segments', key: 'KODI-001', entry: { column: 'Pending', file: 'pending/sub/KODI-001-x.md' } },
    { name: 'too few segments', key: 'KODI-001', entry: { column: 'Pending', file: 'KODI-001-x.md' } },
    { name: 'I2 folder/column mismatch', key: 'KODI-001', entry: { column: 'Pending', file: 'blocked/KODI-001-x.md' } },
    { name: 'I4 key mismatch', key: 'KODI-001', entry: { column: 'Pending', file: 'pending/KODI-002-x.md' } },
    { name: 'malformed filename (no <KEY>- prefix)', key: 'KODI-001', entry: { column: 'Pending', file: 'pending/notes.md' } },
    { name: 'invalid ticket key', key: 'not-a-key', entry: { column: 'Pending', file: 'pending/x.md' } },
    { name: 'empty pointer', key: 'KODI-001', entry: { column: 'Pending', file: '' } },
  ];

  for (const { name, key, entry } of rejects) {
    it(`rejects ${name}`, () => {
      root = makeTicketsRoot();
      const realRoot = realpathSync(root);
      expect(() => resolveContainedFile(root as string, realRoot, key, entry)).toThrow();
    });
  }

  it('accepts a well-formed, contained pointer and returns the real absolute path', () => {
    root = makeTicketsRoot();
    const realRoot = realpathSync(root);
    const written = writeTicketFile(root, { key: 'KODI-001', column: 'Pending', slug: 'x' });
    const resolved = resolveContainedFile(root, realRoot, 'KODI-001', {
      column: 'Pending',
      file: 'pending/KODI-001-x.md',
    });
    expect(resolved).toBe(realpathSync(written));
  });
});

describe('resolveContainedFile — SR-2 symlink-out escape (scenario 5)', () => {
  it('rejects a ticket file that is a symlink whose real target is OUTSIDE the root', () => {
    root = makeTicketsRoot();
    outside = makeTicketsRoot();
    const secret = join(outside, 'secret.md');
    writeFileSync(secret, '---\nkey: KODI-666\ntitle: SECRET\nsummary: leaked\n---\n', 'utf-8');
    const linkPath = join(root, 'pending', 'KODI-001-x.md');
    try {
      symlinkSync(secret, linkPath);
    } catch {
      return; // symlink unsupported on this platform — covered by it.skip elsewhere
    }
    const realRoot = realpathSync(root);
    expect(() =>
      resolveContainedFile(root as string, realRoot, 'KODI-001', {
        column: 'Pending',
        file: 'pending/KODI-001-x.md',
      }),
    ).toThrow(/symlink/);
  });

  it('rejects a symlink to a MISSING target (realpath throws → degrade, no fallback)', () => {
    root = makeTicketsRoot();
    const linkPath = join(root, 'pending', 'KODI-001-x.md');
    try {
      symlinkSync(join(root, 'pending', 'does-not-exist.md'), linkPath);
    } catch {
      return;
    }
    const realRoot = realpathSync(root);
    expect(() =>
      resolveContainedFile(root as string, realRoot, 'KODI-001', {
        column: 'Pending',
        file: 'pending/KODI-001-x.md',
      }),
    ).toThrow();
  });
});

describe('MAX_FILE_BYTES — SR-8 cap constant (scenario 9)', () => {
  it('is a 1 MiB byte cap', () => {
    expect(MAX_FILE_BYTES).toBe(1024 * 1024);
  });
});
