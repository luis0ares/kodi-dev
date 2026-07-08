// @vitest-environment jsdom

// Card component tests: progressive disclosure (§2.3, collapsed→expanded, keyed
// to ticket.key, keyboard-operable), §7-only rendering with absence-renders-
// nothing (R-013), empty-string-as-absent (`hasText`), the prUrl scheme
// allow-list at the render seam (security req 2), and the degraded KODI-009
// placeholder card.
//
// NOTE ON THE DISCLOSURE MECHANISM: the Card uses daisyUI `collapse`, so the
// expanded region (`collapse-content`) is ALWAYS in the DOM and its visibility
// is toggled by the `collapse-open`/`collapse-close` class on the <article>
// (the mandated §2.3 externally-controlled pattern). Progressive disclosure is
// therefore asserted via `aria-expanded` + that open/close class + WHERE each
// field lives (collapsed header vs. disclosure region) — not via DOM presence,
// which would misread the library's CSS-gated reveal. Fields that are ABSENT
// are conditionally unrendered, so those are asserted by true DOM absence.

import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Board } from '@/app/components/Board';
import { boardWith, makeTicket, renderCard } from './fixtures';

afterEach(cleanup);

/** The always-present disclosure region for a card, by ticket.key. */
function regionFor(key: string): HTMLElement {
  const region = document.getElementById(`card-content-${key}`);
  if (!region) throw new Error(`no disclosure region for ${key}`);
  return region;
}

/** The <article> shell whose collapse-open/close class gates the reveal. */
function articleFor(button: HTMLElement): HTMLElement {
  const article = button.closest('article');
  if (!article) throw new Error('card button has no <article> ancestor');
  return article;
}

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

describe('Card — collapsed scan unit shows only the §2.3 collapsed contract', () => {
  it('shows key, title, summary, dep-count badge and driver-presence chips in the header', () => {
    renderCard(RICH, false);
    const header = screen.getByRole('button');

    expect(within(header).getByText('KODI-050')).toBeInTheDocument();
    expect(within(header).getByText('Rich ticket')).toBeInTheDocument();
    expect(within(header).getByText('Rich summary line.')).toBeInTheDocument();
    expect(within(header).getByText('2 deps')).toBeInTheDocument();
    expect(within(header).getByText('ADR')).toBeInTheDocument();
    expect(within(header).getByText('PRD')).toBeInTheDocument();
    expect(within(header).getByText('SEC')).toBeInTheDocument();
  });

  it('keeps the heavy fields OUT of the collapsed header and IN the disclosure region', () => {
    renderCard(RICH, false);
    const header = screen.getByRole('button');
    const region = regionFor('KODI-050');

    // Not in the always-visible collapsed header:
    expect(within(header).queryByText('Criterion A')).toBeNull();
    expect(within(header).queryByText('KODI-002')).toBeNull();
    expect(within(header).queryByText('Some notes here.')).toBeNull();
    expect(within(header).queryByRole('link')).toBeNull();

    // Present in the disclosure region (revealed on expand):
    expect(within(region).getByText('Criterion A')).toBeInTheDocument();
    expect(within(region).getByText('Criterion B')).toBeInTheDocument();
    expect(within(region).getByText('KODI-002')).toBeInTheDocument();
    expect(within(region).getByText('KODI-003')).toBeInTheDocument();
    expect(within(region).getByText('Some notes here.')).toBeInTheDocument();
    expect(within(region).getByRole('link')).toBeInTheDocument();
  });
});

