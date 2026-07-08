import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { localPaths } from '../config.js';

/**
 * `kodi tickets serve` / `open` — launch the local board (ADR-0002 §2.4 / PRD R-016).
 *
 * Security posture (audited — the verify pass checks these):
 *   - Localhost ONLY. The Next standalone server binds `process.env.HOSTNAME`
 *     (default `0.0.0.0`), so we hard-code `HOSTNAME='127.0.0.1'` (and `HOST` for
 *     good measure). Nothing here ever emits `0.0.0.0`/`::`.
 *   - No shell anywhere. Every child is `spawn(argv)` with no `shell` option; the
 *     board runs under `process.execPath` (never the string 'node' → no PATH hijack).
 *   - `board-dist/server.js` is resolved package-relative from `import.meta.url`,
 *     never from cwd / project-root / env. Missing → clean stderr message + exit 1.
 *   - Explicit env allowlist: no blanket `...process.env` spread, so no
 *     GH_TOKEN / GITHUB_TOKEN / AZURE_ / NPM_TOKEN or other secrets reach the board.
 *   - Deterministic, idempotent teardown: SIGTERM→(grace)→SIGKILL, no
 *     `detached`/`unref` orphan pattern; child exit/error propagate to the CLI.
 */

/** How long to wait for the board to accept TCP connections before giving up. */
const LISTEN_TIMEOUT_MS = 15_000;
/** Interval between TCP readiness probes. */
const PROBE_INTERVAL_MS = 200;
/** Grace period after SIGTERM before escalating to SIGKILL on teardown. */
const KILL_GRACE_MS = 2_500;

/**
 * Resolve the compiled board entrypoint relative to the INSTALLED CLI package —
 * never from cwd, project root, or any env var (R4). `board-dist/` sits at the
 * package root next to `dist/`. From the running module dir we probe the two
 * layouts:
 *   - installed: dist/index.js       → ../board-dist/server.js
 *   - dev/source: src/commands/*.ts  → ../../board-dist/server.js
 * Returns the first candidate whose `server.js` exists; throws (clean message,
 * no cwd fallback) when the board has not been built.
 */
export function resolveBoardServer(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, '..', 'board-dist', 'server.js'),
    resolve(moduleDir, '..', '..', 'board-dist', 'server.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('board not built — run `pnpm build` before `kodi tickets serve`');
}

/**
 * Pick a free TCP port on loopback by binding port 0 and reading the OS-assigned
 * port back. The standalone server runs with `allowRetry:false`, so it will not
 * hunt for a free port itself — we must hand it one. There is a tiny TOCTOU
 * window between close and the board's bind; an EADDRINUSE there surfaces via the
 * child's early exit (handled in the action).
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        probe.close(() => resolvePort(port));
      } else {
        probe.close(() => reject(new Error('could not determine a free port')));
      }
    });
  });
}

/**
 * Poll a TCP connect to 127.0.0.1:<port> until it is accepted, bounded by
 * `timeoutMs` (R8 — never unbounded). `shouldStop` lets the caller abort early
 * (e.g. the child died before listening) so we neither hang nor keep the event
 * loop alive with retries. Resolves once the port accepts; rejects on timeout or
 * abort.
 */
export function waitForListen(
  port: number,
  timeoutMs: number,
  shouldStop: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, reject) => {
    const attempt = () => {
      if (shouldStop()) {
        reject(new Error('aborted: board exited before it started listening'));
        return;
      }
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolveReady();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error('board server did not start listening within timeout'));
          return;
        }
        const timer = setTimeout(attempt, PROBE_INTERVAL_MS);
        timer.unref();
      });
    };
    attempt();
  });
}

/**
 * Cross-platform browser opener — a small built-in (ADR-0002 prefers built-in
 * over a dependency). argv-only, no shell (R3): the URL is the ONLY interpolated
 * value and is passed as a single argv element. On Windows the empty `''` is the
 * `start` title argument so the URL is not swallowed as a window title. Resilient
 * by design: if the opener binary is missing or fails we do NOT crash the serve —
 * the caller has already printed the URL for manual use.
 */
export function openBrowser(url: string): void {
  let child;
  try {
    if (process.platform === 'darwin') {
      child = spawn('open', [url], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      // Empty '' = window title, so `url` is not consumed as the title.
      child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { stdio: 'ignore' });
    }
    // Missing opener binary surfaces as an async 'error'; swallow it — the URL was
    // already printed, so the user can open it manually.
    child.once('error', () => {});
    child.unref();
  } catch {
    /* opener failed — non-fatal, URL already printed */
  }
}

/**
 * Build the board's process env from an EXPLICIT allowlist (R5/R9) — never a
 * blanket `...process.env` spread, so no secret-bearing vars leak into the board.
 * Only the named base vars node itself needs, plus the loopback binding + the
 * normalized tickets dir.
 */
