import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// KODI-012 required integration smoke: start the REAL launcher against a temp
// project and assert the whole loop — board serves an empty board (no status.yaml
// → no error, AC), then SIGTERM tears the launcher down and reaps the board child
// (no orphan: the port stops accepting). This file must NOT mock spawn — it drives
// the compiled CLI + the real standalone board.
//
// Self-sufficient under `make check` / a build-less gate: if the compiled
// artifacts are absent we SKIP with a message naming what to build, rather than
// attempting a multi-minute board build inside the unit suite.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const distIndex = join(repoRoot, 'dist', 'index.js');
const boardServer = join(repoRoot, 'board-dist', 'server.js');

const missing = !existsSync(boardServer)
  ? 'board-dist/server.js (run `pnpm build`)'
  : !existsSync(distIndex)
    ? 'dist/index.js (run `pnpm build`)'
    : '';
if (missing) {
  // Surfaced in the run output so a skip is never silent.
  console.warn(`[serve-smoke] SKIPPED — missing ${missing}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `fn` until it yields a defined, non-false value or the deadline passes. */
async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  interval = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await sleep(interval);
  }
}

/** A single GET; resolves with status + body, rejects on connection error. */
function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const req = http.get(url, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c) => (body += c));
      r.on('end', () => res({ status: r.statusCode ?? 0, body }));
    });
    req.on('error', rej);
    req.setTimeout(5_000, () => req.destroy(new Error('http timeout')));
  });
}

/** True when a TCP connect to the port is refused/failed (i.e. nothing listening). */
function tcpRefused(port: number): Promise<boolean> {
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

let cli: ChildProcess | undefined;
let fixture = '';

afterAll(() => {
  // Never leak a process or temp dir from the test itself, even on failure.
  if (cli && cli.exitCode === null && cli.signalCode === null) {
    try {
      cli.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe('kodi tickets serve — real launcher smoke (serve + clean teardown, no orphan)', () => {
  it.skipIf(missing !== '')(
    'serves an empty board over loopback and reaps the board child on SIGTERM',
    async () => {
      // A fresh, UNINITIALIZED project: no status.yaml → empty board must NOT error.
      fixture = mkdtempSync(join(tmpdir(), 'kodi-serve-smoke-'));
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(join(fixture, '.claude', 'kodi-dev.yaml'), 'provider: local\nprefix: KODI\n');
      mkdirSync(join(fixture, 'docs', 'tickets'), { recursive: true });

      cli = spawn('node', [distIndex, 'tickets', 'serve'], {
        cwd: fixture,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, KODI_NO_OPEN: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      cli.stdout!.on('data', (d) => (out += d.toString()));
      cli.stderr!.on('data', (d) => (out += d.toString()));

      // 1. Wait for the readiness line and parse the port (bounded ~30s).
      const port = await waitFor(() => {
        const m = /Board running at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        return m ? Number(m[1]) : undefined;
      }, 30_000);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65_535);

      // 2. HTTP 200 + board HTML markers. Next standalone has a brief post-"ready"
      //    window before it stably accepts, so retry the GET until it answers 200.
      const resp = await waitFor(async () => {
        try {
          const r = await httpGet(`http://127.0.0.1:${port}`);
          return r.status === 200 ? r : undefined;
        } catch {
          return undefined;
        }
      }, 20_000);
      expect(resp.status).toBe(200);
      expect(resp.body).toContain('<html');
      expect(resp.body).toContain('kodi board'); // board shell rendered
      expect(resp.body).toContain('No tickets yet'); // empty-board state, not an error
      expect(resp.body).not.toContain("Couldn't read the board"); // never the error UI

      // 3. Teardown: SIGTERM the CLI and assert it exits (bounded).
      const exited = new Promise<number | null>((res) =>
        cli!.once('exit', (code, signal) => res(code ?? (signal ? 0 : null))),
      );
      cli!.kill('SIGTERM');
      await waitFor(
        () => (cli!.exitCode !== null || cli!.signalCode !== null ? true : undefined),
        15_000,
      );
      await exited;
      expect(cli!.exitCode !== null || cli!.signalCode !== null).toBe(true);

      // 4. NO ORPHAN: the board child was reaped — the port stops accepting within a
      //    short bounded window after the CLI exits (the portable primary check).
      const closed = await waitFor(
        async () => ((await tcpRefused(port)) ? true : undefined),
        8_000,
      );
      expect(closed).toBe(true);
    },
    60_000,
  );
});
