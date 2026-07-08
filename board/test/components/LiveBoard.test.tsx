// @vitest-environment jsdom

// LiveBoard — the CLIENT live-wiring wrapper (KODI-013 / ADR-0002 §2.5).
//
// This slice is the FUNCTIONAL transport: the browser opens a same-origin
// EventSource to /events, and on each bare `change` trigger it refetches the
// model via the getBoard() server action and re-renders the pure <Board> — a
// plain re-render, no page refresh, no Board remount. This suite proves exactly
// that transport contract:
//
//   • initial render off the server-fetched initialModel prop (no refetch yet);
//   • an SSE `change` → getBoard() refetch → live re-render under the new model
//     (S-4 core outcome — a moved ticket lands in its new column w/o refresh);
//   • the EventSource URL is the RELATIVE same-origin '/events' (SC-15), never a
//     baked absolute host;
//   • the client handle is closed on unmount (no leaked EventSource);
//   • cards stay keyed by ticket.key across a live update — an expanded card's
//     identity follows its key to a new column (KODI-010 not regressed).
//
// OUT OF SCOPE (KODI-014): move transitions, arrival highlight, ARIA-live region,
// prefers-reduced-motion. This suite deliberately tests none of that polish.
//
// The browser never touches fs here — getBoard is mocked (it is the server-side
// read path). jsdom has no EventSource, so a controllable fake is installed on
// globalThis and the test manually dispatches `change`.

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boardWith, makeTicket } from './fixtures';

// --- getBoard mock: the test owns what the refetch returns, and can assert it
// was called. The real module is 'use server' + fs; mocking keeps the browser
// path fs-free and deterministic.
vi.mock('@/app/actions/board', () => ({ getBoard: vi.fn() }));
import { getBoard } from '@/app/actions/board';
import { LiveBoard } from '@/app/components/LiveBoard';

const getBoardMock = vi.mocked(getBoard);

// --- Fake EventSource (jsdom has none). Captures the constructed URL, records
// listeners, tracks close(), and lets the test dispatch a `change` event.
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

  /** Test-only: dispatch a stream event to the wired listeners. */
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

beforeEach(() => {
  FakeEventSource.instances = [];
  getBoardMock.mockReset();
  (globalThis as Record<string, unknown>).EventSource =
    FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  (globalThis as Record<string, unknown>).EventSource = originalEventSource;
});

/** The five §7 columns render in fixed enum order — index into that order. */
const COL = { Pending: 0, 'In progress': 1, 'To review': 2, Done: 3, Blocked: 4 } as const;

/** The section (role="group") for a column, by its fixed render position. */
function column(label: keyof typeof COL): HTMLElement {
  return screen.getAllByRole('group')[COL[label]];
}

/** Dispatch a `change` on the live stream and flush the async refetch → setState. */
async function dispatchChange(): Promise<void> {
  await act(async () => {
    FakeEventSource.last.emit('change');
  });
}

describe('LiveBoard — initial render off the server-fetched initialModel', () => {
  it('renders <Board> with initialModel and does NOT refetch on mount', () => {
    getBoardMock.mockResolvedValue(boardWith());
    const initial = boardWith(makeTicket({ key: 'KODI-042', title: 'Wire it up', status: 'Pending' }));

    render(<LiveBoard initialModel={initial} />);

    // The ticket shows in its initial column, straight from the prop.
    expect(within(column('Pending')).getByText('KODI-042')).toBeInTheDocument();
    // Mount opens the stream but performs no read until a change arrives.
    expect(getBoardMock).not.toHaveBeenCalled();
  });
});

describe('LiveBoard — SSE `change` drives a live re-render (S-4)', () => {
  it('refetches via getBoard and re-renders the fresh model without a refresh', async () => {
    const moved = makeTicket({ key: 'KODI-042', title: 'Wire it up', status: 'Pending' });
    const initial = boardWith(moved);
    // The stream is a bare trigger; the fresh model comes only from getBoard().
    const next = boardWith({ ...moved, status: 'Done' });
    getBoardMock.mockResolvedValue(next);

    render(<LiveBoard initialModel={initial} />);
    // Before any change: the card lives in Pending, nothing in Done.
    expect(within(column('Pending')).getByText('KODI-042')).toBeInTheDocument();
    expect(within(column('Done')).queryByText('KODI-042')).toBeNull();

    await dispatchChange();

    // The change caused exactly one server read...
    expect(getBoardMock).toHaveBeenCalledTimes(1);
    // ...and the board re-rendered under the new model: the card is now in Done.
    await waitFor(() => {
      expect(within(column('Done')).getByText('KODI-042')).toBeInTheDocument();
    });
    // ...and no longer in Pending. Same document, no navigation/refresh.
    expect(within(column('Pending')).queryByText('KODI-042')).toBeNull();
  });
});

describe('LiveBoard — same-origin relative stream URL (SC-15)', () => {
  it('opens the EventSource with the relative "/events", not an absolute host', () => {
    getBoardMock.mockResolvedValue(boardWith());
    render(<LiveBoard initialModel={boardWith()} />);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last.url).toBe('/events');
    // Guard against a baked absolute host regression.
    expect(FakeEventSource.last.url).not.toMatch(/^https?:\/\//);
  });
});

describe('LiveBoard — cleanup on unmount (no leaked client handle)', () => {
  it('closes the EventSource when unmounted', () => {
    getBoardMock.mockResolvedValue(boardWith());
    const { unmount } = render(<LiveBoard initialModel={boardWith()} />);

    const source = FakeEventSource.last;
    expect(source.closed).toBe(false);

    unmount();

    expect(source.closed).toBe(true);
  });
});

describe('LiveBoard — key-based rendering preserved across a live update (KODI-010)', () => {
  it('keeps a card keyed by ticket.key: expansion follows the key to its new column', async () => {
    const ticket = makeTicket({ key: 'KODI-042', title: 'Wire it up', status: 'Pending' });
    const initial = boardWith(ticket);
    const next = boardWith({ ...ticket, status: 'Done' });
    getBoardMock.mockResolvedValue(next);

    render(<LiveBoard initialModel={initial} />);

    // Expand the card while it lives in Pending (Board owns the key-indexed
    // expansion registry — §5.4).
    const user = userEvent.setup();
    const disclosure = within(column('Pending')).getByRole('button');
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');

    await dispatchChange();

    // After the live update the card is in Done AND still expanded: the
    // Board did not remount (its registry survived) and the card's identity
    // tracked its ticket.key to the new column.
    await waitFor(() => {
      expect(within(column('Done')).getByText('KODI-042')).toBeInTheDocument();
    });
    const movedButton = within(column('Done')).getByRole('button');
    expect(movedButton).toHaveAttribute('aria-expanded', 'true');
    // The old column no longer holds the card.
    expect(within(column('Pending')).queryByText('KODI-042')).toBeNull();
  });
});