function buildBoardEnv(port: number, ticketsDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Minimal base so node can locate itself and its user dirs.
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // Loopback ONLY. The standalone server binds HOSTNAME (default 0.0.0.0), so
    // this literal is what actually keeps the board off the network. HOST is set
    // too for good measure — HOSTNAME alone is what Next standalone honors.
    HOSTNAME: '127.0.0.1',
    HOST: '127.0.0.1',
    PORT: String(port),
    KODI_TICKETS_DIR: ticketsDir,
    NODE_ENV: 'production',
  };
  // Windows: node needs these to start.
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.APPDATA) env.APPDATA = process.env.APPDATA;
  }
  return env;
}

/** Validate a `--port` override: an integer in 1..65535. */
function parsePortOption(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`invalid --port "${raw}" (expected an integer 1..65535)`);
  }
  return n;
}

/**
 * Attach `serve` (alias `open`) UNDER the already-registered `tickets` command.
 * We look the `tickets` subcommand up from `program.commands` rather than
 * creating a second `program.command('tickets')` (commander would conflict).
 * `registerTicketsCommand` runs before us in index.ts, so it exists.
 */
export function registerServeCommand(program: Command): void {
  const tickets = program.commands.find((c) => c.name() === 'tickets');
  if (!tickets) {
    throw new Error('internal: `tickets` command must be registered before `serve`');
  }

  tickets
    .command('serve')
    .alias('open')
    .description('Launch the local board UI in the browser (read-only view of docs/tickets)')
    .option('--port <n>', 'bind the board to a specific port (default: an OS-picked free port)')
    .action(async (o) => {
      // 1. Normalized absolute tickets dir (closes KODI-009 trailing-slash note).
      const ticketsDir = resolve(localPaths(process.cwd()).root);

      // 2. Board entrypoint, package-relative only. Missing → clean exit, no stack.
      let serverJs: string;
      try {
        serverJs = resolveBoardServer();
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
        return;
      }

      // 3. Port: validated override or an OS-picked free port.
      const port = o.port !== undefined ? parsePortOption(String(o.port)) : await pickFreePort();

      const env = buildBoardEnv(port, ticketsDir);

      // 4. Spawn async under process.execPath, no shell. The board's STDOUT is
      //    ignored so Next's standalone startup banner (▲ Next.js / Local /
      //    Network / ✓ Ready) is suppressed — we print our own single
      //    "Board running at …" line once it's listening. STDERR stays inherited
      //    so real board errors still surface. Normal child (shares the CLI
      //    lifecycle) — never detached/unref (that is the orphan pattern).
      const child = spawn(process.execPath, [serverJs], {
        env,
        stdio: ['ignore', 'ignore', 'inherit'],
      });

      // 7/8. Stay foreground: the action promise stays pending while the board
      //      runs and resolves on teardown.
      await new Promise<void>((resolveAction) => {
        let settled = false;
        let shuttingDown = false;
        let overrideCode: number | null = null;
        let forceTimer: NodeJS.Timeout | undefined;

        const detachSignals = () => {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          process.off('exit', onProcessExit);
        };

        const finish = (code: number) => {
          if (settled) return;
          settled = true;
          if (forceTimer) clearTimeout(forceTimer);
          detachSignals();
          process.exitCode = code;
          resolveAction();
        };

        // Idempotent teardown (double Ctrl-C safe): SIGTERM, then SIGKILL after a
        // bounded grace. The child's 'exit' drives finish() with the right code.
        const shutdown = (code?: number) => {
          if (code !== undefined) overrideCode = code;
          if (shuttingDown) return;
          shuttingDown = true;
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            forceTimer = setTimeout(() => {
              // No-op if the child already died (kill on a dead pid is harmless).
              child.kill('SIGKILL');
            }, KILL_GRACE_MS);
            forceTimer.unref();
          } else {
            // Child already gone but no 'exit' yet handled — settle directly.
            finish(overrideCode ?? 0);
          }
        };

        const onSignal = () => shutdown();
        // Last-ditch safety: never let the board outlive the CLI (C-5).
        const onProcessExit = () => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        };

        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
        process.on('exit', onProcessExit);

        child.on('error', (err) => {
          process.stderr.write(`failed to start board server: ${err.message}\n`);
          finish(1);
        });

        child.on('exit', (code, signal) => {
          // Forward the child's exit code; a clean signal-kill (our teardown) is 0.
          const resolved = overrideCode ?? (code == null ? (signal ? 0 : 1) : code);
          finish(resolved);
        });

        // 5/6. Wait for LISTENING (bounded), then open the browser at the loopback
        //      literal + validated numeric port ONLY.
        waitForListen(port, LISTEN_TIMEOUT_MS, () => settled)
          .then(() => {
            if (settled) return;
            const url = `http://127.0.0.1:${port}`;
            process.stdout.write(`Board running at ${url}. To stop the server, press Ctrl+C.\n`);
            // KODI_NO_OPEN lets CI/integration tests disable the real browser
            // pop without mocking; the URL is still printed above.
            if (process.env.KODI_NO_OPEN) {
              process.stdout.write('KODI_NO_OPEN set — not opening a browser.\n');
              return;
            }
            openBrowser(url);
          })
          .catch(() => {
            if (settled) return;
            process.stderr.write('board server did not become ready — shutting down.\n');
            shutdown(1);
          });
      });
    });
}
