import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalTicketProvider } from '../src/providers/local.js';
import {
  resolveFile,
  slugForStatus,
  type StatusIndexEntry,
} from '../src/providers/status-index.js';
import { TICKET_STATUSES, TicketSchema, type TicketStatus } from '../src/templates/ticket.js';

// KODI-007 capstone: the local provider's status.yaml + per-status-folder model,
// exercised on a real mkdtemp disk with the invariants I1–I5 (data-model §5) named
// and asserted AFTER each command returns. Every transition (create / set-status /
// start / hand-off / delete) routes through the temp-then-rename, index-committed-
// last write protocol (ADR-0001 §2.4); these tests pin its post-conditions.

let dir: string;
let provider: LocalTicketProvider;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kodi-test-'));
  provider = new LocalTicketProvider('KODI', dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function draft(over: Record<string, unknown> = {}) {
  return TicketSchema.parse({
    title: 'Add dataset import',
    summary: 'Import a dataset from CSV.',
    acceptanceCriteria: ['CSV upload works'],
    ...over,
  });
}

// ---- disk helpers (assert directly against the on-disk status.yaml + folder model) ----

const ticketsRoot = () => join(dir, 'docs', 'tickets');
const statusYamlPath = () => join(ticketsRoot(), 'status.yaml');

/** Parse the on-disk status.yaml index. */
function readIndex(): {
  version: number;
  columns: string[];
  tickets: Record<string, { column: string; file: string }>;
} {
  return parseYaml(readFileSync(statusYamlPath(), 'utf-8'));
}

/** Absolute path where a ticket at `status` must physically live. */
function fileAt(status: TicketStatus, key: string, slug: string): string {
  return join(ticketsRoot(), slugForStatus(status), `${key}-${slug}.md`);
}

/** Frontmatter `status` value of a ticket file (the mirrored, possibly-stale field). */
function frontmatterStatus(path: string): string {
  const raw = readFileSync(path, 'utf-8');
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  expect(m).not.toBeNull();
  return (parseYaml(m![1]) as { status: string }).status;
}

/** Frontmatter `key` value of a ticket file (the file's own identity claim — drives I5). */
function frontmatterKey(path: string): string {
  const raw = readFileSync(path, 'utf-8');
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  expect(m).not.toBeNull();
  return (parseYaml(m![1]) as { key: string }).key;
}

/** Every ticket-shaped `.md` currently on disk, as `<slug>/<file>` pointers. */
function diskFiles(): string[] {
  const out: string[] = [];
  for (const status of TICKET_STATUSES) {
    const folder = join(ticketsRoot(), slugForStatus(status));
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (name.endsWith('.md')) out.push(`${slugForStatus(status)}/${name}`);
    }
  }
  return out.sort();
}

/**
 * Enforce data-model §5 invariants I1–I5 for a single ticket AFTER a command
 * returns, against the real mkdtemp disk. Each block below is labelled with the
 * exact invariant it enforces. The *global* half of I1 (set-equality of on-disk
 * files ⟷ index pointers across ALL tickets) is asserted by {@link assertBijection}.
 */
function assertInvariants(key: string, slug: string, status: TicketStatus): void {
  const doc = readIndex();
  const entry = doc.tickets[key];

  // I4 — Key identity: the key appears exactly once in `tickets`, and the <KEY>
  // segment of `file` equals the map key.
  expect(entry).toBeDefined();
  expect(Object.keys(doc.tickets).filter((k) => k === key)).toEqual([key]);
  const fileKey = /^[a-z-]+\/([A-Z][A-Z0-9]*-\d+)-/.exec(entry.file);
  expect(fileKey?.[1]).toBe(key);

  // I2 — Column/folder agreement: dirname(file) === slug(column); the ticket
  // physically resides in slug(column) and in no other status folder.
  expect(entry.column).toBe(status);
  expect(entry.file.split('/')[0]).toBe(slugForStatus(status));
  expect(entry.file).toBe(`${slugForStatus(status)}/${key}-${slug}.md`);
  const here = fileAt(status, key, slug);
  expect(existsSync(here)).toBe(true);
  const physical = TICKET_STATUSES.filter((s) => existsSync(fileAt(s, key, slug)));
  // I1 (local) — exactly one physical file for the key (no duplicate stranded by a
  // move) and, above, exactly one index entry.
  expect(physical).toEqual([status]);

  // I3 — Placement mirror: frontmatter `status` === tickets[key].column.
  expect(frontmatterStatus(here)).toBe(entry.column);

  // I5 — Resolvable, matching pointer: resolve(docs/tickets/, file) exists, is a
  // readable md, and its parsed frontmatter `key` equals the map key. Resolved
  // through the provider's own resolveFile so containment + I2/I4 are re-checked.
  const resolved = resolveFile(statusYamlPath(), key, entry as StatusIndexEntry);
  expect(resolved).toBe(here);
  expect(existsSync(resolved)).toBe(true);
  expect(resolved.endsWith('.md')).toBe(true);
  expect(frontmatterKey(resolved)).toBe(key);
}

