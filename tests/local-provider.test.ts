import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalTicketProvider } from '../src/providers/local.js';
import { TicketSchema } from '../src/templates/ticket.js';

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

describe('local ticket provider', () => {
  it('assigns sequential keys', async () => {
    const a = await provider.create(draft());
    const b = await provider.create(draft({ title: 'Second ticket' }));
    expect(a.key).toBe('KODI-001');
    expect(b.key).toBe('KODI-002');
    expect(await provider.nextId()).toBe('KODI-003');
  });

  it('round-trips a ticket through disk', async () => {
    const created = await provider.create(draft({ dependencies: ['KODI-999'] }));
    const got = await provider.get(created.key);
    expect(got).not.toBeNull();
    expect(got!.title).toBe('Add dataset import');
    expect(got!.dependencies).toEqual(['KODI-999']);
    // file exists under backlog with the rendered body
    const file = join(dir, 'docs/tickets/backlog', `${created.key}-${created.slug}.md`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toContain('## Acceptance criteria');
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

  it('moves a ticket to done/ when status is Done', async () => {
    const t = await provider.create(draft());
    await provider.setStatus(t.key, 'Done');
    expect(existsSync(join(dir, 'docs/tickets/backlog', `${t.key}-${t.slug}.md`))).toBe(false);
    expect(existsSync(join(dir, 'docs/tickets/done', `${t.key}-${t.slug}.md`))).toBe(true);
  });

  it('deletes a ticket', async () => {
    const t = await provider.create(draft());
    await provider.delete(t.key);
    expect(await provider.get(t.key)).toBeNull();
  });

  it('regenerates the index on write', async () => {
    await provider.create(draft());
    const index = readFileSync(join(dir, 'docs/tickets/tickets.md'), 'utf-8');
    expect(index).toContain('| KODI-001 |');
  });
});
