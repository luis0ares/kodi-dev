import { beforeEach, describe, expect, it, vi } from 'vitest';
import spawn from 'cross-spawn';
import { AzureTicketProvider, descriptionHtml } from '../src/providers/azure.js';
import { TicketSchema, type StoredTicket } from '../src/templates/ticket.js';

// The provider shells out through src/exec.ts, which spawns via cross-spawn — mock
// that and the whole `az` conversation becomes assertable argv.
vi.mock('cross-spawn', () => ({ default: { sync: vi.fn() } }));
const sync = vi.mocked(spawn.sync);

const KANBAN = 'WEF_807161377A2D4EA4BE01F1B411161E5F_Kanban.Column';
const COLUMNS = { todo: 'To Do', inProgress: 'Doing', toReview: 'To Review', done: 'Done' };
// The playground board: "To Review" is a SECOND column sharing the "Doing" state.
const COLUMN_STATES = { 'To Do': 'To Do', Doing: 'Doing', 'To Review': 'Doing', Done: 'Done' };

function stored(): StoredTicket {
  const t = TicketSchema.parse({
    title: 'Track P TP-02 — Availability, slot computation and DST',
    summary: 'Compute availability slots.',
    acceptanceCriteria: ['slots respect DST'],
  });
  return { ...t, key: '1367', slug: t.slug ?? 'availability' };
}

/** A work item sitting in the To Do column, already placed on the board. */
function workItemJson() {
  return JSON.stringify({
    id: 1367,
    fields: {
      'System.State': 'To Do',
      'System.BoardColumn': 'To Do',
      [KANBAN]: 'To Do',
      'System.Description': descriptionHtml(stored()),
    },
  });
}

function ok(stdout: string) {
  return { status: 0, stdout, stderr: '', error: undefined } as never;
}

function provider() {
  return new AzureTicketProvider({
    organization: 'https://dev.azure.com/dynaccurate',
    project: 'KodiTest',
    dryRun: false,
    columns: COLUMNS,
    columnStates: COLUMN_STATES,
  });
}

/** The argv of the single `az boards work-item update` call that was spawned. */
function updateArgv(): string[] {
  const calls = sync.mock.calls.filter((c) => (c[1] as string[])?.[1] === 'work-item');
  const update = calls.find((c) => (c[1] as string[])[2] === 'update');
  expect(update, 'no `az boards work-item update` was spawned').toBeDefined();
  return [update![0] as string, ...(update![1] as string[])];
}

describe('azure `tickets start` — the board move actually reaches az', () => {
  beforeEach(() => {
    sync.mockReset();
    sync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'ad') return ok(JSON.stringify({ mail: 'luis@dynaccurate.com' }));
      if (a[2] === 'show') return ok(workItemJson());
      return ok('{}');
    });
  });

  it('sets state, the Kanban column AND the assignee in one --fields (start)', async () => {
    await provider().start('1367', { branch: 'slice/kodi-1367', startedBy: 'luis' });
    const argv = updateArgv();

    // The regression: az's --fields is a single nargs='*' arg, so a repeated flag kept
    // only the LAST pair — the assignee — and the card never left the To Do column.
    expect(argv.filter((a) => a === '--fields')).toHaveLength(1);
    expect(argv).toContain('System.State=Doing'); // columns.inProgress → its state
    expect(argv).toContain(`${KANBAN}=Doing`); // …and the configured column itself
    expect(argv).toContain('System.AssignedTo=luis@dynaccurate.com');
  });

  it('moves to the exact configured column when two columns share a state (hand-off)', async () => {
    await provider().setStatus('1367', 'To review');
    const argv = updateArgv();

    expect(argv.filter((a) => a === '--fields')).toHaveLength(1);
    // "To Review" maps to the shared "Doing" state — only the column field can tell
    // the two apart, and the state write must survive alongside it.
    expect(argv).toContain('System.State=Doing');
    expect(argv).toContain(`${KANBAN}=To Review`);
    expect(argv).not.toContain('--fields=');
  });

  it('falls back to a state-only move for a card not yet placed on a board', async () => {
    sync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'ad') return ok(JSON.stringify({ mail: 'luis@dynaccurate.com' }));
      if (a[2] === 'show')
        return ok(
          JSON.stringify({
            id: 1367,
            fields: { 'System.State': 'To Do', 'System.Description': descriptionHtml(stored()) },
          }),
        );
      return ok('{}');
    });

    await provider().setStatus('1367', 'In progress');
    const argv = updateArgv();

    expect(argv.filter((a) => a === '--fields')).toHaveLength(1);
    expect(argv).toContain('System.State=Doing');
    expect(argv.some((a) => a.startsWith('WEF_'))).toBe(false);
  });
});
