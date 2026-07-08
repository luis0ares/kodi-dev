// Integration tests for the board assembler `buildBoard()` — the SR-3 per-card
// degradation seam and the §7 card projection. Covers: full §7 card shape +
// phantom exclusion (scenario 3 at card level), path-containment degradation
// with sibling survival (scenario 4), symlink-out degradation (scenario 5),
// malformed-file degradation (scenario 7), DoS bound (scenario 9), and SR-4 safe
// YAML through the whole pipe. `buildBoard()` must NEVER throw.

import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBoard } from '@/lib/tickets/board';
import type { BoardModel, BoardTicket } from '@/lib/tickets/types';
import {
  cleanup,
  makeTicketsRoot,
  statusYaml,
  ticketEntry,
  writeStatusYaml,
  writeTicketFile,
} from './fixtures';

// Detect symlink support ONCE so scenario 5 can it.skip with a clear reason
// on platforms/permissions where symlink creation is unavailable.
const SYMLINKS_SUPPORTED = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'kodi-symprobe-'));
  try {
    symlinkSync(join(probe, 'target'), join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    cleanup(probe);
  }
})();

let root: string | undefined;
let outside: string | undefined;

afterEach(() => {
  if (root) cleanup(root);
  if (outside) cleanup(outside);
  root = undefined;
  outside = undefined;
});

function cardByKey(model: BoardModel, key: string): BoardTicket | undefined {
  for (const col of model.columns) {
    const found = col.tickets.find((t) => t.key === key);
    if (found) return found;
  }
  return undefined;
}

function expectPlaceholder(card: BoardTicket | undefined, key: string, status: string): void {
  expect(card).toBeDefined();
  // A placeholder carries ONLY trusted index data: key + column-status. No
  // partial/outside content leaks in.
  expect(card?.key).toBe(key);
  expect(card?.status).toBe(status);
  expect(card?.title).toBe(key);
  expect(card?.summary).toBe('');
  expect(card?.dependencies).toEqual([]);
  expect(card?.drivers).toEqual({ adr: [] });
  expect(card?.acceptanceCriteria).toEqual([]);
  expect('prUrl' in (card ?? {})).toBe(false);
  expect('notes' in (card ?? {})).toBe(false);
}

describe('buildBoard() — §7 card projection & phantom exclusion (scenario 3)', () => {
  it('exposes exactly the §7 card keys, dropping phantom/NG-1 & slug/nonGoals', () => {
    root = makeTicketsRoot();
    writeStatusYaml(root, statusYaml(ticketEntry('KODI-001', 'To review', { slug: 'add-import' })));
    writeTicketFile(root, {
      key: 'KODI-001',
      column: 'To review',
      slug: 'add-import',
      title: 'Add import',
      dependencies: ['KODI-999'],
      drivers: { adr: ['docs/adr/0002'], prd: 'docs/prd/0001', security: 'docs/security/AUTH-014' },
      summary: 'Import a dataset.',
      acceptanceCriteria: ['CSV upload works'],
      nonGoals: ['remote import'],
      prUrl: 'https://example.test/pr/1',
      notes: 'note',
      extra: { priority: 'high', phase: 2, created: '2026-01-01', implementedAt: 'x', branch: 'b', lastCommit: 'c' },
    });

    const card = cardByKey(buildBoard(root), 'KODI-001');
    expect(card).toBeDefined();
    expect(new Set(Object.keys(card as BoardTicket))).toEqual(
      new Set(['key', 'title', 'status', 'dependencies', 'drivers', 'summary', 'acceptanceCriteria', 'prUrl', 'notes']),
    );
    for (const forbidden of ['slug', 'nonGoals', 'priority', 'phase', 'created', 'implementedAt', 'branch', 'lastCommit']) {
      expect(forbidden in (card as BoardTicket)).toBe(false);
    }
    expect(new Set(Object.keys((card as BoardTicket).drivers))).toEqual(new Set(['adr', 'prd', 'security']));
  });

  it('applies §7 card defaults (dependencies [], drivers {adr:[]}) for a minimal file', () => {
    root = makeTicketsRoot();
    writeStatusYaml(root, statusYaml(ticketEntry('KODI-002', 'Pending')));
    writeTicketFile(root, { key: 'KODI-002', column: 'Pending', title: 'Bare', summary: 'min', acceptanceCriteria: ['ok'] });
    const card = cardByKey(buildBoard(root), 'KODI-002');
    expect(card?.dependencies).toEqual([]);
    expect(card?.drivers).toEqual({ adr: [] });
  });
});

describe('buildBoard() — path-containment degradation, siblings survive (scenario 4, SR-1)', () => {
  it('degrades a traversal/mismatch pointer to a placeholder while valid siblings render', () => {
    root = makeTicketsRoot();
    writeStatusYaml(
      root,
      statusYaml(
        ticketEntry('KODI-001', 'Pending', { file: '../../../etc/passwd' }), // SR-1 escape
        ticketEntry('KODI-002', 'Pending', { file: 'done/KODI-002-x.md' }), // I2 mismatch (folder ≠ column)
        ticketEntry('KODI-003', 'Pending'), // valid sibling
      ),
    );
    writeTicketFile(root, { key: 'KODI-003', column: 'Pending', title: 'Good', summary: 'ok' });

    const model = buildBoard(root);
    expectPlaceholder(cardByKey(model, 'KODI-001'), 'KODI-001', 'Pending');
    expectPlaceholder(cardByKey(model, 'KODI-002'), 'KODI-002', 'Pending');
    const good = cardByKey(model, 'KODI-003');
    expect(good?.title).toBe('Good');
    expect(good?.summary).toBe('ok');
  });
});

