// @vitest-environment jsdom

// Board-level component tests: the five fixed columns + order (R-012), per-column
// live count + status color (§4), the in-column vs board-level empty registers
// (§7 registers 1 & 2), and the read-only invariant (R-014 — no mutation surface,
// disclosure buttons are the only interactive controls).

import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Board } from '@/app/components/Board';
import { ORDERED_LABELS, boardWith, emptyBoardModel, makeTicket } from './fixtures';

afterEach(cleanup);

/** The count `badge` inside a column section (the tinted §2.2 accent). */
function badgeIn(section: HTMLElement): HTMLElement {
  const badge = section.querySelector('.badge');
  if (!badge) throw new Error('column has no count badge');
  return badge as HTMLElement;
}

describe('Board — five fixed columns in enum order (R-012)', () => {
  it('renders all five verbatim status labels, always, in fixed order', () => {
    // Some columns populated, some empty — order must NOT follow the data.
    const model = boardWith(
      makeTicket({ key: 'KODI-001', status: 'Pending' }),
      makeTicket({ key: 'KODI-002', status: 'Pending' }),
      makeTicket({ key: 'KODI-003', status: 'Done' }),
    );
    render(<Board model={model} />);

    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([...ORDERED_LABELS]);
  });

  it('renders every column even when empty, with a live count badge', () => {
    const model = boardWith(
      makeTicket({ key: 'KODI-001', status: 'Pending' }),
      makeTicket({ key: 'KODI-002', status: 'Pending' }),
      makeTicket({ key: 'KODI-003', status: 'Done' }),
    );
    render(<Board model={model} />);

    const sections = screen.getAllByRole('group');
    expect(sections).toHaveLength(5);

    const expectedCounts = ['2', '0', '0', '1', '0'];
    sections.forEach((section, i) => {
      const heading = within(section).getByRole('heading', { level: 2 });
      expect(heading).toHaveTextContent(ORDERED_LABELS[i]);
      expect(badgeIn(section)).toHaveTextContent(expectedCounts[i]);
    });
  });

  it('shows the quiet in-column "No tickets" placeholder for empty columns only', () => {
    const model = boardWith(makeTicket({ key: 'KODI-001', status: 'Pending' }));
    render(<Board model={model} />);

    // Four empty columns → four in-column placeholders (register 1).
    expect(screen.getAllByText('No tickets')).toHaveLength(4);
    // The populated Pending column shows no placeholder.
    const pending = screen.getAllByRole('group')[0];
    expect(within(pending).queryByText('No tickets')).toBeNull();
  });
});

describe('Board — status → color mapping on the count badge (§4)', () => {
  it('tints each column badge and top edge with its status color', () => {
    render(<Board model={emptyBoardModel()} />);
    const sections = screen.getAllByRole('group');

    const badgeColors = ['badge-neutral', 'badge-info', 'badge-warning', 'badge-success', 'badge-error'];
    const topColors = ['border-t-neutral', 'border-t-info', 'border-t-warning', 'border-t-success', 'border-t-error'];

    sections.forEach((section, i) => {
      expect(badgeIn(section)).toHaveClass(badgeColors[i]);
      expect(section).toHaveClass(topColors[i]);
    });
  });

  it('uses no reserved-`primary` btn/badge anywhere on the board (§4)', () => {
    const { container } = render(
      boardTree(makeTicket({ key: 'KODI-001', prUrl: 'https://example.com/pr/1' })),
    );
    expect(container.querySelector('.btn-primary')).toBeNull();
    expect(container.querySelector('.badge-primary')).toBeNull();
  });
});

describe('Board — empty-board register (§7 register 2) is distinct from register 1', () => {
  it('shows the board-level "No tickets yet." hint naming `kodi tickets create`', () => {
    render(<Board model={emptyBoardModel()} />);

    const hint = screen.getByRole('status');
    expect(hint).toHaveTextContent('No tickets yet.');
    expect(hint).toHaveTextContent('kodi tickets create');
    // Informational, NOT error-styled — must not look like register 4.
    expect(hint.className).not.toContain('alert-error');
    // Register 1 placeholders still render in each of the five empty columns.
    expect(screen.getAllByText('No tickets')).toHaveLength(5);
  });

  it('does NOT show the board-level hint when any column has a ticket', () => {
    render(<Board model={boardWith(makeTicket({ key: 'KODI-001', status: 'Blocked' }))} />);
    expect(screen.queryByText('No tickets yet.')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Board — read-only (R-014): no mutation surface', () => {
  it('renders no form and no mutation inputs; only disclosure buttons are interactive', async () => {
    const model = boardWith(
      makeTicket({ key: 'KODI-001', status: 'Pending', prUrl: 'https://example.com/pr/1' }),
      makeTicket({ key: 'KODI-002', status: 'Done' }),
    );
    const { container } = render(<Board model={model} />);

    // Expand a card so any hidden mutation control would surface.
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button')[0]);

    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    // The ONLY buttons are disclosure controls (each carries aria-expanded).
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const btn of buttons) {
      expect(btn).toHaveAttribute('aria-expanded');
    }
  });
});

/** Small helper: render a one-ticket Board and return its element for container queries. */
function boardTree(ticket: ReturnType<typeof makeTicket>) {
  return <Board model={boardWith(ticket)} />;
}
