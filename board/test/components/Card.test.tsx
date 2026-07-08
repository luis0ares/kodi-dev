// @vitest-environment jsdom

// Card + TicketModal tests: the card FACE shows only identity (key + title) and the
// driver/dependency TAGS; every heavier §7 field is read in the Board-level modal
// opened on click (progressive disclosure via a dialog, §2.3). Covers §7-only
// rendering with absence-renders-nothing (R-013), empty-string-as-absent (`hasText`),
// keyboard operability, and the prUrl scheme allow-list at the modal render seam
// (security req 2).
//
// The modal is owned by <Board> (it holds the single selection state and mounts the
// one dialog), so modal behavior is asserted through a full Board render + a click,
// while the card face is asserted in isolation via `renderCard`.

import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Board } from '@/app/components/Board';
import { boardWith, makeTicket, renderCard } from './fixtures';

afterEach(cleanup);

const RICH = makeTicket({
  key: 'KODI-050',
  title: 'Rich ticket',
  status: 'In progress',
  dependencies: ['KODI-002', 'KODI-003'],
  drivers: { adr: ['ADR-0001'], prd: 'docs/prd.md', security: 'docs/security.md' },
  summary: 'Rich summary line.',
  acceptanceCriteria: ['Criterion A', 'Criterion B'],
  prUrl: 'https://example.com/pr/9',
  notes: 'Some notes here.',
});

/** Render a one-ticket Board, click the card, and return the opened dialog. */
async function openModal(ticket = RICH): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(<Board model={boardWith(ticket)} />);
  await user.click(screen.getByRole('button', { name: new RegExp(ticket.key) }));
  return screen.getByRole('dialog');
}

