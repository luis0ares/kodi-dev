import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureBoard,
  installHarness,
  mergePermissions,
  mergeSessionStartHook,
  PERMISSION_ALLOW,
  PERMISSION_DENY,
  writeState,
} from '../src/commands/init.js';
import type { Prompter } from '../src/prompt.js';
import { normalizeOrgUrl, type IssueState, type Runner } from '../src/providers/azure-discovery.js';

const REPO_ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));

/** A scripted prompter that returns queued answers in order. */
function scripted(answers: { select?: string[]; input?: string[]; confirm?: boolean[] }): Prompter {
  const s = [...(answers.select ?? [])];
  const i = [...(answers.input ?? [])];
  const c = [...(answers.confirm ?? [])];
  return {
    async select() {
      return s.shift()!;
    },
    async input(_m, def) {
      return i.length ? i.shift()! : (def ?? '');
    },
    async confirm(_m, def) {
      return c.length ? c.shift()! : (def ?? true);
    },
    close() {},
  };
}

const BASIC_STATES: IssueState[] = [
  { name: 'To Do', category: 'Proposed' },
  { name: 'Doing', category: 'InProgress' },
  { name: 'Done', category: 'Completed' },
];

/** Fake `az`: project list, project show (process), and Issue-type states (invoke). */
function fakeAz(template = 'Basic', states: IssueState[] = BASIC_STATES): Runner {
  return (args) => {
    if (args.includes('invoke')) return JSON.stringify({ value: states });
    if (args.includes('list'))
      return JSON.stringify({ value: [{ name: 'Alpha' }, { name: 'Beta' }] });
    return JSON.stringify({ capabilities: { processTemplate: { templateName: template } } });
  };
}

interface GhOpts {
  projects?: Array<{ number: number; title: string; id: string }>;
  statusOptions?: Array<{ id: string; name: string }>;
  noStatusField?: boolean;
  login?: string;
  repo?: string;
  repos?: string[];
  scopes?: string;
}

/** Fake `gh`: token scopes (api -i), project list, field-list, api user (login), repo list/view. */
function fakeGh(o: GhOpts = {}): Runner {
  const projects = o.projects ?? [{ number: 5, title: 'Roadmap', id: 'PVT_5' }];
  const statusOptions = o.statusOptions ?? [
    { id: 'o1', name: 'Todo' },
    { id: 'o2', name: 'In Progress' },
    { id: 'o3', name: 'Done' },
  ];
  return (args) => {
    if (args[1] === 'project' && args[2] === 'list') return JSON.stringify({ projects });
    if (args[1] === 'project' && args[2] === 'field-list') {
      return o.noStatusField
        ? JSON.stringify({ fields: [{ id: 'PVTF_t', name: 'Title', type: 'text' }] })
        : JSON.stringify({ fields: [{ id: 'PVTSSF_s', name: 'Status', options: statusOptions }] });
    }
    if (args[1] === 'api' && args.includes('-i')) {
      return `HTTP/2.0 200 OK\r\nX-Oauth-Scopes: ${o.scopes ?? 'repo, read:project, project'}\r\n\r\n{}`;
    }
    if (args[1] === 'api') return `${o.login ?? 'octocat'}\n`;
    if (args[1] === 'repo' && args[2] === 'list') {
      return JSON.stringify(
        (o.repos ?? ['acme/app', 'acme/api']).map((r) => ({ nameWithOwner: r })),
      );
    }
    if (args[1] === 'repo' && args[2] === 'view') return `${o.repo ?? 'acme/app'}\n`;
    return '';
  };
}

describe('SessionStart hook merge', () => {
  it('adds the hook, is idempotent, and preserves other hooks', () => {
    const settings: Record<string, any> = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
    };
    expect(mergeSessionStartHook(settings)).toBe(true);
    expect(mergeSessionStartHook(settings)).toBe(false);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
  });
});

