// Server-side live-watch transport (KODI-013 / ADR-0002 §2.5) — watcher unit +
// integration tests. Exercises the ref-counted singleton `status-watch` against a
// REAL on-disk KODI_TICKETS_DIR, driving it exactly the way the CLI does:
// temp-then-rename atomic replacement of `status.yaml` (ADR-0001 §2.4).
//
// node environment (vitest default) — no jsdom docblock: this is node-fs code.
//
// Test hygiene: the watcher is a MODULE-LEVEL singleton. Each test sets
// KODI_TICKETS_DIR BEFORE its first `subscribe()` (start() captures it then) and
// afterEach forces `dispose()` so no watcher/timer state leaks between tests.

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEBOUNCE_MS, dispose, subscribe } from '@/lib/watch/status-watch';
import { cleanup, makeTicketsRoot, statusYaml, ticketEntry } from './fixtures';

const ORIGINAL = process.env.KODI_TICKETS_DIR;
const roots: string[] = [];

function setEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.KODI_TICKETS_DIR;
  else process.env.KODI_TICKETS_DIR = value;
}

/** A fresh, tracked tickets root (cleaned up in afterEach). */
function freshRoot(): string {
  const root = makeTicketsRoot();
  roots.push(root);
  return root;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a predicate until true or the timeout elapses — no fixed sleeps. */
async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await delay(20);
  }
  return pred();
}

/**
 * Replace `<root>/status.yaml` the way the CLI does (ADR-0001 §2.4): write to a
 * temp sibling, then `renameSync` OVER the target. This REPLACES the file (new
 * inode) — the case a path/inode-bound fs.watch goes deaf on after the 1st move.
 */
function atomicWriteStatus(root: string, text: string): void {
  const tmp = join(root, 'status.yaml.tmp');
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, join(root, 'status.yaml'));
}

/** A distinct-content status.yaml so each replacement also moves mtime. */
function statusFor(n: number): string {
  return statusYaml(ticketEntry(`KODI-${String(100 + n).padStart(3, '0')}`, 'Pending'));
}

/** Count live FSWatcher handles attributable to node's fs.watch (best-effort). */
function fsWatcherCount(): number {
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (typeof getHandles !== 'function') return 0;
  try {
    return getHandles
      .call(process)
      .filter((h) => (h as { constructor?: { name?: string } })?.constructor?.name === 'FSWatcher').length;
  } catch {
    return 0;
  }
}

afterEach(() => {
  dispose();
  while (roots.length > 0) cleanup(roots.pop() as string);
  setEnv(ORIGINAL);
});

describe('status-watch — the deaf-watch regression (mandatory, ADR-0001 §2.4)', () => {
  it('fires on the 1st, 2nd AND 3rd temp-then-rename replacement (no deaf-watch after the first move)', async () => {
    const root = freshRoot();
    setEnv(root);

    let count = 0;
    const unsubscribe = subscribe(() => {
      count += 1;
    });
    // Give fs.watch a beat to arm before the first atomic write.
    await delay(150);

    // Each wait is bounded BELOW the 2 s mtime-poll fallback so a pass is
    // attributable to the directory-watch + rename trigger (fast, ~debounce),
    // NOT the belt-and-suspenders poll — this is what proves the deaf-watch fix.
    const WATCH_WINDOW = 1500; // > DEBOUNCE_MS, < POLL_MS (2000)

    // Replacement #1 — the watcher must fire (debounced) after the first move.
    let prev = count;
    atomicWriteStatus(root, statusFor(1));
    expect(await waitUntil(() => count > prev, WATCH_WINDOW)).toBe(true);
    expect(count).toBeGreaterThan(prev);

    // Replacement #2 — CRITICAL: a path/inode watch would be DEAF here. Dir-watch
    // + rename-trigger must still fire.
    prev = count;
    atomicWriteStatus(root, statusFor(2));
    expect(await waitUntil(() => count > prev, WATCH_WINDOW)).toBe(true);
    expect(count).toBeGreaterThan(prev);

    // Replacement #3 — still alive after repeated atomic replacements.
    prev = count;
    atomicWriteStatus(root, statusFor(3));
    expect(await waitUntil(() => count > prev, WATCH_WINDOW)).toBe(true);
    expect(count).toBeGreaterThan(prev);

    expect(count).toBeGreaterThanOrEqual(3);
    unsubscribe();
  });
});

