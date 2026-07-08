import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openBrowser,
  pickFreePort,
  registerServeCommand,
  resolveBoardServer,
  waitForListen,
} from '../src/commands/serve.js';
import { registerTicketsCommand } from '../src/commands/tickets.js';

// KODI-012 `kodi tickets serve` / `open` launcher — the fast, board-free unit
// surface. `node:child_process` `spawn` is mocked so the security contract of the
// board spawn (argv-only, no shell, localhost-only, explicit env allowlist) and of
// the browser opener can be asserted WITHOUT standing up a real Next server. The
// real end-to-end teardown/no-orphan smoke lives in serve-smoke.test.ts (which must
// NOT mock spawn), so it is deliberately a separate file.
//
// Only `spawn` is overridden; every other child_process export stays real so the
// rest of the serve module graph is unaffected.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});
const spawnMock = vi.mocked(spawn);

/** Repo root, from tests/ up one — the package root where board-dist/ lives. */
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

describe('pickFreePort', () => {
  it('returns an integer port in 1..65535 that is actually free (bindable)', async () => {
    const port = await pickFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1);
    expect(port).toBeLessThanOrEqual(65_535);

    // The port must be genuinely free: we can bind it ourselves right now.
    await new Promise<void>((res, rej) => {
      const s = net.createServer();
      s.once('error', rej);
      s.listen(port, '127.0.0.1', () => s.close(() => res()));
    });
  });
});

/** True when a TCP connect to 127.0.0.1:port is refused (nothing accepting). */
function isRefused(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      res(false);
    });
    s.once('error', () => {
      s.destroy();
      res(true);
    });
  });
}

/**
 * A free port that is CONFIRMED to be refusing connections. Some environments
 * (e.g. WSL2) keep a just-closed loopback port in a briefly-accepting state for a
 * few hundred ms; we poll until it actually refuses so the "nothing is listening"
 * timeout path is exercised deterministically. On a normal host this returns on
 * the first probe.
 */
async function refusedPort(): Promise<number> {
  const port = await pickFreePort();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await isRefused(port)) return port;
    await new Promise((r) => setTimeout(r, 100));
  }
  return port;
}