describe('permissions merge', () => {
  it('adds the deny/allow defaults, is idempotent, and preserves existing rules', () => {
    const settings: Record<string, any> = { permissions: { deny: ['Bash(rm:*)'], allow: [] } };
    expect(mergePermissions(settings)).toBe(true);
    expect(mergePermissions(settings)).toBe(false); // idempotent

    // pre-existing rule kept, plus every default deny/allow present exactly once
    expect(settings.permissions.deny).toContain('Bash(rm:*)');
    for (const rule of PERMISSION_DENY) {
      expect(settings.permissions.deny.filter((r: string) => r === rule)).toHaveLength(1);
    }
    for (const rule of PERMISSION_ALLOW) {
      expect(settings.permissions.allow.filter((r: string) => r === rule)).toHaveLength(1);
    }
  });

  it('denies gh/az PR + board commands and only `kodi init`, allows reading agents/skills', () => {
    expect(PERMISSION_DENY).toEqual(
      expect.arrayContaining([
        'Bash(gh pr:*)',
        'Bash(az repos pr:*)',
        'Bash(az boards:*)',
        'Bash(kodi init:*)',
      ]),
    );
    // kodi is the sanctioned proxy — only `kodi init` is denied, never all of kodi
    expect(PERMISSION_DENY).not.toContain('Bash(kodi:*)');
    expect(PERMISSION_DENY).not.toContain('Bash(rtk kodi:*)');
    expect(PERMISSION_ALLOW).toEqual(
      expect.arrayContaining(['Read(.claude/agents/**)', 'Read(.claude/skills/**)']),
    );
  });

  it('allows all kodi commands (direct + rtk) while init stays denied — deny wins', () => {
    expect(PERMISSION_ALLOW).toEqual(
      expect.arrayContaining(['Bash(kodi:*)', 'Bash(rtk kodi:*)']),
    );
    // the broad allow and the narrow init-deny coexist; deny precedence blocks init
    expect(PERMISSION_DENY).toEqual(
      expect.arrayContaining(['Bash(kodi init:*)', 'Bash(rtk kodi init:*)']),
    );
  });

  it('denies the rtk-proxied form of every board/PR + kodi-init command too', () => {
    // rtk rewrites `gh …` → `rtk gh …`, so each direct deny must have an rtk twin
    for (const direct of PERMISSION_DENY) {
      if (direct.startsWith('Bash(rtk ')) continue;
      const rtkForm = direct.replace('Bash(', 'Bash(rtk ');
      expect(PERMISSION_DENY).toContain(rtkForm);
    }
    expect(PERMISSION_DENY).toEqual(
      expect.arrayContaining([
        'Bash(rtk gh pr:*)',
        'Bash(rtk az repos pr:*)',
        'Bash(rtk az boards:*)',
        'Bash(rtk kodi init:*)',
      ]),
    );
  });

  it('seeds permissions from an empty settings object', () => {
    const settings: Record<string, any> = {};
    expect(mergePermissions(settings)).toBe(true);
    expect(settings.permissions.deny).toEqual(PERMISSION_DENY);
    expect(settings.permissions.allow).toEqual(PERMISSION_ALLOW);
  });
});

describe('installHarness (files only)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kodi-init-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('installs the hook, agents, skills and docs scaffold (no board file)', () => {
    installHarness(dir, { assetsDir: REPO_ASSETS });
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(true);
    // the settings file carries the pre-configured permission rules
    const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf-8'));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(PERMISSION_DENY));
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(PERMISSION_ALLOW));
    for (const a of ['brief', 'architect', 'build-orchestrator']) {
      expect(existsSync(join(dir, '.claude/agents', `${a}.md`))).toBe(true);
    }
    for (const sk of ['discover', 'oplan', 'tickets', 'ticket-start']) {
      expect(existsSync(join(dir, '.claude/skills', sk, 'SKILL.md'))).toBe(true);
    }
    expect(existsSync(join(dir, '.claude/rules/ticket-completion.md'))).toBe(true);
    expect(existsSync(join(dir, 'docs/adr'))).toBe(true);
    // Default provider is local → the local ticket store IS scaffolded.
    expect(existsSync(join(dir, 'docs/tickets'))).toBe(true);
    // the board state file is NOT written by installHarness (the wizard writes it)
    expect(existsSync(join(dir, '.claude/kodi-dev.yaml'))).toBe(false);
  });

  it.each(['github', 'azure'] as const)(
    'does NOT scaffold docs/tickets for the %s provider (remote board owns its tickets)',
    (provider) => {
      installHarness(dir, { assetsDir: REPO_ASSETS, provider });
      // Remote board: no local ticket store…
      expect(existsSync(join(dir, 'docs/tickets'))).toBe(false);
      // …but the provider-independent docs scaffold is still installed.
      expect(existsSync(join(dir, 'docs/adr'))).toBe(true);
      expect(existsSync(join(dir, 'docs/prd'))).toBe(true);
    },
  );
});

