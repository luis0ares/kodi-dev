import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHarness, mergeSessionStartHook } from '../src/commands/init.js';

const REPO_ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));

describe('kodi init — SessionStart hook merge', () => {
  it('adds the hook to an empty settings object', () => {
    const settings: Record<string, any> = {};
    expect(mergeSessionStartHook(settings)).toBe(true);
    const entry = settings.hooks.SessionStart[0];
    expect(entry.matcher).toBe('startup|resume|clear|compact');
    expect(entry.hooks[0].command).toBe('kodi hook session-start');
  });

  it('is idempotent — a second merge changes nothing', () => {
    const settings: Record<string, any> = {};
    mergeSessionStartHook(settings);
    expect(mergeSessionStartHook(settings)).toBe(false);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it('preserves unrelated existing hooks', () => {
    const settings: Record<string, any> = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }],
      },
    };
    mergeSessionStartHook(settings);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });
});

describe('kodi init — installHarness', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kodi-init-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('installs hook, board config, agents, skills and docs scaffold', () => {
    const changed = installHarness(dir, { assetsDir: REPO_ASSETS });
    expect(changed).toContain('.claude/settings.json (SessionStart hook)');
    expect(changed).toContain('.claude/kodi/board.yaml');
    // briefing agents copied from packaged assets
    for (const a of ['brief', 'brownfield-wu', 'greenfield-wu']) {
      expect(existsSync(join(dir, '.claude/agents', `${a}.md`))).toBe(true);
    }
    // the five phase skills copied
    for (const s of ['discover', 'oplan', 'oreplan', 'tickets', 'ticket-start']) {
      expect(existsSync(join(dir, '.claude/skills', s, 'SKILL.md'))).toBe(true);
    }
    // docs scaffold
    expect(existsSync(join(dir, 'docs/adr'))).toBe(true);
    const board = readFileSync(join(dir, '.claude/kodi/board.yaml'), 'utf-8');
    expect(board).toContain('provider: local');
  });

  it('is idempotent — a second install changes nothing', () => {
    installHarness(dir, { assetsDir: REPO_ASSETS });
    const changed = installHarness(dir, { assetsDir: REPO_ASSETS });
    expect(changed).toHaveLength(0);
  });

  it('does not clobber a customized skill unless --force', () => {
    installHarness(dir, { assetsDir: REPO_ASSETS });
    const skill = join(dir, '.claude/skills/discover/SKILL.md');
    const marker = '# CUSTOMIZED BY USER';
    writeFileSync(skill, marker, 'utf-8');

    // non-forced reinstall preserves the customization
    installHarness(dir, { assetsDir: REPO_ASSETS });
    expect(readFileSync(skill, 'utf-8')).toBe(marker);

    // forced reinstall overwrites it with the packaged default
    installHarness(dir, { assetsDir: REPO_ASSETS, force: true });
    expect(readFileSync(skill, 'utf-8')).not.toBe(marker);
  });
});
