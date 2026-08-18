import { describe, expect, it } from 'vitest';
import {
  assignSelfArgs,
  columnForStatus,
  createIssueArgs,
  DEFAULT_COLUMNS,
  itemAddArgs,
  itemEditArgs,
  itemEditIterationArgs,
  itemsToHydrate,
  iterationValueFromRaw,
  parseItems,
  parseMarker,
  serializeBody,
  statusFromColumn,
} from '../src/providers/github.js';
import {
  currentIteration,
  iterationByTitle,
  listBranches,
  optionIdFor,
  parseBranchLines,
  parseIterationConfiguration,
  parseIterationField,
  parseProjects,
  parseRepos,
  parseStatusField,
  type IterationCatalog,
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

  it('builds the self-assign args with @me (no login lookup needed)', () => {
    expect(assignSelfArgs('7', 'acme/app')).toEqual([
      'gh',
      'issue',
      'edit',
      '7',
      '--add-assignee',
      '@me',
      '--repo',
      'acme/app',
    ]);
    // no repo configured → the flag is simply omitted, same as elsewhere in the file.
    expect(assignSelfArgs('7')).not.toContain('--repo');
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

  it('skips Done items before hydration (issue #8 would cost a `gh issue view`)', () => {
    const items = parseItems(json);
    // #8 sits in Done AND arrived without a body — exactly the item whose marker
    // would need its own API call. A not-done listing must never reach for it.
    expect(itemsToHydrate(items, DEFAULT_COLUMNS).map((i) => i.issueNumber)).toEqual([7]);
    expect(itemsToHydrate(items, DEFAULT_COLUMNS, true).map((i) => i.issueNumber)).toEqual([7, 8]);
  });

  it('keeps an item with no Status column — only hydration can classify it', () => {
    const items = parseItems(
      JSON.stringify({ items: [{ id: 'PVTI_x', content: { type: 'Issue', number: 11 } }] }),
    );
    expect(itemsToHydrate(items, DEFAULT_COLUMNS).map((i) => i.issueNumber)).toEqual([11]);
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

  it('parses newline-delimited branch names and lists them via the runner', () => {
    expect(parseBranchLines('main\n release \n\nfeat/x\n')).toEqual(['main', 'release', 'feat/x']);
    const args: string[][] = [];
    const branches = listBranches('acme/app', (a) => {
      args.push(a);
      return 'main\nrelease\n';
    });
    expect(branches).toEqual(['main', 'release']);
    expect(args[0]).toContain('repos/acme/app/branches');
  });

  it('parses the repo list into owner/repo names', () => {
    expect(
      parseRepos(JSON.stringify([{ nameWithOwner: 'acme/app' }, { nameWithOwner: 'acme/api' }])),
    ).toEqual(['acme/app', 'acme/api']);
  });
});

describe('github discovery — iteration field', () => {
  it('finds the ITERATION-type field among field-list output (live-verified shape: no inline catalog)', () => {
    const field = parseIterationField(
      JSON.stringify({
        fields: [
          { id: 'PVTF_title', name: 'Title', type: 'ProjectV2Field' },
          { id: 'PVTIF_x', name: 'Iteration', type: 'ProjectV2IterationField' },
        ],
      }),
    );
    expect(field).toEqual({ id: 'PVTIF_x', name: 'Iteration' });
  });

  it('returns null when the project has no Iteration field (a Status-only project)', () => {
    expect(
      parseIterationField(
        JSON.stringify({
          fields: [{ id: 'PVTSSF_status', name: 'Status', type: 'ProjectV2SingleSelectField' }],
        }),
      ),
    ).toBeNull();
  });

  it('parses the gh api graphql iteration-configuration response (live-verified shape)', () => {
    const catalog = parseIterationConfiguration(
      JSON.stringify({
        data: {
          node: {
            configuration: {
              iterations: [
                { id: 'it_2', title: 'Sprint 2', startDate: '2026-01-13', duration: 14 },
              ],
              completedIterations: [
                { id: 'it_1', title: 'Sprint 1', startDate: '2025-12-30', duration: 14 },
              ],
            },
          },
        },
      }),
    );
    expect(catalog).toEqual({
      iterations: [{ id: 'it_2', title: 'Sprint 2', startDate: '2026-01-13', duration: 14 }],
      completedIterations: [
        { id: 'it_1', title: 'Sprint 1', startDate: '2025-12-30', duration: 14 },
      ],
    });
  });

  const catalog: IterationCatalog = {
    iterations: [{ id: 'it_2', title: 'Sprint 2', startDate: '2026-01-13', duration: 14 }],
    completedIterations: [{ id: 'it_1', title: 'Sprint 1', startDate: '2025-12-30', duration: 14 }],
  };

  it('currentIteration: a date inside [start, start+duration) matches', () => {
    const inside = new Date('2026-01-20T00:00:00Z').getTime();
    expect(currentIteration(catalog, () => inside)?.title).toBe('Sprint 2');
  });

  it('currentIteration: the boundary at start+duration does NOT match (exclusive end)', () => {
    const boundary = new Date('2026-01-27T00:00:00Z').getTime(); // 2026-01-13 + 14 days
    expect(currentIteration(catalog, () => boundary)).toBeUndefined();
  });

  it('currentIteration: no iteration covers the date → undefined', () => {
    const farFuture = new Date('2030-01-01T00:00:00Z').getTime();
    expect(currentIteration(catalog, () => farFuture)).toBeUndefined();
  });

  it('iterationByTitle: case-insensitive, searches both current/future and completed', () => {
    expect(iterationByTitle(catalog, 'sprint 2')?.id).toBe('it_2');
    expect(iterationByTitle(catalog, 'SPRINT 1')?.id).toBe('it_1'); // completed, still found
    expect(iterationByTitle(catalog, 'Sprint 99')).toBeUndefined();
  });
});

describe('github provider — per-item iteration value', () => {
  it('reads the value keyed by the field name, gh-camelCased (first char only, NOT full lowercase)', () => {
    const raw = {
      iteration: { title: 'Sprint 3', startDate: '2026-01-27', duration: 14, iterationId: 'it_3' },
    };
    expect(iterationValueFromRaw(raw, 'Iteration')).toEqual({
      title: 'Sprint 3',
      startDate: '2026-01-27',
      duration: 14,
      iterationId: 'it_3',
    });
  });

  it('regression: a multi-capital field name only lowercases its FIRST character', () => {
    // gh's camelCase("StoryPoints") -> "storyPoints", NOT "storypoints" — a naive
    // .toLowerCase() key would read undefined here even though the value exists.
    const raw = {
      storyPoints: {
        title: 'Sprint 4',
        startDate: '2026-02-10',
        duration: 14,
        iterationId: 'it_4',
      },
    };
    expect(iterationValueFromRaw(raw, 'StoryPoints')?.title).toBe('Sprint 4');
  });

  it('returns undefined when the item has no value for that field (key absent)', () => {
    expect(iterationValueFromRaw({}, 'Iteration')).toBeUndefined();
    expect(iterationValueFromRaw(undefined, 'Iteration')).toBeUndefined();
  });

  it('builds the item-edit args with --iteration-id', () => {
    expect(itemEditIterationArgs('PVT_1', 'PVTI_2', 'PVTIF_3', 'it_4')).toEqual([
      'gh',
      'project',
      'item-edit',
      '--id',
      'PVTI_2',
      '--project-id',
      'PVT_1',
      '--field-id',
      'PVTIF_3',
      '--iteration-id',
      'it_4',
    ]);
  });

  it('parseItems stashes the raw per-item object, round-tripping the original', () => {
    const rawItem = {
      id: 'PVTI_a',
      status: 'Todo',
      iteration: { title: 'Sprint 3' },
      content: { type: 'Issue', number: 7, body: '<!-- kodi:ticket {} -->' },
    };
    const items = parseItems(JSON.stringify({ items: [rawItem] }));
    expect(items[0].raw).toEqual(rawItem);
  });
});