describe('normalizeOrgUrl', () => {
  it('expands a bare org name, a host path, and passes full URLs through', () => {
    expect(normalizeOrgUrl('acme')).toBe('https://dev.azure.com/acme');
    expect(normalizeOrgUrl('dev.azure.com/acme')).toBe('https://dev.azure.com/acme');
    expect(normalizeOrgUrl('https://dev.azure.com/acme/')).toBe('https://dev.azure.com/acme');
    expect(normalizeOrgUrl('  ')).toBe('');
  });
});

describe('configureBoard wizard', () => {
  it('configures the local provider', async () => {
    const cfg = await configureBoard(scripted({ select: ['local'], input: ['MYPROJ'] }));
    expect(cfg).toEqual({ provider: 'local', prefix: 'MYPROJ' });
  });

  it('configures azure: lists projects, selects one, auto-maps single-candidate columns', async () => {
    // Basic has one state per category → all columns auto-selected, no column prompts.
    const cfg = await configureBoard(
      scripted({ select: ['azure', 'Beta'], input: ['https://dev.azure.com/acme', 'MyRepo'] }),
      { runner: fakeAz() },
    );
    expect(cfg.provider).toBe('azure');
    expect(cfg.organization).toBe('https://dev.azure.com/acme');
    expect(cfg.project).toBe('Beta');
    expect(cfg.repository).toBe('MyRepo');
    expect(cfg.columns).toEqual({
      todo: 'To Do',
      inProgress: 'Doing',
      toReview: 'Doing',
      done: 'Done',
    });
  });

  it('lets the user SELECT the To Do column when several Proposed states exist', async () => {
    const states: IssueState[] = [
      { name: 'New', category: 'Proposed' },
      { name: 'To Do', category: 'Proposed' },
      { name: 'Doing', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
    ];
    const cfg = await configureBoard(
      scripted({
        select: ['azure', 'Beta', 'To Do'],
        input: ['https://dev.azure.com/acme', 'MyRepo'],
      }),
      { runner: fakeAz('Basic', states) },
    );
    expect(cfg.columns?.todo).toBe('To Do');
  });

  it('configures azure non-interactively from flags', async () => {
    const cfg = await configureBoard(scripted({}), {
      provider: 'azure',
      org: 'https://dev.azure.com/acme',
      project: 'Beta',
      todoColumn: 'To Do',
      inProgressColumn: 'Doing',
      toReviewColumn: 'Review',
      doneColumn: 'Done',
      repository: 'MyRepo',
      runner: fakeAz(),
    });
    expect(cfg.project).toBe('Beta');
    expect(cfg.columns?.todo).toBe('To Do');
  });

  it('aborts when a flagged project is not in the org', async () => {
    await expect(
      configureBoard(scripted({}), {
        provider: 'azure',
        org: 'https://dev.azure.com/acme',
        project: 'Ghost',
        runner: fakeAz(),
      }),
    ).rejects.toThrow(/not found/);
  });

  it('aborts azure when the process has no Issue type (Agile)', async () => {
    await expect(
      configureBoard(
        scripted({ select: ['azure', 'Beta'], input: ['https://dev.azure.com/acme'] }),
        {
          runner: fakeAz('Agile'),
        },
      ),
    ).rejects.toThrow(/Issue/);
  });

  it('aborts when the board has no To Do-type (Proposed) state', async () => {
    const states: IssueState[] = [
      { name: 'Doing', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
    ];
    await expect(
      configureBoard(
        scripted({ select: ['azure', 'Beta'], input: ['https://dev.azure.com/acme'] }),
        {
          runner: fakeAz('Basic', states),
        },
      ),
    ).rejects.toThrow(/To Do-type/);
  });

  it('aborts azure when the organization URL is missing', async () => {
    await expect(
      configureBoard(scripted({ select: ['azure'], input: [''] }), { runner: fakeAz() }),
    ).rejects.toThrow(/organization/);
  });

  it('configures github: org-owned, discovers project + Status options, picks columns, selects repo', async () => {
    const cfg = await configureBoard(
      scripted({
        // repo select: current repo (acme/app) is surfaced first and chosen
        select: [
          'github',
          'organization',
          '#5 Roadmap',
          'Todo',
          'In Progress',
          'In Progress',
          'Done',
          'acme/app',
        ],
        input: ['acme'], // org login
      }),
      { runner: fakeGh() },
    );
    expect(cfg.provider).toBe('github');
    expect(cfg.projectOwner).toBe('acme');
    expect(cfg.projectNumber).toBe(5);
    expect(cfg.repository).toBe('acme/app');
    expect(cfg.columns).toEqual({
      todo: 'Todo',
      inProgress: 'In Progress',
      toReview: 'In Progress',
      done: 'Done',
    });
  });

  it('configures github: user-owned defaults the owner to the authenticated login, auto-maps single option', async () => {
    const cfg = await configureBoard(
      scripted({ select: ['github', 'user', '#5 Roadmap', 'octocat/app'] }),
      {
        runner: fakeGh({
          statusOptions: [{ id: 'o1', name: 'Todo' }],
          login: 'octocat',
          repo: 'octocat/app',
          repos: ['octocat/app', 'octocat/site'],
        }),
      },
    );
    expect(cfg.projectOwner).toBe('octocat');
    expect(cfg.repository).toBe('octocat/app');
    expect(cfg.columns).toEqual({
      todo: 'Todo',
      inProgress: 'Todo',
      toReview: 'Todo',
      done: 'Todo',
    });
  });

  it('configures github: falls back to free-text repo when the owner has no listable repos', async () => {
    const cfg = await configureBoard(
      scripted({
        select: ['github', 'organization', '#5 Roadmap'],
        input: ['acme', 'acme/private'], // org login, then typed repo (no repos to select)
      }),
      { runner: fakeGh({ statusOptions: [{ id: 'o1', name: 'Todo' }], repos: [] }) },
    );
    expect(cfg.repository).toBe('acme/private');
  });

  it('configures github non-interactively from flags', async () => {
    const cfg = await configureBoard(scripted({}), {
      provider: 'github',
      projectOwner: 'acme',
      projectNumber: 5,
      todoColumn: 'Todo',
      inProgressColumn: 'In Progress',
      toReviewColumn: 'In Progress',
      doneColumn: 'Done',
      repository: 'acme/app',
      runner: fakeGh(),
    });
    expect(cfg.projectNumber).toBe(5);
    expect(cfg.columns?.todo).toBe('Todo');
  });

  it('aborts github when the board has no Status field', async () => {
    await expect(
      configureBoard(
        scripted({ select: ['github', 'organization', '#5 Roadmap'], input: ['acme'] }),
        {
          runner: fakeGh({ noStatusField: true }),
        },
      ),
    ).rejects.toThrow(/Status/);
  });

  it('aborts github with the scope hint when listing projects fails', async () => {
    const throwing: Runner = (args) => {
      if (args[2] === 'list') throw new Error('missing scopes');
      return '';
    };
    await expect(
      configureBoard(scripted({ select: ['github', 'organization'], input: ['acme'] }), {
        runner: throwing,
      }),
    ).rejects.toThrow(/gh auth refresh -s project --hostname github.com/);
  });

  it('aborts github up front when the token has read:project but not project (write)', async () => {
    await expect(
      configureBoard(scripted({ select: ['github', 'organization'], input: ['acme'] }), {
        runner: fakeGh({ scopes: 'repo, read:project' }),
      }),
    ).rejects.toThrow(/gh auth refresh -s project --hostname github.com/);
  });

  it('aborts github when a flagged project number is not found', async () => {
    await expect(
      configureBoard(scripted({}), {
        provider: 'github',
        projectOwner: 'acme',
        projectNumber: 99,
        runner: fakeGh(),
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('writeState', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kodi-state-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes .claude/kodi-dev.yaml', () => {
    const p = writeState(dir, { provider: 'local', prefix: 'KODI' });
    expect(p).toContain('.claude/kodi-dev.yaml');
    const yaml = readFileSync(p, 'utf-8');
    expect(yaml).toContain('provider: local');
  });
});