describe('status-watch — debounce coalescing (DEBOUNCE_MS)', () => {
  it('DEBOUNCE_MS is 300', () => {
    expect(DEBOUNCE_MS).toBe(300);
  });

  it('coalesces a burst of rapid replacements within the window into exactly ONE notify', async () => {
    const root = freshRoot();
    setEnv(root);

    let count = 0;
    const unsubscribe = subscribe(() => {
      count += 1;
    });
    await delay(150); // let the watch arm

    // Fire a BURST: several temp-then-rename writes back-to-back, well inside the
    // 300 ms window. Each move emits multiple fs events; all must coalesce.
    for (let i = 0; i < 6; i += 1) {
      atomicWriteStatus(root, statusFor(i));
    }

    // Wait for the single trailing fire...
    expect(await waitUntil(() => count >= 1, 1500)).toBe(true);
    // ...then let it settle (> DEBOUNCE_MS, still comfortably before the 2 s poll)
    // and assert the burst produced exactly ONE notify, not one per fs event.
    await delay(DEBOUNCE_MS + 150);
    expect(count).toBe(1);

    unsubscribe();
  });
});

describe('status-watch — teardown / no leaked handles or timers', () => {
  it('stops notifying after the last unsubscribe and tears the watcher down', async () => {
    const baseWatchers = fsWatcherCount();
    const root = freshRoot();
    setEnv(root);

    let count = 0;
    const unsubscribe = subscribe(() => {
      count += 1;
    });
    await delay(150);

    atomicWriteStatus(root, statusFor(1));
    expect(await waitUntil(() => count >= 1)).toBe(true);
    const afterFirst = count;

    // Last unsubscribe → ref-count 0 → full teardown.
    unsubscribe();

    // A rewrite after teardown must produce NO further notification.
    atomicWriteStatus(root, statusFor(2));
    await delay(DEBOUNCE_MS + 400);
    expect(count).toBe(afterFirst);

    // No FSWatcher handle attributable to the watcher should linger.
    expect(fsWatcherCount()).toBeLessThanOrEqual(baseWatchers);

    // dispose() is idempotent (safe to over-call in teardown paths).
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });

  it('dispose() clears ALL subscribers (a fresh subscribe re-arms from ref-count 0)', async () => {
    const root = freshRoot();
    setEnv(root);

    subscribe(() => undefined);
    subscribe(() => undefined);
    dispose(); // must drop every subscriber and stop the transport

    // If dispose truly cleared subscribers, ref-count is 0, so the next subscribe
    // is "first" and re-arms start() — observable as a live fire on a new write.
    let count = 0;
    const unsubscribe = subscribe(() => {
      count += 1;
    });
    await delay(150);
    atomicWriteStatus(root, statusFor(9));
    expect(await waitUntil(() => count >= 1)).toBe(true);

    unsubscribe();
  });
});

describe('status-watch — absent/whitespace KODI_TICKETS_DIR → idle, no throw (SR-7/SC-5)', () => {
  it('unset env: subscribe never throws, never fires, unsubscribe still works, no cwd fallback', async () => {
    const root = freshRoot(); // a real status.yaml exists, but env is UNSET
    setEnv(undefined);

    let count = 0;
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = subscribe(() => {
        count += 1;
      });
    }).not.toThrow();

    await delay(200);
    atomicWriteStatus(root, statusFor(1)); // no watcher armed → must not fire
    await delay(DEBOUNCE_MS + 400);
    expect(count).toBe(0);

    expect(() => unsubscribe?.()).not.toThrow();
  });

  it('whitespace-only env: stays idle, never fires', async () => {
    const root = freshRoot();
    setEnv('   \t  ');

    let count = 0;
    const unsubscribe = subscribe(() => {
      count += 1;
    });
    await delay(200);
    atomicWriteStatus(root, statusFor(1));
    await delay(DEBOUNCE_MS + 400);
    expect(count).toBe(0);

    unsubscribe();
  });
});
