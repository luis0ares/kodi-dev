import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import spawn from 'cross-spawn';

/** Where the last check (and, on a stale day, the auto-update attempt) is
 * cached, so most invocations of any kodi subcommand do zero network I/O — one
 * check per day, ever, shared across every command. */
export function defaultCachePath(): string {
  return join(homedir(), '.kodi', 'update-check.json');
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  checkedAt: number;
  latest: string;
}

function readCache(path: string): UpdateCache | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof data?.latest === 'string' && typeof data?.checkedAt === 'number' ? data : null;
  } catch {
    return null;
  }
}

function writeCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), 'utf-8');
  } catch {
    // best-effort — a failed cache write must never break the command it's riding along with
  }
}

/** Compare two `major.minor.patch[-pre]` version strings on their numeric triple
 * only (pre-release/build suffixes are ignored — good enough for an update
 * check, not a real semver ordering). */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number(n) || 0);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

/** Fetch `<pkg>`'s latest published version from the npm registry. Capped at
 * 1.5s and never throws — offline / registry-down / timeout all resolve `null`
 * so this can never be the reason a command fails. */
async function fetchLatestFromNpm(pkgName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

/**
 * Install `<pkg>@latest` globally via `npm install -g` — the exact command
 * README tells end users to run by hand. Output is captured (never inherited),
 * so a self-update never clutters the command the user actually ran; returns
 * whether it succeeded.
 */
function autoInstall(pkgName: string, run: (args: string[]) => { status: number | null }): boolean {
  const r = run(['npm', 'install', '-g', `${pkgName}@latest`]);
  return r.status === 0;
}

function defaultRun(args: string[]): { status: number | null } {
  const [cmd, ...rest] = args;
  return spawn.sync(cmd, rest, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface UpdateCheckDeps {
  cachePath?: string;
  now?: () => number;
  fetchLatest?: (pkgName: string) => Promise<string | null>;
  run?: (args: string[]) => { status: number | null };
  /** Opt out of the network check entirely (e.g. `KODI_NO_AUTO_UPDATE`/`CI`). */
  disabled?: boolean;
}

/**
 * Self-update — every kodi subcommand calls this once, at the end of the run.
 * On a stale (>1 day old) cache, checks npm for the latest published version;
 * if newer, installs it directly (`npm install -g <pkg>@latest`) rather than
 * just telling the user to. Reports the outcome on STDERR (never stdout, so it
 * can't corrupt a `--json` consumer): updated, or — if the install itself
 * failed (no network, no npm, permissions, …) — a fallback "update manually"
 * reminder. Same-day re-invocations do zero network/install work. Deps are
 * injectable for tests, same injected-callback style `azure-discovery.ts`'s
 * `Runner` already uses.
 */
export async function checkForUpdate(
  pkgName: string,
  currentVersion: string,
  deps: UpdateCheckDeps = {},
): Promise<void> {
  if (deps.disabled) return;
  const cachePath = deps.cachePath ?? defaultCachePath();
  const now = deps.now ?? Date.now;
  const fetchLatest = deps.fetchLatest ?? fetchLatestFromNpm;
  const run = deps.run ?? defaultRun;

  const cached = readCache(cachePath);
  const stale = !cached || now() - cached.checkedAt > CHECK_INTERVAL_MS;
  if (!stale) return; // already handled today — updated, up to date, or a failed install we won't retry until tomorrow

  const latest = await fetchLatest(pkgName);
  if (!latest) return; // offline / registry unreachable — silent, try again next stale check
  writeCache(cachePath, { checkedAt: now(), latest });
  if (!isNewerVersion(latest, currentVersion)) return;

  if (autoInstall(pkgName, run)) {
    process.stderr.write(
      `\nkodi: updated ${currentVersion} -> ${latest}. The new version runs starting next time you run kodi.\n`,
    );
  } else {
    process.stderr.write(
      `\nkodi: update available ${currentVersion} -> ${latest}, but the automatic update failed — ` +
        `run \`npm install -g ${pkgName}@latest\` to update manually.\n`,
    );
  }
}
