import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerTicketsCommand } from '../src/commands/tickets.js';
import { LegacyDataError, LocalTicketProvider } from '../src/providers/local.js';
import { emptyDocument, save, slugForStatus } from '../src/providers/status-index.js';
import { TICKET_STATUSES, TicketSchema } from '../src/templates/ticket.js';

// KODI-006 clean-start guard (ADR-0001 §2.6/§2.7, data-model §5).
// Conventions mirror tests/local-provider.test.ts: real mkdtemp fixtures on disk,
// provider driven directly, plus a command-layer harness for the refusal surfaces.

let dir: string;
let provider: LocalTicketProvider;
const originalCwd = process.cwd();

/**
 * Probe whether this environment can create symlinks at all (Windows without the
 * privilege, or a filesystem that rejects them, yields EPERM/ENOSYS). We attempt
 * it once so the fail-safe symlink test skips cleanly rather than failing where
 * symlinks are simply unavailable.
 */
function symlinksSupported(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'kodi-symprobe-'));
  try {
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const SYMLINKS_OK = symlinksSupported();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kodi-clean-start-'));
  // a .claude/kodi-dev.yaml so findProjectRoot() resolves to `dir` (local provider)
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'kodi-dev.yaml'), 'provider: local\nprefix: KODI\n', 'utf-8');
  provider = new LocalTicketProvider('KODI', dir);
});

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
});

function draft(over: Record<string, unknown> = {}) {
  return TicketSchema.parse({
    title: 'Add dataset import',
    summary: 'Import a dataset from CSV.',
    acceptanceCriteria: ['CSV upload works'],
    ...over,
  });
}

const ticketsRoot = () => join(dir, 'docs', 'tickets');
const statusYamlPath = () => join(ticketsRoot(), 'status.yaml');

/** Seed a legacy folder + one ticket-shaped file with the given frontmatter body. */
function seedLegacy(folder: 'backlog' | 'done', file: string, frontmatter: string): string {
  const abs = join(ticketsRoot(), folder);
  mkdirSync(abs, { recursive: true });
  const path = join(abs, file);
  writeFileSync(path, `---\n${frontmatter}\n---\n\nlegacy body\n`, 'utf-8');
  return path;
}

/**
 * Snapshot the full tree under `root` as a map of POSIX-relative path → 'dir' for
 * directories or the exact file contents for files. Used to assert byte-identical
 * non-destruction across an aborted create.
 */
function snapshot(root: string): Record<string, string> {
  const acc: Record<string, string> = {};
  function walk(abs: string, rel: string) {
    for (const dirent of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const childAbs = join(abs, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink()) {
        // record the link target without following it (a followed symlink to a
        // directory would make readFileSync throw EISDIR and never round-trip)
        acc[childRel] = `symlink:${readlinkSync(childAbs)}`;
      } else if (dirent.isDirectory()) {
        acc[childRel] = 'dir';
        walk(childAbs, childRel);
      } else {
        acc[childRel] = readFileSync(childAbs, 'utf-8');
      }
    }
  }
  walk(root, '');
  return acc;
}

/** Assert the five status folders + status.yaml were scaffolded (clean-start proceeded). */
function assertScaffolded() {
  expect(existsSync(statusYamlPath())).toBe(true);
  for (const status of TICKET_STATUSES) {
    expect(existsSync(join(ticketsRoot(), slugForStatus(status)))).toBe(true);
  }
}

// --- command-layer harness: exercise the real `tickets create` action path -------

interface CommandResult {
  stdout: string;
  exitCode: number | undefined;
}

/** Run `kodi tickets create …` against `dir` through commander, capturing stdout + exitCode. */
async function runCreate(args: string[]): Promise<CommandResult> {
  const program = new Command();
  program.exitOverride();
  registerTicketsCommand(program);

  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  process.exitCode = undefined;
  process.chdir(dir);
  try {
    await program.parseAsync(['node', 'kodi', 'tickets', 'create', ...args]);
  } finally {
    (process.stdout as { write: unknown }).write = realWrite;
    process.chdir(originalCwd);
  }
  return { stdout: chunks.join(''), exitCode: process.exitCode };
}