describe('buildBoard() — symlink-out degradation (scenario 5, SR-2)', () => {
  const runOrSkip = SYMLINKS_SUPPORTED ? it : it.skip;

  runOrSkip('degrades a symlink whose real target is OUTSIDE the root; secret not exposed', () => {
    root = makeTicketsRoot();
    outside = makeTicketsRoot();
    const secret = join(outside, 'secret.md');
    writeFileSync(
      secret,
      '---\nkey: KODI-001\ntitle: SECRET-TITLE\nsummary: leaked-secret\nacceptanceCriteria:\n  - leak\n---\n',
      'utf-8',
    );
    // Replace the canonical file with a symlink pointing outside the root.
    symlinkSync(secret, join(root, 'pending', 'KODI-001-x.md'));
    writeStatusYaml(root, statusYaml(ticketEntry('KODI-001', 'Pending'), ticketEntry('KODI-002', 'Pending')));
    writeTicketFile(root, { key: 'KODI-002', column: 'Pending', title: 'Sibling', summary: 'safe' });

    const model = buildBoard(root);
    const degraded = cardByKey(model, 'KODI-001');
    expectPlaceholder(degraded, 'KODI-001', 'Pending');
    expect(degraded?.title).not.toBe('SECRET-TITLE');
    expect(degraded?.summary).not.toContain('leaked');
    expect(cardByKey(model, 'KODI-002')?.title).toBe('Sibling');
  });

  runOrSkip('degrades a symlink to a MISSING target without crashing the board', () => {
    root = makeTicketsRoot();
    symlinkSync(join(root, 'pending', 'gone.md'), join(root, 'pending', 'KODI-001-x.md'));
    writeStatusYaml(root, statusYaml(ticketEntry('KODI-001', 'Pending'), ticketEntry('KODI-002', 'Pending')));
    writeTicketFile(root, { key: 'KODI-002', column: 'Pending', title: 'Sibling', summary: 'safe' });

    const model = buildBoard(root);
    expectPlaceholder(cardByKey(model, 'KODI-001'), 'KODI-001', 'Pending');
    expect(cardByKey(model, 'KODI-002')?.title).toBe('Sibling');
  });
});

describe('buildBoard() — malformed-file degradation (scenario 7, SR-3)', () => {
  it('degrades a file with NO frontmatter block, others render', () => {
    root = makeTicketsRoot();
    writeStatusYaml(root, statusYaml(ticketEntry('KODI-001', 'Pending'), ticketEntry('KODI-002', 'Pending')));
    writeTicketFile(root, { key: 'KODI-001', column: 'Pending', frontmatter: '# no frontmatter here\njust a body\n' });
    writeTicketFile(root, { key: 'KODI-002', column: 'Pending', title: 'Good', summary: 'ok' });

    const model = buildBoard(root);
    expectPlaceholder(cardByKey(model, 'KODI-001'), 'KODI-001', 'Pending');
    expect(cardByKey(model, 'KODI-002')?.title).toBe('Good');
  });

  it('degrades a file whose frontmatter is not a YAML mapping', () => {
    root = makeTicketsRoot();
    writeStatusYaml(root, statusYaml(ticketEntry('KODI-001', 'Pending')));
    writeTicketFile(root, { key: 'KODI-001', column: 'Pending', frontmatter: '---\njust a scalar string\n---\nbody\n' });
    expectPlaceholder(cardByKey(buildBoard(root), 'KODI-001'), 'KODI-001', 'Pending');
  });
});

describe('buildBoard() — DoS size bound (scenario 9, SR-8)', () => {
  it('an oversize status.yaml (> 1 MiB) yields an empty board, no crash', () => {
    root = makeTicketsRoot();
    const padding = '#'.repeat(1024 * 1024 + 1024); // a giant YAML comment line
    writeStatusYaml(root, `${statusYaml(ticketEntry('KODI-001', 'Pending'))}${padding}\n`);
    const model = buildBoard(root);
    for (const col of model.columns) expect(col.tickets).toEqual([]);
  });

  it('an oversize ticket file (> 1 MiB) degrades that card; siblings render', () => {
    root = makeTicketsRoot();
    writeStatusYaml(root, statusYaml(ticketEntry('KODI-001', 'Pending'), ticketEntry('KODI-002', 'Pending')));
    const bigBody = 'x'.repeat(1024 * 1024 + 1024);
    writeTicketFile(root, { key: 'KODI-001', column: 'Pending', title: 'Big', summary: 's', body: bigBody });
    writeTicketFile(root, { key: 'KODI-002', column: 'Pending', title: 'Small', summary: 'ok' });

    const model = buildBoard(root);
    expectPlaceholder(cardByKey(model, 'KODI-001'), 'KODI-001', 'Pending');
    expect(cardByKey(model, 'KODI-002')?.title).toBe('Small');
  });
});

describe('buildBoard() — SR-4 safe YAML through the pipeline (scenario 8)', () => {
  it('ignores dangerous/non-key entries in status.yaml and never pollutes prototypes', () => {
    root = makeTicketsRoot();
    writeStatusYaml(
      root,
      [
        'version: 1',
        'tickets:',
        '  __proto__:',
        '    column: Pending',
        '    file: pending/x.md',
        '  KODI-001:',
        '    column: Pending',
        '    file: pending/KODI-001-x.md',
      ].join('\n'),
    );
    writeTicketFile(root, { key: 'KODI-001', column: 'Pending', title: 'Only', summary: 'ok' });

    const model = buildBoard(root);
    expect(cardByKey(model, 'KODI-001')?.title).toBe('Only');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
