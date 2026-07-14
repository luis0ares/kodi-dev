import { describe, expect, it } from 'vitest';
import { mdToHtml } from '../src/html.js';
import { listBranches, parseBranchRefs } from '../src/providers/azure-discovery.js';
import {
  columnForStatus,
  createArgs,
  DEFAULT_COLUMNS,
  descriptionHtml,
  parseWorkItem,
  stateForColumn,
} from '../src/providers/azure.js';
import { TicketSchema, type StoredTicket } from '../src/templates/ticket.js';

function stored(over: Record<string, unknown> = {}): StoredTicket {
  const t = TicketSchema.parse({
    title: 'Add dataset import',
    summary: 'Import a dataset from CSV.',
    acceptanceCriteria: ['CSV upload works'],
    dependencies: ['42'],
    ...over,
  });
  return { ...t, key: '7', slug: t.slug ?? 'add-dataset-import' };
}

describe('markdown → html', () => {
  it('converts headings, lists, and bold; passes the kodi marker through', () => {
    const html = mdToHtml('# Title\n\n- a\n- b\n\n**bold** text\n<!-- kodi:ticket {} -->');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<!-- kodi:ticket {} -->');
  });
});

describe('azure provider — command construction', () => {
  it('builds a create command (issue work-item) with org and project', () => {
    const args = createArgs(
      { organization: 'https://dev.azure.com/acme', project: 'Proj' },
      'T',
      '<p>x</p>',
      'To Do',
    );
    expect(args.slice(0, 6)).toEqual(['az', 'boards', 'work-item', 'create', '--title', 'T']);
    expect(args).toContain('--type');
    expect(args).toContain('Issue');
    expect(args).toContain('System.State=To Do');
    expect(args).toContain('--organization');
    expect(args).toContain('https://dev.azure.com/acme');
    expect(args).toContain('Proj');
  });

  it('maps statuses to board columns via the column map', () => {
    const cols = { todo: 'To Do', inProgress: 'Doing', toReview: 'Review', done: 'Done' };
    expect(columnForStatus('Pending', cols)).toBe('To Do');
    expect(columnForStatus('In progress', cols)).toBe('Doing');
    expect(columnForStatus('To review', cols)).toBe('Review');
    expect(DEFAULT_COLUMNS.todo).toBe('To Do');
  });

  it('resolves a board column to its System.State (identity when unmapped)', () => {
    // Two DISTINCT columns can share one state — this is why moves set the column
    // AND a consistent state.
    const map = { 'In Progress': 'Doing', 'To Review': 'Doing', 'To Do': 'To Do' };
    expect(stateForColumn('To Review', map)).toBe('Doing');
    expect(stateForColumn('In Progress', map)).toBe('Doing');
    // A column with no recorded mapping (or no map at all) falls back to itself.
    expect(stateForColumn('Done', map)).toBe('Done');
    expect(stateForColumn('Whatever')).toBe('Whatever');
  });
});

describe('azure provider — description round-trip', () => {
  it('embeds and recovers the canonical ticket via the marker', () => {
    const t = stored();
    const desc = descriptionHtml(t);
    const back = parseWorkItem({ 'System.Description': desc, 'System.State': 'In Progress' }, 7);
    expect(back).not.toBeNull();
    expect(back!.key).toBe('7');
    expect(back!.title).toBe('Add dataset import');
    expect(back!.dependencies).toEqual(['42']);
    expect(back!.status).toBe('In progress'); // derived from the board column
  });

  it('prefers System.BoardColumn over System.State to distinguish shared-state columns', () => {
    const t = stored();
    const desc = descriptionHtml(t);
    const cols = { todo: 'To Do', inProgress: 'In Progress', toReview: 'To Review', done: 'Done' };
    // BoardColumn "To Review" and state "Doing" both point at the same state, but
    // only the column tells us the real bucket → "To review", not "In progress".
    const back = parseWorkItem(
      { 'System.Description': desc, 'System.State': 'Doing', 'System.BoardColumn': 'To Review' },
      7,
      cols,
    );
    expect(back!.status).toBe('To review');
  });

  it('returns null when there is no marker', () => {
    expect(parseWorkItem({ 'System.Description': '<p>plain</p>' }, 1)).toBeNull();
  });
});

describe('azure discovery — branch parsing', () => {
  it('strips refs/heads/ and lists branches via the runner', () => {
    expect(
      parseBranchRefs(
        JSON.stringify({ value: [{ name: 'refs/heads/main' }, { name: 'refs/heads/feat/x' }] }),
      ),
    ).toEqual(['main', 'feat/x']);

    const args: string[][] = [];
    const branches = listBranches('https://dev.azure.com/acme', 'Proj', 'MyRepo', (a) => {
      args.push(a);
      return JSON.stringify({ value: [{ name: 'refs/heads/main' }] });
    });
    expect(branches).toEqual(['main']);
    expect(args[0]).toEqual(
      expect.arrayContaining(['az', 'repos', 'ref', 'list', '--filter', 'heads']),
    );
  });
});
