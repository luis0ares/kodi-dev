import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureBoard,
  InitAbort,
  installHarness,
  mergeSessionStartHook,
  writeState,
} from '../src/commands/init.js';
import type { Prompter } from '../src/prompt.js';
import type { Runner } from '../src/providers/azure-discovery.js';

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
      return i.length ? i.shift()! : def ?? '';
    },
    async confirm(_m, def) {
      return c.length ? c.shift()! : def ?? true;
    },
    close() {},
  };
}

const fakeAz: Runner = (args) =>
  args.includes('list') ? JSON.stringify({ value: [{ name: 'Alpha' }, { name: 'Beta' }] }) : '{}';

describe('SessionStart hook merge', () => {
  it('adds the hook, is idempotent, and preserves other hooks', () => {
    const settings: Record<string, any> = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
    expect(mergeSessionStartHook(settings)).toBe(true);
    expect(mergeSessionStartHook(settings)).toBe(false);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
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
    for (const a of ['brief', 'architect', 'build-orchestrator']) {
      expect(existsSync(join(dir, '.claude/agents', `${a}.md`))).toBe(true);
    }
    for (const sk of ['discover', 'oplan', 'tickets', 'ticket-start']) {
      expect(existsSync(join(dir, '.claude/skills', sk, 'SKILL.md'))).toBe(true);
    }
    expect(existsSync(join(dir, 'docs/adr'))).toBe(true);
    // the board state file is NOT written by installHarness (the wizard writes it)
    expect(existsSync(join(dir, '.claude/kodi-dev.yaml'))).toBe(false);
  });
});

describe('configureBoard wizard', () => {
  it('configures the local provider', async () => {
    const cfg = await configureBoard(scripted({ select: ['local'], input: ['MYPROJ'] }));
    expect(cfg).toEqual({ provider: 'local', prefix: 'MYPROJ' });
  });

  it('configures azure: lists projects, selects one, captures the column map', async () => {
    const cfg = await configureBoard(
      scripted({
        select: ['azure', 'Beta'],
        input: ['https://dev.azure.com/acme', 'To Do', 'Doing', 'Review', 'Done', 'MyRepo'],
      }),
      { runner: fakeAz },
    );
    expect(cfg.provider).toBe('azure');
    expect(cfg.organization).toBe('https://dev.azure.com/acme');
    expect(cfg.project).toBe('Beta');
    expect(cfg.repository).toBe('MyRepo');
    expect(cfg.columns).toEqual({ todo: 'To Do', inProgress: 'Doing', toReview: 'Review', done: 'Done' });
  });

  it('aborts azure when the To Do column is missing', async () => {
    await expect(
      configureBoard(
        scripted({ select: ['azure', 'Beta'], input: ['https://dev.azure.com/acme', ''] }),
        { runner: fakeAz },
      ),
    ).rejects.toThrow(InitAbort);
  });

  it('aborts azure when the organization URL is missing', async () => {
    await expect(
      configureBoard(scripted({ select: ['azure'], input: [''] }), { runner: fakeAz }),
    ).rejects.toThrow(/organization/);
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