describe('Card — progressive disclosure (aria + collapse state)', () => {
  it('wires aria-controls to the disclosure region id', () => {
    renderCard(RICH, false);
    const header = screen.getByRole('button');
    expect(header).toHaveAttribute('aria-controls', 'card-content-KODI-050');
    expect(regionFor('KODI-050')).toBeInTheDocument();
  });

  it('flips aria-expanded and the collapse-open/close class on click', async () => {
    const user = userEvent.setup();
    render(<Board model={boardWith(RICH)} />);
    const header = screen.getByRole('button');
    const article = articleFor(header);

    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(article).toHaveClass('collapse-close');
    expect(article).not.toHaveClass('collapse-open');

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(article).toHaveClass('collapse-open');
    expect(article).not.toHaveClass('collapse-close');

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(article).toHaveClass('collapse-close');
  });

  it('is keyboard-operable with Enter and Space', async () => {
    const user = userEvent.setup();
    render(<Board model={boardWith(RICH)} />);
    const header = screen.getByRole('button');

    header.focus();
    expect(header).toHaveFocus();

    await user.keyboard('[Enter]');
    expect(header).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('[Space]');
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('keys expansion to ticket.key — expanding one card leaves a different key collapsed', async () => {
    const user = userEvent.setup();
    render(
      <Board
        model={boardWith(RICH, makeTicket({ key: 'KODI-060', title: 'Other', status: 'Done' }))}
      />,
    );

    const buttons = screen.getAllByRole('button');
    const byKey = (key: string) =>
      buttons.find((b) => b.getAttribute('aria-controls') === `card-content-${key}`)!;

    await user.click(byKey('KODI-050'));

    expect(byKey('KODI-050')).toHaveAttribute('aria-expanded', 'true');
    expect(articleFor(byKey('KODI-050'))).toHaveClass('collapse-open');
    expect(byKey('KODI-060')).toHaveAttribute('aria-expanded', 'false');
    expect(articleFor(byKey('KODI-060'))).toHaveClass('collapse-close');
  });
});

describe('Card — §7-only / absence renders nothing (R-013)', () => {
  it('renders no phantom chips, sections, links, notes or "—/None/N/A" for a bare card', () => {
    const bare = makeTicket({ key: 'KODI-070' }); // no deps, no drivers, no prUrl, no notes
    const { container } = renderCard(bare, true);

    // No dependency chip or Dependencies section:
    expect(screen.queryByText(/\d+\s*deps/)).toBeNull();
    expect(screen.queryByText('Dependencies')).toBeNull();
    // No driver chips or driver value sections:
    expect(screen.queryByText('ADR')).toBeNull();
    expect(screen.queryByText('PRD')).toBeNull();
    expect(screen.queryByText('SEC')).toBeNull();
    expect(screen.queryByText('Security')).toBeNull();
    // No prUrl link, no Notes block:
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Notes')).toBeNull();
    // No placeholder/filler text anywhere:
    expect(container.textContent).not.toMatch(/—|None|N\/A/);
  });

  it('never renders a phantom NG-1 field label (priority/phase/created/…) on any card', () => {
    // Assert on BOTH a rich card and a bare card.
    for (const ticket of [RICH, makeTicket({ key: 'KODI-071' })]) {
      const { container, unmount } = renderCard(ticket, true);
      for (const label of [
        'priority',
        'phase',
        'created',
        'implementedAt',
        'branch',
        'lastCommit',
        'slug',
        'nonGoals',
      ]) {
        expect(within(container).queryByText(new RegExp(label, 'i'))).toBeNull();
      }
      unmount();
    }
  });
});

describe('Card — empty-string optional fields are treated as absent (hasText, §3)', () => {
  it('renders no prUrl link and no notes block when both are empty/whitespace strings', () => {
    renderCard(makeTicket({ key: 'KODI-080', prUrl: '', notes: '   ' }), true);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Notes')).toBeNull();
  });
});

describe('Card — prUrl scheme allow-list at the render seam (security req 2)', () => {
  it('renders NO anchor for a javascript: prUrl', () => {
    const { container } = renderCard(
      makeTicket({ key: 'KODI-090', prUrl: 'javascript:alert(1)' }),
      true,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('a[href]')).toBeNull();
  });

  it('renders a safe https anchor with target=_blank, rel=noopener noreferrer, link-primary', () => {
    renderCard(makeTicket({ key: 'KODI-091', prUrl: 'https://example.com/pr/1' }), true);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/pr/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveClass('link-primary');
  });
});

describe('Card — degraded KODI-009 placeholder card (defensive absence)', () => {
  it('renders no empty summary line and no acceptance section when both are empty', () => {
    renderCard(makeTicket({ key: 'KODI-099', summary: '', acceptanceCriteria: [] }), true);
    const header = screen.getByRole('button');

    // The summary line uses `.line-clamp-2`; with an empty summary it is omitted.
    expect(header.querySelector('.line-clamp-2')).toBeNull();
    // No acceptance-criteria section when the list is empty.
    expect(screen.queryByText('Acceptance criteria')).toBeNull();
    // The identity anchor still renders.
    expect(within(header).getByText('KODI-099')).toBeInTheDocument();
  });
});
