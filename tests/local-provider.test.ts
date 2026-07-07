import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalTicketProvider } from '../src/providers/local.js';
import { slugForStatus } from '../src/providers/status-index.js';
import { TICKET_STATUSES, TicketSchema, type TicketStatus } from '../src/templates/ticket.js';

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

// ---- disk helpers (assert directly against the new status.yaml + folder model) ----

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
 * Assert the full trio + bijection for a ticket after a command returns:
 * (a) index column, (b) file physically in the matching folder and nowhere else,
 * (c) frontmatter mirrors the index column, (d) exactly one file + one entry.
 */
function assertConsistent(key: string, slug: string, status: TicketStatus): void {
  const doc = readIndex();
  // (a) index column + composed pointer
  expect(doc.tickets[key]).toBeDefined();
  expect(doc.tickets[key].column).toBe(status);
  expect(doc.tickets[key].file).toBe(`${slugForStatus(status)}/${key}-${slug}.md`);

  // (b) lives in the matching folder, and is absent from every other status folder
  const here = fileAt(status, key, slug);
  expect(existsSync(here)).toBe(true);
  let onDisk = 0;
  for (const s of TICKET_STATUSES) {
    if (existsSync(fileAt(s, key, slug))) onDisk++;
    else expect(s).not.toBe(status);
  }
  // (d1) exactly one physical file for the key (no duplicate left behind on a move)
  expect(onDisk).toBe(1);

  // (c) frontmatter status mirrors the index column
  expect(frontmatterStatus(here)).toBe(status);

  // (d2) exactly one index entry for the key
  expect(Object.keys(doc.tickets).filter((k) => k === key)).toEqual([key]);
}

/** Global bijection: the set of on-disk ticket files equals the set of index pointers. */
function assertBijection(): void {
  const doc = readIndex();
  const indexFiles = Object.values(doc.tickets)
    .map((e) => e.file)
    .sort();
  expect(diskFiles()).toEqual(indexFiles);
}

describe('local ticket provider', () => {
  it('assigns sequential keys', async () => {
    const a = await provider.create(draft());
    const b = await provider.create(draft({ title: 'Second ticket' }));
    expect(a.key).toBe('KODI-001');
    expect(b.key).toBe('KODI-002');
    expect(await provider.nextId()).toBe('KODI-003');
  });

  it('scaffolds status.yaml (version 1, five columns, ticket present) and all five folders on first create', async () => {
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
    assertBijection();
  });

  it('a second create does not duplicate or corrupt the index (both tickets, single entry each)', async () => {
    const a = await provider.create(draft());
    const b = await provider.create(draft({ title: 'Parse headers' }));

    const doc = readIndex();
    expect(doc.version).toBe(1);
    expect(doc.columns).toEqual([...TICKET_STATUSES]);
    expect(Object.keys(doc.tickets).sort()).toEqual([a.key, b.key].sort());
    assertConsistent(a.key, a.slug, 'Pending');
    assertConsistent(b.key, b.slug, 'Pending');
    assertBijection();
  });

  it('create files a ticket under pending/ by default and indexes it under Pending', async () => {
    const t = await provider.create(draft());
    expect(existsSync(fileAt('Pending', t.key, t.slug))).toBe(true);
    assertConsistent(t.key, t.slug, 'Pending');
  });

  it('round-trips a ticket through disk (file under pending/ with rendered body)', async () => {
    const created = await provider.create(draft({ dependencies: ['KODI-999'] }));
    const got = await provider.get(created.key);
    expect(got).not.toBeNull();
    expect(got!.title).toBe('Add dataset import');
    expect(got!.dependencies).toEqual(['KODI-999']);
    const file = fileAt('Pending', created.key, created.slug);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toContain('## Acceptance criteria');
    assertConsistent(created.key, created.slug, 'Pending');
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

  it('walks a ticket through the lifecycle keeping index/folder/frontmatter consistent at each step', async () => {
    const t = await provider.create(draft());
    assertConsistent(t.key, t.slug, 'Pending');
    assertBijection();

    // start() → In progress
    await provider.start(t.key, { branch: 'feat/x', startedBy: 'tester' });
    assertConsistent(t.key, t.slug, 'In progress');
    expect(existsSync(fileAt('Pending', t.key, t.slug))).toBe(false);
    assertBijection();

    // hand-off is setStatus('To review')
    await provider.setStatus(t.key, 'To review');
    assertConsistent(t.key, t.slug, 'To review');
    expect(existsSync(fileAt('In progress', t.key, t.slug))).toBe(false);
    assertBijection();

    // set-status → Done
    await provider.setStatus(t.key, 'Done');
    assertConsistent(t.key, t.slug, 'Done');
    expect(existsSync(fileAt('To review', t.key, t.slug))).toBe(false);
    assertBijection();

    // set-status → Blocked
    await provider.setStatus(t.key, 'Blocked');
    assertConsistent(t.key, t.slug, 'Blocked');
    expect(existsSync(fileAt('Done', t.key, t.slug))).toBe(false);
    assertBijection();
  });

  it('setStatus(In progress) moves the file to in-progress/ and clears the pending/ copy', async () => {
    const t = await provider.create(draft());
    await provider.setStatus(t.key, 'In progress');
    expect(existsSync(fileAt('In progress', t.key, t.slug))).toBe(true);
    expect(existsSync(fileAt('Pending', t.key, t.slug))).toBe(false);
    assertConsistent(t.key, t.slug, 'In progress');
    assertBijection();
  });

  it('deletes a ticket: removes both the file and the status.yaml entry (no orphan)', async () => {
    const t = await provider.create(draft());
    await provider.setStatus(t.key, 'In progress');
    await provider.delete(t.key);

    expect(await provider.get(t.key)).toBeNull();
    const doc = readIndex();
    expect(doc.tickets[t.key]).toBeUndefined();
    // no file left in any status folder
    for (const status of TICKET_STATUSES) {
      expect(existsSync(fileAt(status, t.key, t.slug))).toBe(false);
    }
    assertBijection();
  });

  it('index-wins: a ticket whose frontmatter status is hand-desynced still reports the index column', async () => {
    const t = await provider.create(draft());
    await provider.setStatus(t.key, 'In progress');

    // hand-edit only the frontmatter status line to a stale value, keep the file in its indexed folder
    const path = fileAt('In progress', t.key, t.slug);
    const raw = readFileSync(path, 'utf-8');
    const staled = raw.replace(/^status: .*$/m, 'status: Done');
    expect(staled).not.toBe(raw);
    expect(frontmatterStatus(path)).toBe('In progress'); // sanity: unedited baseline
    writeFileSync(path, staled, 'utf-8');
    expect(frontmatterStatus(path)).toBe('Done'); // sanity: the file now lies

    // get() and list() must report the INDEX column, not the stale frontmatter
    const got = await provider.get(t.key);
    expect(got!.status).toBe('In progress');
    const ref = (await provider.list()).find((r) => r.key === t.key);
    expect(ref!.status).toBe('In progress');
  });

  it('amends editable fields and persists them (placement unchanged)', async () => {
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
    assertConsistent(t.key, t.slug, 'Pending');
    assertBijection();
  });
});
