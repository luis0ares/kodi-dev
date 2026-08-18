import { describe, expect, it } from 'vitest';
import { mdToHtml } from '../src/html.js';
import {
  backlogIterationName,
  listBranches,
  listTeamIterations,
  parseBacklogIterationName,
  parseBranchRefs,
  parseIterations,
} from '../src/providers/azure-discovery.js';
import {
  columnForStatus,
  createArgs,
  DEFAULT_COLUMNS,
  descriptionHtml,
  kanbanColumnField,
  leafIterationName,
  listWiql,
  moveFields,
  parseQueryOutput,
  parseSignedInUser,
  parseWorkItem,
  scheduledIterationName,
  stateForColumn,
  updateArgs,
} from '../src/providers/azure.js';
import { TicketSchema, type StoredTicket } from '../src/templates/ticket.js';
import { azFileArg } from '../src/tmpfile.js';

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

  it('sends the work-item description INLINE off Windows (unchanged behaviour)', () => {
    // descriptionHtml is genuinely multi-line (body + <pre> marker on its own line).
    const html = descriptionHtml(stored());
    expect(html).toContain('\n');
    const args = createArgs(
      { organization: 'https://dev.azure.com/acme', project: 'Proj' },
      'T',
      azFileArg(html, 'kodi-test-', 'linux'),
      'To Do',
    );
    // The real HTML rides on argv exactly as it always has — no @file indirection,
    // so the dry-run preview stays readable and re-runnable.
    expect(args[args.indexOf('--description') + 1]).toBe(html);
  });

  it('routes it through an @file ref on Windows (the .cmd shim truncates argv)', () => {
    // Inline, az's Windows `.cmd` shim would cut the value at its first newline —
    // losing the base64 marker AND the trailing `--output json`.
    const html = descriptionHtml(stored());
    const descriptionArg = azFileArg(html, 'kodi-test-', 'win32');
    const args = createArgs(
      { organization: 'https://dev.azure.com/acme', project: 'Proj' },
      'T',
      descriptionArg,
      'To Do',
    );
    const desc = args[args.indexOf('--description') + 1];
    expect(desc).toBe(descriptionArg);
    expect(desc.startsWith('@')).toBe(true);
    for (const a of args) expect(a).not.toContain('\n');
  });

  it('keeps the historical --fields update form off Windows, byte for byte', () => {
    const html = descriptionHtml(stored());
    // This is the shape kodi has always sent, and the Windows fix must not touch it.
    expect(updateArgs('7', html, 'New title', 'linux')).toEqual([
      'az',
      'boards',
      'work-item',
      'update',
      '--id',
      '7',
      '--fields',
      `System.Description=${html}`,
      '--fields',
      'System.Title=New title',
    ]);
    // …and an untitled patch still sends description only.
    expect(updateArgs('7', html, undefined, 'linux')).not.toContain('--title');
  });

  it('switches the update to --description @file / --title on Windows', () => {
    // `--fields System.Description=@file` would NOT expand: az triggers @file only
    // when the WHOLE argument value starts with `@`, so Windows must use the
    // dedicated flags to keep the body off argv.
    const args = updateArgs('7', descriptionHtml(stored()), 'New title', 'win32');
    expect(args.slice(0, 6)).toEqual(['az', 'boards', 'work-item', 'update', '--id', '7']);
    expect(args[args.indexOf('--description') + 1].startsWith('@')).toBe(true);
    expect(args[args.indexOf('--title') + 1]).toBe('New title');
    expect(args).not.toContain('--fields');
    for (const a of args) expect(a).not.toContain('\n');
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

  it('tolerates the empty string az prints for a zero-result query (no JSON crash)', () => {
    // az boards query outputs "" (not "[]") when nothing matches — `tickets list`
    // / `tree` on an empty board must yield no rows, not "Unexpected end of JSON input".
    expect(parseQueryOutput('')).toEqual([]);
    expect(parseQueryOutput('   \n')).toEqual([]);
    expect(parseQueryOutput('[{"id":7}]')).toEqual([{ id: 7 }]);
  });

  it('pins the configured project in the list WIQL (az boards query runs org-wide)', () => {
    const wiql = listWiql('KodiTest');
    // scopes to the one project AND keeps the Issue type filter + ordering
    expect(wiql).toContain("[System.WorkItemType] = 'Issue'");
    expect(wiql).toContain("[System.TeamProject] = 'KodiTest'");
    expect(wiql).toMatch(/ORDER BY \[System\.Id\]$/);
    // still hydrates the Description (carries the base64 marker) in one query
    expect(wiql).toContain('[System.Description]');
  });

  it('excludes the Done state SERVER-SIDE so finished tickets are never transferred', () => {
    // Descriptions are the payload — filtering after the fetch would still pull
    // (and buffer) every Done ticket, which is what broke listings on a real board.
    const wiql = listWiql('KodiTest', 'Done');
    expect(wiql).toContain("[System.State] <> 'Done'");
    expect(wiql).toContain("[System.WorkItemType] = 'Issue'");
    expect(wiql).toMatch(/ORDER BY \[System\.Id\]$/);
    // …and `--all` puts the whole board back (no state predicate at all).
    expect(listWiql('KodiTest')).not.toContain('<>');
  });

  it('escapes a quote in the excluded state (WIQL literal safety)', () => {
    expect(listWiql(undefined, "Won't do")).toContain("[System.State] <> 'Won''t do'");
  });

  it('omits the project filter when no project is configured', () => {
    expect(listWiql()).not.toContain('System.TeamProject');
  });

  it('escapes single quotes in the project name (WIQL literal safety)', () => {
    expect(listWiql("O'Brien's Proj")).toContain("[System.TeamProject] = 'O''Brien''s Proj'");
  });

  it('with no iteration param, no IterationPath filter clause is added (regression guard)', () => {
    // Locks in today's behavior — the live-caught `@project`/`@CurrentIteration`
    // macro bugs must never come back as a "helpful" default. IterationPath is
    // still SELECTed (parseWorkItem needs it) — just never filtered on.
    const wiql = listWiql('KodiTest', 'Done');
    expect(wiql).not.toMatch(/WHERE.*IterationPath/);
    expect(wiql).not.toContain('@project');
    expect(wiql).not.toContain('@CurrentIteration');
  });

  it('always selects System.IterationPath (parseWorkItem needs it)', () => {
    expect(listWiql()).toContain('[System.IterationPath]');
  });

  it('default filter (current + unscheduled): UNDER the current path OR the backlog name', () => {
    const wiql = listWiql('KodiTest', undefined, {
      path: 'KodiTest\\Sprint 1',
      unscheduledName: 'KodiTest',
    });
    expect(wiql).toContain(
      " AND ([System.IterationPath] UNDER 'KodiTest\\Sprint 1' OR [System.IterationPath] = 'KodiTest')",
    );
  });

  it('one named iteration: UNDER only, no unscheduled OR', () => {
    const wiql = listWiql('KodiTest', undefined, { path: 'KodiTest\\Sprint 2' });
    expect(wiql).toContain(" AND [System.IterationPath] UNDER 'KodiTest\\Sprint 2'");
    expect(wiql).not.toContain(' OR ');
  });

  it('escapes single quotes in the iteration path/unscheduled name', () => {
    const wiql = listWiql(undefined, undefined, {
      path: "O'Brien's Proj\\Sprint 1",
      unscheduledName: "O'Brien's Proj",
    });
    expect(wiql).toContain("UNDER 'O''Brien''s Proj\\Sprint 1'");
    expect(wiql).toContain("= 'O''Brien''s Proj'");
  });

  it('discovers the writable per-board Kanban column field (the WEF_… field)', () => {
    const fields = {
      'System.State': 'Doing',
      'System.BoardColumn': 'Doing', // read-only mirror — not this one
      'WEF_807161377A2D4EA4BE01F1B411161E5F_Kanban.Column': 'Doing',
      'WEF_807161377A2D4EA4BE01F1B411161E5F_Kanban.Column.Done': false,
    };
    expect(kanbanColumnField(fields)).toBe('WEF_807161377A2D4EA4BE01F1B411161E5F_Kanban.Column');
    // ".Column.Done" and the read-only mirror must not be mistaken for the field
    expect(kanbanColumnField({ 'System.BoardColumn': 'Doing' })).toBeUndefined();
    // a not-yet-placed card (no WEF field) yields undefined → move falls back to state-only
    expect(kanbanColumnField({ 'System.State': 'To Do' })).toBeUndefined();
  });

  it('builds the move fields: state, kanban column, and (when given) the assignee', () => {
    const cols = { todo: 'To Do', inProgress: 'Doing', toReview: 'Review', done: 'Done' };
    const map = { Doing: 'InProgressState' };
    expect(moveFields('In progress', cols, map)).toEqual(['System.State=InProgressState']);
    expect(moveFields('In progress', cols, map, 'WEF_x_Kanban.Column')).toEqual([
      'System.State=InProgressState',
      'WEF_x_Kanban.Column=Doing',
    ]);
    // `start` adds System.AssignedTo — a plain move never sends it (assignedTo omitted).
    expect(moveFields('In progress', cols, map, 'WEF_x_Kanban.Column', 'dev@acme.com')).toEqual([
      'System.State=InProgressState',
      'WEF_x_Kanban.Column=Doing',
      'System.AssignedTo=dev@acme.com',
    ]);
  });

  it('resolves the signed-in user for System.AssignedTo, preferring mail over UPN', () => {
    expect(parseSignedInUser(JSON.stringify({ mail: 'dev@acme.com' }))).toBe('dev@acme.com');
    // some accounts (guest/service) have no `mail` — fall back to the UPN.
    expect(
      parseSignedInUser(
        JSON.stringify({
          mail: null,
          userPrincipalName: 'dev_gmail.com#EXT#@acme.onmicrosoft.com',
        }),
      ),
    ).toBe('dev_gmail.com#EXT#@acme.onmicrosoft.com');
    expect(parseSignedInUser(JSON.stringify({}))).toBe('');
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

  it('surfaces the leaf iteration name from System.IterationPath', () => {
    const t = stored();
    const desc = descriptionHtml(t);
    const back = parseWorkItem(
      {
        'System.Description': desc,
        'System.State': 'To Do',
        'System.IterationPath': 'KodiTest\\Sprint 3',
      },
      7,
    );
    expect(back!.iteration).toBe('Sprint 3');
  });

  it('omits iteration for the bare project-root path (unscheduled)', () => {
    const t = stored();
    const desc = descriptionHtml(t);
    const back = parseWorkItem(
      {
        'System.Description': desc,
        'System.State': 'To Do',
        'System.IterationPath': 'KodiTest',
      },
      7,
    );
    expect(back!.iteration).toBeUndefined();
  });

  it('omits iteration when the field is absent entirely', () => {
    const t = stored();
    const back = parseWorkItem(
      { 'System.Description': descriptionHtml(t), 'System.State': 'To Do' },
      7,
    );
    expect(back!.iteration).toBeUndefined();
  });
});

describe('azure provider — iteration name helpers', () => {
  it('leafIterationName takes the last backslash-separated segment', () => {
    expect(leafIterationName('Proj\\Release 1\\Sprint 3')).toBe('Sprint 3');
    expect(leafIterationName('Proj\\Sprint 3')).toBe('Sprint 3');
    expect(leafIterationName('Proj')).toBe('Proj'); // no backslash → itself
  });

  it('scheduledIterationName is undefined for the bare root path, the leaf name otherwise', () => {
    expect(scheduledIterationName('Proj\\Sprint 3')).toBe('Sprint 3');
    expect(scheduledIterationName('Proj')).toBeUndefined();
    expect(scheduledIterationName(undefined)).toBeUndefined();
    expect(scheduledIterationName('')).toBeUndefined();
  });
});

describe('azure discovery — iterations', () => {
  it('parses az boards iteration team list output (live-verified shape)', () => {
    const json = JSON.stringify([
      {
        attributes: { finishDate: null, startDate: null, timeFrame: 'current' },
        id: 'abc-123',
        name: 'Sprint 1',
        path: 'KodiTest\\Sprint 1',
        url: 'https://…',
      },
    ]);
    const its = parseIterations(json);
    expect(its).toEqual([
      {
        id: 'abc-123',
        name: 'Sprint 1',
        path: 'KodiTest\\Sprint 1',
        startDate: undefined,
        finishDate: undefined,
        timeFrame: 'current',
      },
    ]);
  });

  it('maps JSON null start/finish dates to undefined, not the literal null', () => {
    const its = parseIterations(
      JSON.stringify([{ id: '1', name: 'S1', path: 'P\\S1', attributes: { startDate: null } }]),
    );
    expect(its[0].startDate).toBeUndefined();
  });

  it('also accepts the { value: [...] } wrapper shape (mirrors parseProjects/parseTeams)', () => {
    const its = parseIterations(
      JSON.stringify({ value: [{ id: '1', name: 'S1', path: 'P\\S1', attributes: {} }] }),
    );
    expect(its).toHaveLength(1);
  });

  it('filters out entries missing id/name/path', () => {
    const its = parseIterations(JSON.stringify([{ id: '1', name: 'S1' /* no path */ }]));
    expect(its).toEqual([]);
  });

  it('builds the team-iteration-list command, with --timeframe only when given', () => {
    const args: string[][] = [];
    const run = (a: string[]) => {
      args.push(a);
      return '[]';
    };
    listTeamIterations('https://dev.azure.com/acme', 'Proj', 'Proj Team', run);
    expect(args[0]).toEqual([
      'az',
      'boards',
      'iteration',
      'team',
      'list',
      '--org',
      'https://dev.azure.com/acme',
      '--project',
      'Proj',
      '--team',
      'Proj Team',
      '--output',
      'json',
    ]);

    listTeamIterations('https://dev.azure.com/acme', 'Proj', 'Proj Team', run, 'Current');
    expect(args[1]).toContain('--timeframe');
    expect(args[1]).toContain('Current');
  });

  it('parses the backlog/root iteration name from show-backlog-iteration output', () => {
    expect(
      parseBacklogIterationName(JSON.stringify({ backlogIteration: { name: 'KodiTest' } })),
    ).toBe('KodiTest');
    expect(parseBacklogIterationName(JSON.stringify({}))).toBeUndefined();
  });

  it('builds the show-backlog-iteration command', () => {
    const args: string[][] = [];
    const run = (a: string[]) => {
      args.push(a);
      return JSON.stringify({ backlogIteration: { name: 'KodiTest' } });
    };
    const name = backlogIterationName('https://dev.azure.com/acme', 'Proj', 'Proj Team', run);
    expect(name).toBe('KodiTest');
    expect(args[0]).toEqual([
      'az',
      'boards',
      'iteration',
      'team',
      'show-backlog-iteration',
      '--org',
      'https://dev.azure.com/acme',
      '--project',
      'Proj',
      '--team',
      'Proj Team',
      '--output',
      'json',
    ]);
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