/**
 * I1 — Bijection (global, no orphans): the set of on-disk ticket `.md` files
 * equals the set of index `file` pointers. No orphan file (filed but unindexed),
 * no dangling pointer (indexed but not on disk).
 */
function assertBijection(): void {
  const doc = readIndex();
  const indexFiles = Object.values(doc.tickets)
    .map((e) => e.file)
    .sort();
  expect(diskFiles()).toEqual(indexFiles);
}

/**
 * Extract each ticket's raw YAML block (its key line + indented body) from a
 * serialized status.yaml, so a move can be asserted to touch ONE block only
 * (minimal-diff, R-015).
 */
function ticketBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = text.split('\n');
  let curKey: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (curKey) blocks.set(curKey, buf.join('\n'));
    curKey = null;
    buf = [];
  };
  for (const line of lines) {
    const km = /^ {2}([A-Z][A-Z0-9]*-\d+):$/.exec(line);
    if (km) {
      flush();
      curKey = km[1];
      buf = [line];
    } else if (curKey && /^ {4}\S/.test(line)) {
      buf.push(line);
    } else if (curKey) {
      flush();
    }
  }
  flush();
  return blocks;
}

describe('local provider — key assignment & readiness', () => {
  it('assigns sequential keys', async () => {
    const a = await provider.create(draft());
    const b = await provider.create(draft({ title: 'Second ticket' }));
    expect(a.key).toBe('KODI-001');
    expect(b.key).toBe('KODI-002');
    expect(await provider.nextId()).toBe('KODI-003');
  });

  it('round-trips a ticket through disk (rendered body, dependencies preserved)', async () => {
    const created = await provider.create(draft({ dependencies: ['KODI-999'] }));
    const got = await provider.get(created.key);
    expect(got).not.toBeNull();
    expect(got!.title).toBe('Add dataset import');
    expect(got!.dependencies).toEqual(['KODI-999']);
    const file = fileAt('Pending', created.key, created.slug);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toContain('## Acceptance criteria');
    assertInvariants(created.key, created.slug, 'Pending');
    assertBijection();
  });

  it('computes readiness from dependencies', async () => {
    const dep = await provider.create(draft({ title: 'Prerequisite' }));
    const blocked = await provider.create(
      draft({ title: 'Needs prereq', dependencies: [dep.key] }),
    );
    let ready = await provider.listReady();
    expect(ready.ready.map((t) => t.key)).toContain(dep.key);
    expect(ready.blocked.map((b) => b.ticket.key)).toContain(blocked.key);

    await provider.setStatus(dep.key, 'Done');
    ready = await provider.listReady();
    expect(ready.ready.map((t) => t.key)).toContain(blocked.key);
    expect(ready.blocked).toHaveLength(0);
  });
});

describe('local provider — lazy scaffold (R-003, ADR-0001 §2.3)', () => {
  it('first create scaffolds status.yaml (version 1, five columns, ticket present) + all five folders', async () => {
    const t = await provider.create(draft());

    const doc = readIndex();
    expect(doc.version).toBe(1);
    expect(doc.columns).toEqual([...TICKET_STATUSES]);
    expect(doc.tickets[t.key]).toEqual({
      column: 'Pending',
      file: `pending/${t.key}-${t.slug}.md`,
    });

    // all five status folders exist on disk (empty columns still have their folder)
    for (const status of TICKET_STATUSES) {
      expect(existsSync(join(ticketsRoot(), slugForStatus(status)))).toBe(true);
    }
    assertInvariants(t.key, t.slug, 'Pending');
    assertBijection();
  });

  it('a second create is idempotent: no duplication, no corruption (both tickets, one entry each)', async () => {
    const a = await provider.create(draft());
    const b = await provider.create(draft({ title: 'Parse headers' }));

    const doc = readIndex();
    expect(doc.version).toBe(1);
    expect(doc.columns).toEqual([...TICKET_STATUSES]);
    expect(Object.keys(doc.tickets).sort()).toEqual([a.key, b.key].sort());
    assertInvariants(a.key, a.slug, 'Pending');
    assertInvariants(b.key, b.slug, 'Pending');
    assertBijection();
  });
});

