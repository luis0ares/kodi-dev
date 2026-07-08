// @vitest-environment jsdom

// live-update-ux — the KODI-014 live-update UX polish suite.
//
// This slice sits ON TOP of the KODI-013 SSE transport: a move is detected by
// ticket.key, the landed card runs a FLIP + a one-shot arrival highlight, and a
// SINGLE polite ARIA-live region announces the move. This file drives the REAL
// integrated live path (LiveBoard + a fake EventSource + a mocked getBoard) so the
// polish is exercised through the same render pipeline the browser uses — mirroring
// the existing LiveBoard.test.tsx patterns (FakeEventSource / COL / column()).
//
// jsdom scope (per the ticket): we assert CLASSES / ATTRIBUTES / live-region TEXT /
// STATE / TIMERS — never pixels. jsdom's getBoundingClientRect returns zeros, so the
// FLIP produces no measurable slide; that is expected and does not weaken the checks
// below (the arrival marker is the observable proxy that "the move was detected by
// key"). Determinism: fake timers drive BOTH the deferred requestAnimationFrame that
// dispatches the highlight/announcement AND the ~2s one-shot expiry.

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { boardWith, makeTicket } from './fixtures';
import type { BoardModel } from '@/lib/tickets/types';
import { STATUS_ARRIVE, prefersReducedMotion } from '@/app/components/ui';

// getBoard is the server read path (fs + 'use server'); mock it so the browser
// live path stays fs-free and the test owns exactly what a refetch returns.
vi.mock('@/app/actions/board', () => ({ getBoard: vi.fn() }));
import { getBoard } from '@/app/actions/board';
import { LiveBoard } from '@/app/components/LiveBoard';

const getBoardMock = vi.mocked(getBoard);

// --- Fake EventSource (jsdom has none). Same shape as LiveBoard.test.tsx: capture
// the URL, record listeners, allow a test-driven `change` emit.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<(e: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (e: Event) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb(new Event(type));
  }

  static get last(): FakeEventSource {
    const src = FakeEventSource.instances.at(-1);
    if (!src) throw new Error('no EventSource was constructed');
    return src;
  }
}

const originalEventSource = (globalThis as Record<string, unknown>).EventSource;

// The deferred highlight/announcement are dispatched inside a requestAnimationFrame
// within Board's useLayoutEffect; the ~2s expiry is a setTimeout. Fake BOTH rAF and
// setTimeout so we can flush the frame WITHOUT tripping the expiry, then advance to it.
const FRAME_MS = 32; // > one 16ms rAF frame, << ARRIVAL_MS
const ARRIVAL_MS = 2000;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
  FakeEventSource.instances = [];
  getBoardMock.mockReset();
  (globalThis as Record<string, unknown>).EventSource =
    FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  (globalThis as Record<string, unknown>).EventSource = originalEventSource;
  // jsdom ships no matchMedia; a test that installs one must not leak it.
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  vi.useRealTimers();
});

// --- Column addressing (fixed R-012 enum order), identical to LiveBoard.test.tsx.
const COL = { Pending: 0, 'In progress': 1, 'To review': 2, Done: 3 } as const;
function column(label: keyof typeof COL): HTMLElement {
  return screen.getAllByRole('group')[COL[label]];
}

/** The single visually-hidden polite live region (the board announcer). */
function liveRegion(container: HTMLElement): HTMLElement {
  const nodes = container.querySelectorAll<HTMLElement>('[aria-live="polite"]');
  expect(nodes).toHaveLength(1); // §5.3 — exactly ONE region for the whole board
  return nodes[0];
}