describe('Card face — shows ONLY identity + tags (heavy fields deferred to the modal)', () => {
  it('shows key, title and the dependency-count + security tags on the card button', () => {
    renderCard(RICH);
    const face = screen.getByRole('button');

    expect(within(face).getByText('KODI-050')).toBeInTheDocument();
    expect(within(face).getByText('Rich ticket')).toBeInTheDocument();
    expect(within(face).getByText('2 deps')).toBeInTheDocument();
    expect(within(face).getByText('SEC')).toBeInTheDocument();
  });

  it('does NOT show ADR/PRD chips on the card face (they live only in the modal)', () => {
    renderCard(RICH);
    const face = screen.getByRole('button');

    expect(within(face).queryByText('ADR')).toBeNull();
    expect(within(face).queryByText('PRD')).toBeNull();
  });

  it('keeps the summary and every heavy field OFF the card face', () => {
    renderCard(RICH);
    const face = screen.getByRole('button');

    // Summary now lives in the modal, not the card face.
    expect(within(face).queryByText('Rich summary line.')).toBeNull();
    // Heavy fields are not on the face either — and there is no dialog until a click.
    expect(within(face).queryByText('Criterion A')).toBeNull();
    expect(within(face).queryByText('KODI-002')).toBeNull();
    expect(within(face).queryByText('Some notes here.')).toBeNull();
    expect(within(face).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('TicketModal — opens on card click and reveals the heavy §7 fields', () => {
  it('has no dialog until the card is clicked, then shows the full detail', async () => {
    const dialog = await openModal();

    // Identity + summary header:
    expect(within(dialog).getByText('KODI-050')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Rich ticket' })).toBeInTheDocument();
    expect(within(dialog).getByText('Rich summary line.')).toBeInTheDocument();
    // The heavy fields the card face omitted:
    expect(within(dialog).getByText('KODI-002')).toBeInTheDocument();
    expect(within(dialog).getByText('KODI-003')).toBeInTheDocument();
    expect(within(dialog).getByText('ADR-0001')).toBeInTheDocument();
    expect(within(dialog).getByText('docs/prd.md')).toBeInTheDocument();
    expect(within(dialog).getByText('docs/security.md')).toBeInTheDocument();
    expect(within(dialog).getByText('Criterion A')).toBeInTheDocument();
    expect(within(dialog).getByText('Criterion B')).toBeInTheDocument();
    expect(within(dialog).getByText('Some notes here.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link')).toBeInTheDocument();
  });

  it('labels the dialog by its ticket title (aria-labelledby)', async () => {
    const dialog = await openModal();
    expect(dialog).toHaveAttribute('aria-labelledby', 'modal-title-KODI-050');
    const heading = within(dialog).getByRole('heading', { name: 'Rich ticket' });
    expect(heading).toHaveAttribute('id', 'modal-title-KODI-050');
  });

  it('closes when the ✕ button is clicked (dialog removed from the DOM)', async () => {
    const user = userEvent.setup();
    render(<Board model={boardWith(RICH)} />);
    await user.click(screen.getByRole('button', { name: /KODI-050/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens with Enter and with Space from the focused card', async () => {
    const user = userEvent.setup();
    render(<Board model={boardWith(RICH)} />);
    const face = screen.getByRole('button', { name: /KODI-050/ });

    face.focus();
    expect(face).toHaveFocus();
    await user.keyboard('[Enter]');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();

    screen.getByRole('button', { name: /KODI-050/ }).focus();
    await user.keyboard('[Space]');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('§7-only / absence renders nothing (R-013)', () => {
  it('renders no phantom chips on a bare card face and no phantom sections in its modal', async () => {
    const bare = makeTicket({ key: 'KODI-070' }); // no deps, no drivers, no prUrl, no notes
    const { container } = renderCard(bare);

    // Card face: no dependency chip, no driver chips.
    expect(screen.queryByText(/\d+\s*deps/)).toBeNull();
    expect(screen.queryByText('ADR')).toBeNull();
    expect(screen.queryByText('PRD')).toBeNull();
    expect(screen.queryByText('SEC')).toBeNull();
    expect(container.textContent).not.toMatch(/—|None|N\/A/);
    cleanup();

    // Modal: no absent-field sections, no link, no notes, no placeholder text.
    const dialog = await openModal(bare);
    expect(within(dialog).queryByText('Dependencies')).toBeNull();
    expect(within(dialog).queryByText('Security')).toBeNull();
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(within(dialog).queryByText('Notes')).toBeNull();
    expect(dialog.textContent).not.toMatch(/—|None|N\/A/);
  });

  it('never renders a phantom NG-1 field label on the card face or in the modal', async () => {
    const labels = [
      'priority',
      'phase',
      'created',
      'implementedAt',
      'branch',
      'lastCommit',
      'slug',
      'nonGoals',
    ];
    const { container } = renderCard(RICH);
    for (const label of labels) {
      expect(within(container).queryByText(new RegExp(label, 'i'))).toBeNull();
    }
    cleanup();

    const dialog = await openModal(RICH);
    for (const label of labels) {
      expect(within(dialog).queryByText(new RegExp(label, 'i'))).toBeNull();
    }
  });
});

describe('empty-string optional fields are treated as absent (hasText, §3)', () => {
  it('renders no summary, no prUrl link and no notes block for empty/whitespace strings', async () => {
    const dialog = await openModal(
      makeTicket({ key: 'KODI-080', summary: '  ', prUrl: '', notes: '   ' }),
    );
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(within(dialog).queryByText('Notes')).toBeNull();
  });
});

describe('prUrl scheme allow-list at the modal render seam (security req 2)', () => {
  it('renders NO anchor for a javascript: prUrl', async () => {
    const dialog = await openModal(makeTicket({ key: 'KODI-090', prUrl: 'javascript:alert(1)' }));
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(dialog.querySelector('a[href]')).toBeNull();
  });

  it('renders a safe https anchor with target=_blank, rel=noopener noreferrer, link-primary', async () => {
    const dialog = await openModal(
      makeTicket({ key: 'KODI-091', prUrl: 'https://example.com/pr/1' }),
    );
    const link = within(dialog).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/pr/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveClass('link-primary');
  });
});

describe('TicketModal — dependency navigation (recursive drill-down + Back)', () => {
  // A → B → C chain (each depends on the next); A also lists an off-board dep.
  const A = makeTicket({
    key: 'KODI-100',
    title: 'Parent',
    status: 'Pending',
    dependencies: ['KODI-101', 'KODI-999'], // 101 is on-board, 999 is not
  });
  const B = makeTicket({
    key: 'KODI-101',
    title: 'Child',
    status: 'To review',
    dependencies: ['KODI-102'],
  });
  const C = makeTicket({ key: 'KODI-102', title: 'Grandchild', status: 'Done' });

  /** Render the whole board and open A's modal. */
  async function openParent() {
    const user = userEvent.setup();
    render(<Board model={boardWith(A, B, C)} />);
    await user.click(screen.getByRole('button', { name: /KODI-100/ }));
    return user;
  }

  it('renders a resolvable dependency as a link and an off-board one as plain text', async () => {
    await openParent();
    const dialog = screen.getByRole('dialog');

    // KODI-101 is on the board → a clickable control; KODI-999 is not → plain text.
    expect(within(dialog).getByRole('button', { name: 'KODI-101' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'KODI-999' })).toBeNull();
    expect(within(dialog).getByText('KODI-999')).toBeInTheDocument();
    // At the root of the stack there is no Back control yet.
    expect(within(dialog).queryByRole('button', { name: '← Back' })).toBeNull();
  });

  it('drills A → B → C, then walks Back to the original ticket', async () => {
    const user = await openParent();
    const heading = () =>
      within(screen.getByRole('dialog')).getByRole('heading', { level: 2 }).textContent;

    expect(heading()).toBe('Parent');

    // Into B.
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'KODI-101' }));
    expect(heading()).toBe('Child');
    // Into C (B's dependency).
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'KODI-102' }));
    expect(heading()).toBe('Grandchild');

    // Back → B, Back → A.
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '← Back' }));
    expect(heading()).toBe('Child');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '← Back' }));
    expect(heading()).toBe('Parent');
    // Back control is gone again at the root.
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: '← Back' })).toBeNull();
  });

  it('opening a fresh card starts a new stack (no stale Back)', async () => {
    const user = await openParent();
    // Drill one level in, then close.
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'KODI-101' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '← Back' }));
    await user.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();

    // Re-open C directly from its card — a fresh stack, so no Back control.
    await user.click(screen.getByRole('button', { name: /KODI-102/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Grandchild');
    expect(within(dialog).queryByRole('button', { name: '← Back' })).toBeNull();
  });
});