describe('clean-start guard — positive predicate (abort + non-destruction)', () => {
  it('aborts create with LegacyDataError and leaves the tree byte-identical (no scaffold, no temp files)', async () => {
    seedLegacy('backlog', 'KODI-1-foo.md', 'key: KODI-1\ntitle: Legacy foo');
    const before = snapshot(dir);

    await expect(provider.create(draft())).rejects.toBeInstanceOf(LegacyDataError);

    const after = snapshot(dir);
    // core non-destruction assertion: nothing created, nothing changed, nothing removed
    expect(after).toEqual(before);
    // explicit spot-checks on top of the whole-tree equality
    expect(existsSync(statusYamlPath())).toBe(false);
    for (const status of TICKET_STATUSES) {
      expect(existsSync(join(ticketsRoot(), slugForStatus(status)))).toBe(false);
    }
    // no temp files left behind anywhere under docs/tickets
    const backlogEntries = readdirSync(join(ticketsRoot(), 'backlog'));
    expect(backlogEntries).toEqual(['KODI-1-foo.md']);
  });

  // SR-E/SR-B fail-safe: a symlinked legacy folder cannot be safely enumerated
  // (never follow it out of tree), so legacyDirState classifies it 'unsafe' and
  // detectLegacyData must ABORT-and-report rather than fall through to scaffold
  // writes. Skipped only where the platform cannot create symlinks at all.
  it.skipIf(!SYMLINKS_OK)(
    'a symlinked legacy backlog/ is classified unsafe → fail-safe abort (LegacyDataError), tree + link + target intact',
    async () => {
      // A real directory (holding a ticket-shaped md) placed inside the snapshot
      // root but OUTSIDE docs/tickets, so its bytes are captured by the snapshot.
      const target = join(dir, 'legacy-target');
      mkdirSync(target, { recursive: true });
      writeFileSync(
        join(target, 'KODI-1-foo.md'),
        '---\nkey: KODI-1\ntitle: Legacy foo\n---\n\nlegacy body\n',
        'utf-8',
      );
      // docs/tickets must exist to host the symlink named `backlog`.
      mkdirSync(ticketsRoot(), { recursive: true });
      const linkPath = join(ticketsRoot(), 'backlog');
      symlinkSync(target, linkPath, 'dir');
      // sanity: the guard's lstat sees a symlink (drives the 'unsafe' branch)
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

      const before = snapshot(dir);

      // fail-safe abort: never followed, never scaffolded
      await expect(provider.create(draft())).rejects.toBeInstanceOf(LegacyDataError);

      const after = snapshot(dir);
      // core non-destruction: byte-identical tree, symlink pointer + target untouched
      expect(after).toEqual(before);
      // explicit spot-checks: no scaffold write happened
      expect(existsSync(statusYamlPath())).toBe(false);
      for (const status of TICKET_STATUSES) {
        expect(existsSync(join(ticketsRoot(), slugForStatus(status)))).toBe(false);
      }
      // link is still a symlink (not replaced by a real dir) and its target is intact
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(target, 'KODI-1-foo.md'), 'utf-8')).toContain('key: KODI-1');
    },
  );
});

describe('clean-start guard — report shape + both command surfaces', () => {
  it('LegacyDataError.report carries the structured refusal payload', async () => {
    seedLegacy('backlog', 'KODI-1-foo.md', 'key: KODI-1\ntitle: Legacy foo');
    const err = await provider.create(draft()).then(
      () => {
        throw new Error('expected create to reject');
      },
      (e: unknown) => e as LegacyDataError,
    );
    expect(err).toBeInstanceOf(LegacyDataError);
    expect(err.report.ok).toBe(false);
    expect(err.report.reason).toBe('legacy-data-present');
    expect(err.report.folders).toContain('backlog');
    expect(err.report.ticketCount).toBeGreaterThanOrEqual(1);
  });

  it('--json surface emits the structured report object to stdout and exits non-zero', async () => {
    seedLegacy('backlog', 'KODI-1-foo.md', 'key: KODI-1\ntitle: Legacy foo');
    const res = await runCreate([
      '--title',
      'New ticket',
      '--summary',
      'x',
      '--ac',
      'works',
      '--json',
    ]);
    expect(res.exitCode).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload).toEqual({
      ok: false,
      reason: 'legacy-data-present',
      folders: ['backlog'],
      ticketCount: 1,
    });
    // aborted: nothing scaffolded
    expect(existsSync(statusYamlPath())).toBe(false);
  });

  it('human surface names the folder(s) + count, states the clean-start refusal, and exits non-zero', async () => {
    seedLegacy('backlog', 'KODI-1-foo.md', 'key: KODI-1\ntitle: Legacy foo');
    const res = await runCreate(['--title', 'New ticket', '--summary', 'x', '--ac', 'works']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('backlog');
    expect(res.stdout.toLowerCase()).toContain('clean-start');
    // count of legacy ticket files is surfaced
    expect(res.stdout).toMatch(/1 ticket file\b/);
    // not JSON on the human surface
    expect(res.stdout.trim().startsWith('{')).toBe(false);
    expect(existsSync(statusYamlPath())).toBe(false);
  });
});