/** The keyed card <article> (the FLIP/arrival handle), or null if absent. */
function ticketNode(container: HTMLElement, key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-ticket-key="${key}"]`);
}

/**
 * Fire an SSE `change`, flush the getBoard() refetch → setModel re-render, THEN run
 * the deferred rAF that dispatches the arrival highlight + announcement — but not the
 * 2s expiry. Everything is wrapped in `act` so React commits each step.
 */
async function move(): Promise<void> {
  await act(async () => {
    FakeEventSource.last.emit('change');
    // Flush the getBoard() microtask chain (resolve → setModel).
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    // Run the deferred requestAnimationFrame (highlight + announcement). FRAME_MS is
    // well below ARRIVAL_MS, so the one-shot timer does NOT fire yet.
    vi.advanceTimersByTime(FRAME_MS);
  });
}

/** Advance past the one-shot window so the arrival highlight self-decays. */
async function expireArrival(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ARRIVAL_MS);
  });
}

/** Render the live wrapper and hand back the container for node lookups. */
function renderLive(initial: BoardModel) {
  return render(<LiveBoard initialModel={initial} />);
}

// ---------------------------------------------------------------------------
// 1. MOVE → TRANSITION BY KEY
// ---------------------------------------------------------------------------
describe('KODI-014 — move is tracked by ticket.key (transition, not recreate)', () => {
  it('re-parents the SAME keyed element to the new column and marks it arriving', async () => {
    const mover = makeTicket({ key: 'KODI-042', title: 'Wire it up', status: 'Pending' });
    const stayer = makeTicket({ key: 'KODI-007', title: 'Stays put', status: 'Done' });
    getBoardMock.mockResolvedValue(boardWith({ ...mover, status: 'Done' }, stayer));

    const { container } = renderLive(boardWith(mover, stayer));
    expect(within(column('Pending')).getByText('KODI-042')).toBeInTheDocument();

    await move();

    // Exactly ONE element keyed by KODI-042 (re-parented, not duplicated)...
    const nodes = container.querySelectorAll('[data-ticket-key="KODI-042"]');
    expect(nodes).toHaveLength(1);
    // ...now living in Done, still carrying its stable data-ticket-key...
    const moved = ticketNode(container, 'KODI-042')!;
    expect(within(column('Done')).getByText('KODI-042')).toBeInTheDocument();
    expect(moved.getAttribute('data-ticket-key')).toBe('KODI-042');
    // ...and marked arriving — the observable proxy for "the move was detected by key"
    // (the FLIP effect ran to completion without throwing).
    expect(moved).toHaveClass('kodi-arriving');

    // The card that did NOT change column gets NO arrival marker.
    const untouched = ticketNode(container, 'KODI-007')!;
    expect(untouched).not.toHaveClass('kodi-arriving');
  });
});

// ---------------------------------------------------------------------------
// 2. LIVE COLUMN COUNTS
// ---------------------------------------------------------------------------
describe('KODI-014 — column count badges track the move', () => {
  it('decrements the source column and increments the destination', async () => {
    const mover = makeTicket({ key: 'KODI-042', status: 'Pending' });
    getBoardMock.mockResolvedValue(boardWith({ ...mover, status: 'Done' }));

    renderLive(boardWith(mover));
    // Before: 1 in Pending, 0 in Done.
    expect(within(column('Pending')).getByText('1')).toBeInTheDocument();
    expect(within(column('Done')).getByText('0')).toBeInTheDocument();

    await move();

    // After: source decremented, destination incremented.
    expect(within(column('Pending')).getByText('0')).toBeInTheDocument();
    expect(within(column('Done')).getByText('1')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. ONE-SHOT ARRIVAL HIGHLIGHT (self-decays, no persistence, no alerting)
// ---------------------------------------------------------------------------
describe('KODI-014 — arrival highlight is a self-decaying one-shot', () => {
  it('applies kodi-arriving + the NEW column status tint, then removes it after ~2s', async () => {
    const mover = makeTicket({ key: 'KODI-042', status: 'Pending' });
    getBoardMock.mockResolvedValue(boardWith({ ...mover, status: 'Done' }));

    const { container } = renderLive(boardWith(mover));

    await move();

    const moved = ticketNode(container, 'KODI-042')!;
    // Right after the move: pulsing with the DESTINATION status tint (Done → success).
    expect(moved).toHaveClass('kodi-arriving');
    expect(moved).toHaveClass(STATUS_ARRIVE.Done); // 'arrive-success'
    expect(STATUS_ARRIVE.Done).toBe('arrive-success');

    await expireArrival();

    // The one-shot has decayed: the highlight classes are gone...
    const settled = ticketNode(container, 'KODI-042')!;
    expect(settled).not.toHaveClass('kodi-arriving');
    expect(settled).not.toHaveClass('arrive-success');
    // ...and NO persistent "changed"/"unread"/"arrived" flag lingers on the card
    // (the model carries no such field; the effect is view-state only).
    expect(settled.className).not.toMatch(/unread|changed|arrived/i);
    expect(settled.getAttribute('data-changed')).toBeNull();
    expect(settled.getAttribute('data-unread')).toBeNull();
    expect(settled.getAttribute('data-arrived')).toBeNull();
    // The card still lives in Done (the highlight decay did not move it back).
    expect(within(column('Done')).getByText('KODI-042')).toBeInTheDocument();
  });

  it('is confirmation, not alerting: no toast/dialog/alert role and no focus steal', async () => {
    const mover = makeTicket({ key: 'KODI-042', status: 'Pending' });
    getBoardMock.mockResolvedValue(boardWith({ ...mover, status: 'Done' }));

    renderLive(boardWith(mover));

    await move();

    // No interruptive surfaces are introduced by the arrival.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Focus is not yanked onto the landed card — it stays where it was (body).
    expect(document.activeElement).toBe(document.body);
  });
});

// ---------------------------------------------------------------------------
// 4. REDUCED-MOTION SWAP (static tint path, no JS FLIP transform)
// ---------------------------------------------------------------------------
describe('KODI-014 — prefers-reduced-motion honored', () => {
  it('still marks arriving + announces, but applies NO inline FLIP transform', async () => {
    // Report reduce:true for the media query the Board probes.
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: true,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    const mover = makeTicket({ key: 'KODI-042', status: 'Pending' });
    getBoardMock.mockResolvedValue(boardWith({ ...mover, status: 'Done' }));

    const { container } = renderLive(boardWith(mover));

    await move();

    const moved = ticketNode(container, 'KODI-042')!;
    // Static tint path still fires (globals.css keeps a static arrival tint here)...
    expect(moved).toHaveClass('kodi-arriving');
    expect(moved).toHaveClass('arrive-success');
    // ...the CSS-level guard class is present on the card whenever arriving...
    expect(moved).toHaveClass('motion-reduce:animate-none');
    // ...and the announcement is still made (reduced motion never mutes semantics)...
    expect(liveRegion(container)).toHaveTextContent('KODI-042 moved to Done.');
    // ...but the JS FLIP is guarded off: no inline transform is written.
    expect(moved.style.transform).toBe('');
  });

  it('prefersReducedMotion() reflects the mocked query and never throws', () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(true);

    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. ARIA LIVE REGION (single, polite, terse, combined for multi-move)
// ---------------------------------------------------------------------------
describe('KODI-014 — single polite ARIA-live announcer (§5.3)', () => {
  it('is silent on initial render (nothing has moved yet)', () => {
    getBoardMock.mockResolvedValue(boardWith());
    const { container } = renderLive(
      boardWith(makeTicket({ key: 'KODI-042', status: 'Pending' })),
    );
    const region = liveRegion(container);
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).not.toHaveAttribute('aria-live', 'assertive');
    expect(region.textContent).toBe('');
  });

  it('announces the terse verbatim "<KEY> moved to <Status>." on a single move', async () => {
    const mover = makeTicket({ key: 'KODI-042', status: 'Pending' });
    getBoardMock.mockResolvedValue(boardWith({ ...mover, status: 'Done' }));

    const { container } = renderLive(boardWith(mover));

    await move();

    const region = liveRegion(container);
    expect(region.textContent).toBe('KODI-042 moved to Done.');
    // Polite (confirmation), never assertive (alert).
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(container.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0);
  });

  it('combines a MULTI-move burst into ONE message in the SAME single region', async () => {
    const a = makeTicket({ key: 'KODI-001', status: 'Pending' });
    const b = makeTicket({ key: 'KODI-002', status: 'In progress' });
    // Both move in a single refetched model: A → To review, B → Done.
    getBoardMock.mockResolvedValue(
      boardWith({ ...a, status: 'To review' }, { ...b, status: 'Done' }),
    );

    const { container } = renderLive(boardWith(a, b));

    await move();

    // Still exactly one region (liveRegion asserts the count), holding both moves as
    // a single combined message (column-order: To review then Done).
    expect(liveRegion(container).textContent).toBe(
      'KODI-001 moved to To review. KODI-002 moved to Done.',
    );
  });

  it('does NOT announce when a card modal is merely opened (no move)', async () => {
    getBoardMock.mockResolvedValue(boardWith());
    const { container } = renderLive(
      boardWith(makeTicket({ key: 'KODI-042', status: 'Pending' })),
    );

    // Open the detail modal — a view-only change, not a column move.
    fireEvent.click(within(column('Pending')).getByRole('button'));
    // Flush any frame the (unchanged) layout effect might schedule.
    await act(async () => {
      vi.advanceTimersByTime(FRAME_MS);
    });

    expect(liveRegion(container).textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. THE OPEN DETAIL MODAL SURVIVES A MOVE, and coexists with the arrival highlight
// ---------------------------------------------------------------------------
describe('KODI-014 — the open detail modal survives a move (KODI-010 unregressed)', () => {
  it('keeps the dialog open across the move AND shows the arrival highlight together', async () => {
    const mover = makeTicket({ key: 'KODI-042', title: 'Wire it up', status: 'Pending' });
    getBoardMock.mockResolvedValue(boardWith({ ...mover, status: 'Done' }));

    const { container } = renderLive(boardWith(mover));

    // Open the detail modal while the card lives in Pending.
    fireEvent.click(within(column('Pending')).getByRole('button'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await move();

    // After the move: the dialog is STILL open (Board's selection state survived the
    // refetch), the card now lives in Done...
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(column('Done')).getByText('KODI-042')).toBeInTheDocument();
    expect(within(column('Pending')).queryByText('KODI-042')).toBeNull();
    // ...and the same card is simultaneously arriving — the two features coexist.
    expect(ticketNode(container, 'KODI-042')!).toHaveClass('kodi-arriving');
  });
});

// ---------------------------------------------------------------------------
// 7. matchMedia guard robustness (a missing API can't break the SSE render path)
// ---------------------------------------------------------------------------
describe('KODI-014 — prefersReducedMotion() is SSR/test-safe', () => {
  it('returns false and does NOT throw when window.matchMedia is absent', () => {
    // jsdom default: no matchMedia. Prove the probe degrades gracefully.
    expect('matchMedia' in window).toBe(false);
    expect(() => prefersReducedMotion()).not.toThrow();
    expect(prefersReducedMotion()).toBe(false);
  });

  it('returns false (never throws) when matchMedia itself throws', () => {
    window.matchMedia = vi.fn(() => {
      throw new Error('boom');
    }) as unknown as typeof window.matchMedia;
    expect(() => prefersReducedMotion()).not.toThrow();
    expect(prefersReducedMotion()).toBe(false);
  });

  it('drives a live move cleanly with matchMedia absent (no throw in the render path)', async () => {
    expect('matchMedia' in window).toBe(false);
    const mover = makeTicket({ key: 'KODI-042', status: 'Pending' });
    getBoardMock.mockResolvedValue(boardWith({ ...mover, status: 'Done' }));

    const { container } = renderLive(boardWith(mover));
    await move();

    // The move completed and the highlight applied despite no matchMedia.
    expect(ticketNode(container, 'KODI-042')!).toHaveClass('kodi-arriving');
    expect(liveRegion(container).textContent).toBe('KODI-042 moved to Done.');
  });
});
