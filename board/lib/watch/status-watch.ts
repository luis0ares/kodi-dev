// Server-side live-watch transport (KODI-013 / ADR-0002 §2.5).
//
// A module-level, ref-counted SINGLETON that watches the tickets DIRECTORY for
// `status.yaml` changes and fires subscriber listeners. It signals ONLY that
// "something changed" — it carries NO payload, reads NO file, and imports NO
// ticket/frontmatter reader (SC-1/SC-2). The SSE route re-reads via the server
// action after being poked.
//
// THE LOAD-BEARING RISK (ADR-0001 §2.4 / ADR-0002 §2.5): the CLI commits every
// `status.yaml` write via temp-then-rename — the file is REPLACED, not edited in
// place. A `fs.watch` bound to the status.yaml PATH/inode goes deaf after the
// first CLI move. So we watch the DIRECTORY (non-recursive) and treat `rename`
// (not just `change`) as a trigger. The directory watch is primary; an 'error'
// re-arm with bounded backoff plus a low-frequency mtime poll are the
// belt-and-suspenders fallback so repeated atomic renames can never leave the
// stream permanently deaf.
//
// SECURITY: the event `filename` is UNTRUSTED (SC-3/SC-4) and is NEVER passed to
// resolve/readFile/open or used as a watch target — the watch target is always
// the once-captured KODI_TICKETS_DIR constant. The filename is only compared, as
// a string, against the literal 'status.yaml'.

import { watch, type FSWatcher, statSync } from 'node:fs';

/** The file whose (re)creation/replacement inside the dir triggers a refresh. */
const STATUS_FILE = 'status.yaml';

/**
 * Trailing debounce window (ms). A single CLI move fires a burst (temp create,
 * rename, old unlink); one trailing timer coalesces the burst into ONE notify.
 * 300 ms is well inside S-4's "few seconds". Exported so tests can reference it.
 */
export const DEBOUNCE_MS = 300;

/**
 * Bounded backoff for re-arming the directory watch after an 'error'. Starts at
 * the floor and doubles up to the cap — never a tight loop (SC-12/SC-14).
 */
const REARM_MIN_MS = 500;
const REARM_MAX_MS = 10_000;

/**
 * Low-frequency mtime poll interval (ms). Belt-and-suspenders: even if the
 * directory watch silently dies, this catches a `status.yaml` change. Its floor
 * is >= the debounce window so it can never out-run the coalescing.
 */
const POLL_MS = 2_000;

type Listener = () => void;

const listeners = new Set<Listener>();

let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let rearmTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let rearmDelay = REARM_MIN_MS;
let lastMtimeMs = 0;

/**
 * The tickets directory, captured ONCE at first-arm from the env channel the CLI
 * sets (ADR-0002 §2.4). Never falls back to cwd or a default. If absent/empty/
 * whitespace the watch simply never arms and the stream stays idle (SR-7/SC-5).
 */
function ticketsDir(): string | null {
  const raw = process.env.KODI_TICKETS_DIR;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Schedule the single trailing notify. Coalesces a burst into one fire. */
function scheduleNotify(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(fire, DEBOUNCE_MS);
  // MUST NOT hold the process open — teardown/idle is driven by the SSE clients.
  debounceTimer.unref?.();
}

/** Fire: clear the timer, then poke every current subscriber. Carries no data. */
function fire(): void {
  debounceTimer = null;
  // Snapshot so a listener that unsubscribes mid-iteration can't corrupt it.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A misbehaving subscriber must never crash the watcher (SC-14).
    }
  }
}

/**
 * Handle a raw fs.watch event. `filename` may be a Buffer or null on some
 * platforms. Trigger when the normalized name is exactly 'status.yaml', OR when
 * it is null/unknown (treat as "re-check"). The filename is NEVER used as a path.
 */
function onEvent(_eventType: string, rawName: Buffer | string | null): void {
  if (rawName === null || rawName === undefined) {
    scheduleNotify();
    return;
  }
  const name = Buffer.isBuffer(rawName) ? rawName.toString('utf8') : rawName;
  if (name === STATUS_FILE) {
    scheduleNotify();
  }
}

/** Read status.yaml mtime for the poll fallback; missing file → 0 (idle). */
function readMtimeMs(dir: string): number {
  try {
    return statSync(`${dir}/${STATUS_FILE}`).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Belt-and-suspenders poll: if the mtime moved since we last saw it, poke the
 * debounce. Interval floor >= DEBOUNCE_MS so it can't out-race coalescing.
 */
function startPoll(dir: string): void {
  if (pollTimer !== null) return;
  lastMtimeMs = readMtimeMs(dir);
  pollTimer = setInterval(() => {
    const m = readMtimeMs(dir);
    if (m !== lastMtimeMs) {
      lastMtimeMs = m;
      scheduleNotify();
    }
  }, POLL_MS);
  pollTimer.unref?.();
}

/** Arm (or re-arm) the directory watch on the once-captured dir. */
function armWatch(dir: string): void {
  try {
    watcher = watch(dir, { recursive: false }, onEvent);
    // Success → reset backoff so a future error starts from the floor again.
    rearmDelay = REARM_MIN_MS;
    watcher.on('error', () => {
      // A watch error must never crash the process — tear the watcher down and
      // re-arm with bounded backoff (SC-12/SC-14). The poll keeps covering us
      // in the meantime.
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
      watcher = null;
      scheduleRearm(dir);
    });
  } catch {
    // Even the initial arm can throw (e.g. dir vanished mid-boot) — fall through
    // to a backoff re-arm rather than propagating.
    watcher = null;
    scheduleRearm(dir);
  }
}

/** Bounded-backoff re-arm timer (no tight loop). */
function scheduleRearm(dir: string): void {
  if (rearmTimer !== null || listeners.size === 0) return;
  const delay = rearmDelay;
  rearmDelay = Math.min(rearmDelay * 2, REARM_MAX_MS);
  rearmTimer = setTimeout(() => {
    rearmTimer = null;
    if (listeners.size > 0 && watcher === null) {
      armWatch(dir);
    }
  }, delay);
  rearmTimer.unref?.();
}

/** Bring the whole transport up on the first subscriber. */
function start(): void {
  const dir = ticketsDir();
  // Absent/empty/whitespace root → stay idle, never throw, never fall back to
  // cwd or a default (SR-7/SC-5). Subscribers still register; they just never
  // get poked until a root exists at a later start.
  if (dir === null) return;
  armWatch(dir);
  startPoll(dir);
}

/** Tear the whole transport down on the last unsubscribe (no leaked handles). */
function stop(): void {
  if (watcher !== null) {
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
    watcher = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (rearmTimer !== null) {
    clearTimeout(rearmTimer);
    rearmTimer = null;
  }
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  rearmDelay = REARM_MIN_MS;
  lastMtimeMs = 0;
}

/**
 * Subscribe to change signals. Arms the shared watch on the FIRST subscriber and
 * tears it fully down on the LAST unsubscribe (ref-counted). Returns an
 * idempotent unsubscribe fn.
 */
export function subscribe(listener: Listener): () => void {
  const isFirst = listeners.size === 0;
  listeners.add(listener);
  if (isFirst) {
    start();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop();
    }
  };
}

/**
 * Force full teardown regardless of ref-count (tests + server teardown). Drops
 * all subscribers and closes every handle/timer.
 */
export function dispose(): void {
  listeners.clear();
  stop();
}