describe('clean-start guard — clean / no-legacy paths proceed normally', () => {
  it('fresh empty root scaffolds status.yaml + five folders and files the ticket', async () => {
    const t = await provider.create(draft());
    assertScaffolded();
    expect(t.key).toBe('KODI-001');
    expect(existsSync(join(ticketsRoot(), slugForStatus('Pending'), `${t.key}-${t.slug}.md`))).toBe(
      true,
    );
  });

  it('an empty backlog/ (no ticket-shaped md) does not trip the guard', async () => {
    mkdirSync(join(ticketsRoot(), 'backlog'), { recursive: true });
    const t = await provider.create(draft());
    assertScaffolded();
    expect(t.key).toBe('KODI-001');
  });

  it('a stray non-ticket .md under backlog/ does not trip the guard', async () => {
    const abs = join(ticketsRoot(), 'backlog');
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, 'notes.md'), '# just some notes\n', 'utf-8');
    const t = await provider.create(draft());
    assertScaffolded();
    expect(t.key).toBe('KODI-001');
  });

  it('a ticket-named .md with NO frontmatter key does not trip the guard', async () => {
    seedLegacy('backlog', 'KODI-5-nokey.md', 'title: no key here\nstatus: Pending');
    const t = await provider.create(draft());
    assertScaffolded();
    expect(t.key).toBe('KODI-001');
  });

  it('a pre-existing valid status.yaml alongside a legacy backlog/ skips detection and proceeds', async () => {
    mkdirSync(ticketsRoot(), { recursive: true });
    save(statusYamlPath(), emptyDocument());
    seedLegacy('backlog', 'KODI-7-legacy.md', 'key: KODI-7\ntitle: Legacy seven');
    const legacyBefore = readFileSync(join(ticketsRoot(), 'backlog', 'KODI-7-legacy.md'), 'utf-8');

    const t = await provider.create(draft());
    assertScaffolded();
    expect(existsSync(join(ticketsRoot(), slugForStatus('Pending'), `${t.key}-${t.slug}.md`))).toBe(
      true,
    );
    // legacy file untouched
    expect(readFileSync(join(ticketsRoot(), 'backlog', 'KODI-7-legacy.md'), 'utf-8')).toBe(
      legacyBefore,
    );
  });
});

describe('clean-start guard — done/ variant + predicate fidelity + malformed safety', () => {
  it('a legacy done/ folder with a ticket-shaped file trips the guard (folders includes "done")', async () => {
    seedLegacy('done', 'KODI-2-bar.md', 'key: KODI-2\ntitle: Legacy bar');
    const err = await provider.create(draft()).then(
      () => {
        throw new Error('expected create to reject');
      },
      (e: unknown) => e as LegacyDataError,
    );
    expect(err).toBeInstanceOf(LegacyDataError);
    expect(err.report.folders).toContain('done');
    expect(existsSync(statusYamlPath())).toBe(false);
  });

  it('predicate fidelity: a valid frontmatter `key` but otherwise incomplete ticket STILL trips', async () => {
    // only `key` present — missing title/summary/acceptanceCriteria (not a full TicketSchema)
    seedLegacy('backlog', 'KODI-3-partial.md', 'key: KODI-3');
    await expect(provider.create(draft())).rejects.toBeInstanceOf(LegacyDataError);
    expect(existsSync(statusYamlPath())).toBe(false);
  });

  it('malformed/unparseable frontmatter is treated as not-ticket-shaped and does not crash detection', async () => {
    // dangling quote → yaml parse error; must be swallowed as "not ticket-shaped"
    seedLegacy('backlog', 'KODI-9-broken.md', 'key: "unterminated');
    const t = await provider.create(draft());
    assertScaffolded();
    expect(t.key).toBe('KODI-001');
  });
});