describe('local provider — the five transitions each preserve I1–I5 (data-model §5, ADR-0001 §2.4)', () => {
  it('T1 create: files the ticket under Pending and satisfies I1–I5', async () => {
    const t = await provider.create(draft());
    expect(existsSync(fileAt('Pending', t.key, t.slug))).toBe(true);
    assertInvariants(t.key, t.slug, 'Pending');
    assertBijection();
  });

  it('T2 set-status: moves the file, mirrors frontmatter, satisfies I1–I5, leaves NO source-folder residue', async () => {
    const t = await provider.create(draft());
    await provider.setStatus(t.key, 'Done');
    assertInvariants(t.key, t.slug, 'Done');
    // crash-residue-free post-condition: the source folder holds no leftover file
    expect(existsSync(fileAt('Pending', t.key, t.slug))).toBe(false);
    assertBijection();
  });

  it('T3 start: transitions to In progress and satisfies I1–I5 (no pending/ residue)', async () => {
    const t = await provider.create(draft());
    await provider.start(t.key, { branch: 'feat/x', startedBy: 'tester' });
    assertInvariants(t.key, t.slug, 'In progress');
    expect(existsSync(fileAt('Pending', t.key, t.slug))).toBe(false);
    assertBijection();
  });

  it('T4 hand-off (provider-level setStatus "To review"): satisfies I1–I5, no source residue', async () => {
    const t = await provider.create(draft());
    await provider.start(t.key, { branch: 'feat/x', startedBy: 'tester' });
    // provider-level hand-off IS setStatus(key, 'To review'); the command layer
    // adds PR linking on top. There is no provider handOff() method.
    await provider.setStatus(t.key, 'To review');
    assertInvariants(t.key, t.slug, 'To review');
    expect(existsSync(fileAt('In progress', t.key, t.slug))).toBe(false);
    assertBijection();
  });

  it('T5 delete: removes both the file and the index entry (no orphan); bijection holds', async () => {
    const t = await provider.create(draft());
    await provider.setStatus(t.key, 'In progress');
    await provider.delete(t.key);

    expect(await provider.get(t.key)).toBeNull();
    const doc = readIndex();
    expect(doc.tickets[t.key]).toBeUndefined();
    // no file left in ANY status folder (no orphan on the retired side)
    for (const status of TICKET_STATUSES) {
      expect(existsSync(fileAt(status, t.key, t.slug))).toBe(false);
    }
    // and no dangling pointer / orphan file globally
    assertBijection();
  });

  it('end-to-end lifecycle: create → start → hand-off → Done → delete stays I1–I5 consistent at every step', async () => {
    const t = await provider.create(draft());
    assertInvariants(t.key, t.slug, 'Pending');
    assertBijection();

    await provider.start(t.key, { branch: 'feat/x', startedBy: 'tester' });
    assertInvariants(t.key, t.slug, 'In progress');
    expect(existsSync(fileAt('Pending', t.key, t.slug))).toBe(false);
    assertBijection();

    await provider.setStatus(t.key, 'To review'); // hand-off
    assertInvariants(t.key, t.slug, 'To review');
    expect(existsSync(fileAt('In progress', t.key, t.slug))).toBe(false);
    assertBijection();

    await provider.setStatus(t.key, 'Done');
    assertInvariants(t.key, t.slug, 'Done');
    expect(existsSync(fileAt('To review', t.key, t.slug))).toBe(false);
    assertBijection();

    await provider.delete(t.key);
    expect(await provider.get(t.key)).toBeNull();
    expect(readIndex().tickets[t.key]).toBeUndefined();
    assertBijection();
  });
});

