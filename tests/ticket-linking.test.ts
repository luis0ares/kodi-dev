import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spawn from 'cross-spawn';
import { normalizePrRef } from '../src/commands/tickets.js';
import { GithubTicketProvider } from '../src/providers/github.js';
import { resolveProvider } from '../src/providers/index.js';
import { TicketSchema } from '../src/templates/ticket.js';

// The provider shells out through src/exec.ts, which spawns via cross-spawn —
// mock that and the whole `gh` conversation becomes assertable argv.
vi.mock('cross-spawn', () => ({ default: { sync: vi.fn() } }));
const sync = vi.mocked(spawn.sync);

function ok(stdout: string) {
  return { status: 0, stdout, stderr: '', error: undefined } as never;
}

describe('normalizePrRef', () => {
  it('turns a bare number into a GitHub cross-reference instead of inert text', () => {
    expect(normalizePrRef('8', 'github')).toBe('#8');
    expect(normalizePrRef(' 8 ', 'github')).toBe('#8');
  });

  it('leaves anything already referential alone', () => {
    expect(normalizePrRef('#8', 'github')).toBe('#8');
    expect(normalizePrRef('https://github.com/o/r/pull/8', 'github')).toBe(
      'https://github.com/o/r/pull/8',
    );
    expect(normalizePrRef('slice/kodi-3', 'github')).toBe('slice/kodi-3');
  });

  it('leaves azure and local refs exactly as typed', () => {
    expect(normalizePrRef('8', 'azure')).toBe('8');
    expect(normalizePrRef('8', 'local')).toBe('8');
  });
});

describe('resolveProvider — github-only overrides', () => {
  let dir: string;

  beforeEach(() => {
    sync.mockReset();
    dir = mkdtempSync(join(tmpdir(), 'kodi-resolve-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function config(yaml: string) {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'kodi-dev.yaml'), yaml, 'utf-8');
  }

  it('files into the overridden repository, not the configured one', async () => {
    config(
      'provider: github\nprefix: KODI\nrepository: Owner/own\nprojectOwner: Owner\nprojectNumber: 1\n',
    );
    const p = resolveProvider(dir, {
      yes: true,
      repository: 'Owner/elsewhere',
      noProject: true,
    });
    expect(p.name).toBe('github');
    sync.mockReturnValue(ok('https://github.com/Owner/elsewhere/issues/4\n'));

    await p.create(
      TicketSchema.parse({ title: 'A ticket', summary: 's', acceptanceCriteria: ['a'] }),
    );

    const argv = sync.mock.calls[0][1] as string[];
    expect(argv).toContain('Owner/elsewhere');
    expect(argv).not.toContain('Owner/own');
  });

  it('rejects --repository on a provider where it means nothing, rather than ignoring it', () => {
    config('provider: local\nprefix: KODI\n');
    expect(() => resolveProvider(dir, { repository: 'Owner/elsewhere' })).toThrow(
      /--repository applies to the github provider only/,
    );
    expect(() => resolveProvider(dir, { noProject: true })).toThrow(
      /--no-project applies to the github provider only/,
    );
  });
});

describe('github provider — --no-project', () => {
  beforeEach(() => {
    sync.mockReset();
  });

  function provider(attachToProject: boolean) {
    return new GithubTicketProvider({
      repo: 'Owner/elsewhere',
      owner: 'Owner',
      number: 1,
      dryRun: false,
      attachToProject,
    });
  }

  const draft = () =>
    TicketSchema.parse({ title: 'A ticket', summary: 's', acceptanceCriteria: ['a'] });

  it('creates the issue and stops — no board call, no orphan to report', async () => {
    sync.mockReturnValue(ok('https://github.com/Owner/elsewhere/issues/4\n'));
    const created = await provider(false).create(draft());

    expect(created.key).toBe('4');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0]).toBe('gh');
    expect(sync.mock.calls[0][1]).toContain('issue');
  });

  it('still attaches to the board by default', async () => {
    sync
      .mockReturnValueOnce(ok('https://github.com/Owner/elsewhere/issues/4\n'))
      .mockReturnValueOnce(ok(JSON.stringify({ id: 'PVTI_item' })))
      .mockReturnValue(ok('{}'));
    await provider(true)
      .create(draft())
      .catch(() => undefined); // project-meta lookup is beyond this assertion

    expect(sync.mock.calls.length).toBeGreaterThan(1);
    expect(sync.mock.calls[1][1]).toContain('item-add');
  });

  it('previews only the issue create in a dry-run with --no-project', async () => {
    const p = new GithubTicketProvider({
      repo: 'Owner/elsewhere',
      owner: 'Owner',
      number: 1,
      dryRun: true,
      attachToProject: false,
    });
    const created = await p.create(draft());

    expect(created.key).toBe('(dry-run)');
    expect(sync).not.toHaveBeenCalled(); // dry-run never spawns
  });
});
