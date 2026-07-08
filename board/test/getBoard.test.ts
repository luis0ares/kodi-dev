// Server-action seam (`app/actions/board.ts`): drive the read path end-to-end
// through `getBoard()`, which reads `process.env.KODI_TICKETS_DIR`. Covers the
// happy path / fixed column order, index-wins placement, and the empty-board
// fallbacks (SR-7). Security/edge cases are exercised against the pure libs in
// the sibling test files.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBoard } from '@/app/actions/board';
import { TICKET_STATUSES, type BoardModel, type TicketStatus } from '@/lib/tickets/types';
import { cleanup, makeTicketsRoot, statusYaml, ticketEntry, writeStatusYaml, writeTicketFile } from './fixtures';

let root: string | undefined;
const ORIGINAL = process.env.KODI_TICKETS_DIR;

function setEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.KODI_TICKETS_DIR;
  else process.env.KODI_TICKETS_DIR = value;
}

function keysIn(model: BoardModel, status: TicketStatus): string[] {
  const col = model.columns.find((c) => c.status === status);
  return (col?.tickets ?? []).map((t) => t.key);
}

afterEach(() => {
  if (root) cleanup(root);
  root = undefined;
  setEnv(ORIGINAL);
});

describe('getBoard() — happy path & fixed column order (scenario 1)', () => {
  beforeEach(() => {
    root = makeTicketsRoot();
    writeStatusYaml(
      root,
      statusYaml(
        ticketEntry('KODI-001', 'Pending'),
        ticketEntry('KODI-002', 'In progress'),
        ticketEntry('KODI-003', 'To review'),
        ticketEntry('KODI-005', 'Pending'),
      ),
    );
    writeTicketFile(root, { key: 'KODI-001', column: 'Pending', title: 'First', summary: 'one' });
    writeTicketFile(root, { key: 'KODI-002', column: 'In progress', title: 'Second', summary: 'two' });
    writeTicketFile(root, { key: 'KODI-003', column: 'To review', title: 'Third', summary: 'three' });
    writeTicketFile(root, { key: 'KODI-005', column: 'Pending', title: 'Fifth', summary: 'five' });
    setEnv(root);
  });

  it('returns exactly the four statuses in fixed enum order', async () => {
    const model = await getBoard();
    expect(model.columns.map((c) => c.status)).toEqual([...TICKET_STATUSES]);
  });

  it('places each card in its indexed column', async () => {
    const model = await getBoard();
    expect(keysIn(model, 'Pending').sort()).toEqual(['KODI-001', 'KODI-005']);
    expect(keysIn(model, 'In progress')).toEqual(['KODI-002']);
    expect(keysIn(model, 'To review')).toEqual(['KODI-003']);
  });

  it('represents an unindexed column as an empty array, not a missing column', async () => {
    const model = await getBoard();
    const done = model.columns.find((c) => c.status === 'Done');
    expect(done).toBeDefined();
    expect(done?.tickets).toEqual([]);
  });

  it('exposes each card status equal to its column and reads frontmatter content', async () => {
    const model = await getBoard();
    const card = model.columns.find((c) => c.status === 'In progress')?.tickets[0];
    expect(card?.status).toBe('In progress');
    expect(card?.title).toBe('Second');
    expect(card?.summary).toBe('two');
  });
});

describe('getBoard() — index-wins placement (scenario 2, CRITICAL)', () => {
  beforeEach(() => {
    root = makeTicketsRoot();
    // Index says Done; the file's frontmatter status says Pending. The file
    // MUST physically live under done/ (I2) with a KODI-010 name (I4).
    writeStatusYaml(root, statusYaml(ticketEntry('KODI-010', 'Done')));
    writeTicketFile(root, {
      key: 'KODI-010',
      column: 'Done', // controls the on-disk folder/filename
      status: 'Pending', // stale frontmatter that must be ignored
      title: 'Disagreeing card',
      summary: 'index and frontmatter disagree',
    });
    setEnv(root);
  });

  it('places the card in the INDEX column (Done), never the frontmatter one (Pending)', async () => {
    const model = await getBoard();
    expect(keysIn(model, 'Done')).toEqual(['KODI-010']);
    expect(keysIn(model, 'Pending')).toEqual([]);
  });

  it('exposes card.status equal to the index column, not the frontmatter status', async () => {
    const model = await getBoard();
    const card = model.columns.find((c) => c.status === 'Done')?.tickets[0];
    expect(card?.status).toBe('Done');
  });
});

describe('getBoard() — empty-board fallbacks (scenario 6, SR-7)', () => {
  function expectFiveEmptyColumns(model: BoardModel): void {
    expect(model.columns.map((c) => c.status)).toEqual([...TICKET_STATUSES]);
    for (const col of model.columns) expect(col.tickets).toEqual([]);
  }

  it('(a) unset env → five empty columns, no throw', async () => {
    setEnv(undefined);
    expectFiveEmptyColumns(await getBoard());
  });

  it('(a) empty-string env → five empty columns', async () => {
    setEnv('');
    expectFiveEmptyColumns(await getBoard());
  });

  it('(a) whitespace-only env → five empty columns', async () => {
    setEnv('   \t  ');
    expectFiveEmptyColumns(await getBoard());
  });

  it('(b) dir exists but no status.yaml → five empty columns', async () => {
    root = makeTicketsRoot();
    setEnv(root);
    expectFiveEmptyColumns(await getBoard());
  });

  it('(c) status.yaml present but tickets is empty → five empty columns', async () => {
    root = makeTicketsRoot();
    writeStatusYaml(root, 'version: 1\ncolumns: [Pending, In progress, To review, Done, Blocked]\ntickets: {}\n');
    setEnv(root);
    expectFiveEmptyColumns(await getBoard());
  });
});
