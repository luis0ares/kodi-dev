import { describe, expect, it } from 'vitest';
import {
  columnForStatus,
  createIssueArgs,
  DEFAULT_COLUMNS,
  itemAddArgs,
  itemEditArgs,
  parseItems,
  parseMarker,
  serializeBody,
  statusFromColumn,
} from '../src/providers/github.js';
import {
  optionIdFor,
  parseProjects,
  parseRepos,
  parseStatusField,
} from '../src/providers/github-discovery.js';
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

const COLS = { todo: 'Todo', inProgress: 'In Progress', toReview: 'In Review', done: 'Done' };

describe('github provider — status ↔ column mapping', () => {
  it('maps statuses to columns (Pending lands in todo)', () => {
    expect(columnForStatus('Pending', COLS)).toBe('Todo');
    expect(columnForStatus('In progress', COLS)).toBe('In Progress');
    expect(columnForStatus('To review', COLS)).toBe('In Review');
    expect(columnForStatus('Done', COLS)).toBe('Done');
  });

  it('inverts a column back to a status', () => {
    expect(statusFromColumn('Todo', COLS)).toBe('Pending');
    expect(statusFromColumn('In Progress', COLS)).toBe('In progress');
    expect(statusFromColumn('Done', COLS)).toBe('Done');
    expect(statusFromColumn('Nope', COLS)).toBeUndefined();
  });

  it('degrades gracefully when To Review collapses onto In Progress (first match wins)', () => {
    const collapsed = {
      todo: 'Todo',
      inProgress: 'In Progress',
      toReview: 'In Progress',
      done: 'Done',
    };
    // Both map to the same column; reverse resolution picks In progress (checked first).
    expect(statusFromColumn('In Progress', collapsed)).toBe('In progress');
    expect(columnForStatus('To review', collapsed)).toBe('In Progress');
  });

  it('exposes GitHub-flavored defaults', () => {
    expect(DEFAULT_COLUMNS.todo).toBe('Todo');
    expect(DEFAULT_COLUMNS.toReview).toBe('In Progress');
  });
});

describe('github provider — issue body round-trip', () => {
  it('embeds and recovers the canonical ticket via the marker (key stripped)', () => {
    const t = stored();
    const body = serializeBody(t);
    expect(body).toContain('<!-- kodi:ticket ');
    const back = parseMarker(body);
    expect(back?.title).toBe(t.title);
    expect(back?.dependencies).toEqual(['42']);
    expect(back?.key).toBeUndefined(); // key is assigned by github, not stored in the marker
  });

  it('returns null for an unmarked body', () => {
    expect(parseMarker('just a plain issue')).toBeNull();
    expect(parseMarker(null)).toBeNull();
  });
});

describe('github provider — command construction', () => {
  it('builds the issue-create args with a body file and repo', () => {
    const args = createIssueArgs('acme/app', 'T', '/tmp/body.md');
    expect(args).toEqual([
      'gh',
      'issue',
      'create',
      '--title',
      'T',
      '--body-file',
      '/tmp/body.md',
      '--repo',
      'acme/app',
    ]);
  });

  it('builds the item-add args (json for the item id)', () => {
    const args = itemAddArgs('acme', 5, 'https://github.com/acme/app/issues/7');
    expect(args).toEqual([
      'gh',
      'project',
      'item-add',
      '5',
      '--owner',
      'acme',
      '--url',
      'https://github.com/acme/app/issues/7',
      '--format',
      'json',
    ]);
  });

  it('builds the item-edit args to move a card', () => {
    const args = itemEditArgs('PVT_1', 'PVTI_2', 'PVTSSF_3', 'opt_4');
    expect(args).toEqual([
      'gh',
      'project',
      'item-edit',
      '--id',
      'PVTI_2',
      '--project-id',
      'PVT_1',
      '--field-id',
      'PVTSSF_3',
      '--single-select-option-id',
      'opt_4',
    ]);
  });
});

describe('github provider — item-list parsing', () => {
  const json = JSON.stringify({
    items: [
      {
        id: 'PVTI_a',
        status: 'Todo',
        content: { type: 'Issue', number: 7, body: '<!-- kodi:ticket {} -->' },
      },
      { id: 'PVTI_b', status: 'Done', content: { type: 'Issue', number: 8 } }, // body absent
      { id: 'PVTI_c', status: 'Todo', content: { type: 'PullRequest', number: 9 } }, // not an issue
      { id: 'PVTI_d', content: { type: 'DraftIssue', title: 'draft' } }, // no number
    ],
  });

  it('keeps only issue items and captures status/body (body absent → undefined)', () => {
    const items = parseItems(json);
    expect(items.map((i) => i.issueNumber)).toEqual([7, 8]);
    expect(items[0]).toMatchObject({
      itemId: 'PVTI_a',
      statusName: 'Todo',
      body: '<!-- kodi:ticket {} -->',
    });
    expect(items[1].body).toBeUndefined();
  });
});

describe('github discovery — parsing', () => {
  it('parses the project list', () => {
    const projects = parseProjects(
      JSON.stringify({ projects: [{ number: 5, title: 'Roadmap', id: 'PVT_x' }] }),
    );
    expect(projects).toEqual([{ number: 5, title: 'Roadmap', id: 'PVT_x' }]);
  });

  it('extracts the single-select Status field and resolves option ids', () => {
    const field = parseStatusField(
      JSON.stringify({
        fields: [
          { id: 'PVTF_title', name: 'Title', type: 'text' },
          {
            id: 'PVTSSF_status',
            name: 'Status',
            options: [
              { id: 'o1', name: 'Todo' },
              { id: 'o2', name: 'Done' },
            ],
          },
        ],
      }),
    );
    expect(field?.id).toBe('PVTSSF_status');
    expect(optionIdFor(field!, 'todo')).toBe('o1'); // case-insensitive
    expect(optionIdFor(field!, 'Done')).toBe('o2');
    expect(optionIdFor(field!, 'Nope')).toBeUndefined();
  });

  it('returns null when there is no Status field', () => {
    expect(
      parseStatusField(JSON.stringify({ fields: [{ id: 'x', name: 'Title', type: 'text' }] })),
    ).toBeNull();
  });

  it('parses the repo list into owner/repo names', () => {
    expect(
      parseRepos(JSON.stringify([{ nameWithOwner: 'acme/app' }, { nameWithOwner: 'acme/api' }])),
    ).toEqual(['acme/app', 'acme/api']);
  });
});