describe('waitForListen', () => {
  it('resolves once something is listening on the port', async () => {
    const server = net.createServer();
    const port = await new Promise<number>((res) => {
      server.listen(0, '127.0.0.1', () => res((server.address() as net.AddressInfo).port));
    });
    try {
      await expect(waitForListen(port, 5_000, () => false)).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('rejects on timeout when nothing is listening', async () => {
    const port = await refusedPort(); // confirmed refusing → nothing accepts here
    await expect(waitForListen(port, 50, () => false)).rejects.toThrow(/timeout/);
  });

  it('rejects promptly via the abort path when shouldStop() returns true', async () => {
    const port = await pickFreePort();
    const start = Date.now();
    await expect(waitForListen(port, 10_000, () => true)).rejects.toThrow(/aborted/);
    // Aborts on the first probe — nowhere near the 10s timeout.
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe('resolveBoardServer', () => {
  it('returns the existing package-relative board server path when board-dist is present', () => {
    const p = resolveBoardServer();
    expect(existsSync(p)).toBe(true);
    expect(p.endsWith(`board-dist${sep}server.js`)).toBe(true);
  });

  it('throws the clean actionable "board not built" message when board-dist is absent', () => {
    const boardDist = join(repoRoot, 'board-dist');
    const bak = `${boardDist}.serve-test.bak`;
    expect(existsSync(boardDist)).toBe(true);

    // Make BOTH candidate paths absent by temporarily moving the real board-dist.
    // ALWAYS restored in finally so the repo is never left broken, even on failure.
    renameSync(boardDist, bak);
    try {
      expect(() => resolveBoardServer()).toThrow('board not built — run `pnpm build`');
    } finally {
      renameSync(bak, boardDist);
    }
    expect(existsSync(boardDist)).toBe(true); // guaranteed-restore post-condition
  });
});

describe('openBrowser — argv-only, no-shell, resilient', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });

  beforeEach(() => {
    spawnMock.mockReset();
    // A minimal child stand-in: openBrowser only touches .once('error') and .unref().
    spawnMock.mockReturnValue({ once: vi.fn(), unref: vi.fn() } as unknown as ReturnType<
      typeof spawn
    >);
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  const URL = 'http://127.0.0.1:54321';

  it('linux: spawns `xdg-open [url]` as an argv array with no shell option', () => {
    setPlatform('linux');
    openBrowser(URL);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('xdg-open');
    expect(args).toEqual([URL]); // the URL is the ONLY, single argv element
    expect(opts).not.toHaveProperty('shell');
  });

  it('darwin: spawns `open [url]` as an argv array with no shell option', () => {
    setPlatform('darwin');
    openBrowser(URL);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('open');
    expect(args).toEqual([URL]);
    expect(opts).not.toHaveProperty('shell');
  });

  it('win32: spawns `cmd /c start "" <url>` — the empty-title guard keeps the URL', () => {
    setPlatform('win32');
    openBrowser(URL);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '', URL]);
    expect((args as string[])[2]).toBe(''); // explicit empty-title guard at index 2
    expect(opts).not.toHaveProperty('shell');
  });

  it('never throws even when spawn itself throws (opener missing → non-fatal)', () => {
    setPlatform('linux');
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT: xdg-open not found');
    });
    expect(() => openBrowser(URL)).not.toThrow();
  });
});

describe('registerServeCommand — wiring under tickets', () => {
  it('attaches a `serve` command with alias `open` under the tickets command', () => {
    const program = new Command();
    registerTicketsCommand(program);
    registerServeCommand(program);

    const tickets = program.commands.find((c) => c.name() === 'tickets');
    expect(tickets).toBeDefined();
    const serve = tickets!.commands.find((c) => c.name() === 'serve');
    expect(serve).toBeDefined();
    expect(serve!.aliases()).toContain('open');
  });

  it('throws the internal error when `tickets` is not registered first', () => {
    const program = new Command();
    expect(() => registerServeCommand(program)).toThrow(/tickets/);
  });
});

describe('serve action — spawn argv/env security contract', () => {
  let fixture: string;
  let cwdBefore: string;
  let expectedTickets: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'kodi-serve-'));
    mkdirSync(join(fixture, '.claude'), { recursive: true });
    writeFileSync(join(fixture, '.claude', 'kodi-dev.yaml'), 'provider: local\nprefix: KODI\n');
    mkdirSync(join(fixture, 'docs', 'tickets'), { recursive: true });

    cwdBefore = process.cwd();
    process.chdir(fixture);
    // The tickets dir the action must normalize + hand to the board (from the real cwd).
    expectedTickets = resolve(join(process.cwd(), 'docs', 'tickets'));

    process.env.KODI_NO_OPEN = '1'; // no real browser; also skips openBrowser entirely
    process.env.GH_TOKEN = 'sekret'; // a secret that MUST NOT leak into the board env
    spawnMock.mockReset();
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    delete process.env.KODI_NO_OPEN;
    delete process.env.GH_TOKEN;
    process.exitCode = 0; // the action sets exitCode; reset so it can't fail the run
    rmSync(fixture, { recursive: true, force: true });
  });

  it('spawns process.execPath [board-dist/server.js] with a localhost-only, secret-free env allowlist', async () => {
    // Fake child: an EventEmitter with the props the teardown reads. Emitting 'exit'
    // on the next tick (after the action attaches its listeners) settles the action
    // deterministically, so the test never waits on the 15s listen timeout.
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: (s?: NodeJS.Signals) => boolean;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    spawnMock.mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ReturnType<typeof spawn>;
    });

    const program = new Command();
    program.exitOverride();
    registerTicketsCommand(program);
    registerServeCommand(program);
    await program.parseAsync(['tickets', 'serve'], { from: 'user' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [arg0, argv, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; shell?: boolean },
    ];

    // arg0 is the running node binary itself — never the literal string 'node'
    // (no PATH hijack), and argv is a single-element array (no shell splitting).
    expect(arg0).toBe(process.execPath);
    expect(arg0).not.toBe('node');
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toHaveLength(1);
    expect(argv[0].endsWith(`board-dist${sep}server.js`)).toBe(true);
    expect(argv[0]).not.toBe('node');
    expect(opts).not.toHaveProperty('shell');

    // Localhost-only binding + normalized tickets dir + production env.
    const env = opts.env;
    expect(env.HOSTNAME).toBe('127.0.0.1');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.NODE_ENV).toBe('production');
    expect(env.KODI_TICKETS_DIR).toBe(expectedTickets);
    expect(env.PORT).toMatch(/^\d+$/);

    // Explicit allowlist: an injected secret is NOT forwarded (no ...process.env).
    expect(env.GH_TOKEN).toBeUndefined();
    expect(process.env.GH_TOKEN).toBe('sekret'); // sanity: it WAS in the parent env
  });
});