describe('local provider — index-wins tie-break (data-model §4)', () => {
  it('a ticket whose frontmatter status is hand-desynced still reports the INDEX column for get()/list()', async () => {
    const t = await provider.create(draft());
    await provider.setStatus(t.key, 'In progress');

    // hand-edit only the frontmatter status line to a stale value; keep the file in
    // its indexed folder so I2 still holds — only frontmatter (the mirror) lies.
    const path = fileAt('In progress', t.key, t.slug);
    const raw = readFileSync(path, 'utf-8');
    const staled = raw.replace(/^status: .*$/m, 'status: Done');
    expect(staled).not.toBe(raw);
    expect(frontmatterStatus(path)).toBe('In progress'); // sanity: unedited baseline
    writeFileSync(path, staled, 'utf-8');
    expect(frontmatterStatus(path)).toBe('Done'); // sanity: the file now lies

    // the index is authoritative: consumers report the index column, not frontmatter
    const got = await provider.get(t.key);
    expect(got!.status).toBe('In progress');
    const ref = (await provider.list()).find((r) => r.key === t.key);
    expect(ref!.status).toBe('In progress');
  });
});

describe('local provider — serialization determinism through the disk path (data-model §1, R-015)', () => {
  it('writes tickets key-sorted on disk after a real transition', async () => {
    const a = await provider.create(draft({ title: 'Alpha' }));
    const b = await provider.create(draft({ title: 'Bravo' }));
    const c = await provider.create(draft({ title: 'Charlie' }));
    await provider.setStatus(b.key, 'To review'); // last write is a move, not a create

    const text = readFileSync(statusYamlPath(), 'utf-8');
    const keysInFileOrder = [...text.matchAll(/^ {2}([A-Z][A-Z0-9]*-\d+):$/gm)].map((m) => m[1]);
    expect(keysInFileOrder).toEqual([a.key, b.key, c.key]);
    expect(keysInFileOrder).toEqual([...keysInFileOrder].sort());
  });

  it('a move is a MINIMAL diff: only the moved entry changes; every other block is byte-identical', async () => {
    const a = await provider.create(draft({ title: 'Alpha' }));
    const b = await provider.create(draft({ title: 'Bravo' }));

    const before = readFileSync(statusYamlPath(), 'utf-8');
    await provider.setStatus(b.key, 'To review');
    const after = readFileSync(statusYamlPath(), 'utf-8');
    expect(after).not.toBe(before);

    const blkBefore = ticketBlocks(before);
    const blkAfter = ticketBlocks(after);

    // untouched ticket A: its block is byte-for-byte identical
    expect(blkAfter.get(a.key)).toBe(blkBefore.get(a.key));

    // moved ticket B: exactly its column + file lines changed, nothing else
    expect(blkBefore.get(b.key)).toBe(
      `  ${b.key}:\n    column: Pending\n    file: pending/${b.key}-${b.slug}.md`,
    );
    expect(blkAfter.get(b.key)).toBe(
      `  ${b.key}:\n    column: To review\n    file: to-review/${b.key}-${b.slug}.md`,
    );

    // the header (version + the five-column list, everything before `tickets:`) is unchanged
    const head = (t: string) => t.slice(0, t.indexOf('tickets:'));
    expect(head(after)).toBe(head(before));
  });

  it('byte-stability: a placement-preserving op (amend) re-emits status.yaml identically', async () => {
    await provider.create(draft({ title: 'Alpha' }));
    const t = await provider.create(draft({ title: 'Bravo' }));
    const before = readFileSync(statusYamlPath(), 'utf-8');

    // amend rewrites the ticket file and re-saves the index, but placement is
    // unchanged → re-serializing the same state must yield byte-identical output.
    await provider.amend(t.key, { summary: 'edited summary' });
    expect(readFileSync(statusYamlPath(), 'utf-8')).toBe(before);
  });
});

describe('local provider — amend (content edit, placement unchanged)', () => {
  it('amends editable fields and persists them without moving the ticket', async () => {
    const t = await provider.create(draft());
    await provider.amend(t.key, {
      summary: 'New summary',
      dependencies: ['KODI-050'],
      prUrl: 'owner/repo#12',
    });
    const got = await provider.get(t.key);
    expect(got!.summary).toBe('New summary');
    expect(got!.dependencies).toEqual(['KODI-050']);
    expect(got!.prUrl).toBe('owner/repo#12');
    expect(got!.key).toBe(t.key);
    expect(got!.slug).toBe(t.slug);
    assertInvariants(t.key, t.slug, 'Pending');
    assertBijection();
  });
});
