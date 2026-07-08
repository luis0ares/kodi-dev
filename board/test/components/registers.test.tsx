// @vitest-environment jsdom

// The two non-happy render registers that live in their own Next segment files
// (§7): the loading skeleton (register 5) and the read-error register (register
// 4). Assert each is present, correctly styled, and — for the error register —
// that the raw exception message / fs path is NEVER echoed into the UI
// (security req 4: generic copy only).

import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import Loading from '@/app/loading';
import ErrorDefault from '@/app/error';
import { asComponent } from './fixtures';

afterEach(cleanup);

// error.tsx is a Next error boundary segment; type it so the test may pass the
// { error, reset } props Next injects at runtime.
const ErrorScreen = asComponent<{ error: Error; reset: () => void }>(ErrorDefault);

describe('Loading register (§7 register 5) — skeleton frames, not a spinner', () => {
  it('renders five skeleton column frames and no spinner', () => {
    const { container } = render(<Loading />);

    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThanOrEqual(5);

    // A spinner-only screen is explicitly disallowed.
    expect(container.querySelector('.loading-spinner')).toBeNull();
    expect(container.querySelector('.loading')).toBeNull();

    // Five column frames in the same 5-track grid shape as the board.
    expect(container.querySelector('.grid-cols-5')).toBeInTheDocument();
  });
});

describe('Read-error register (§7 register 4) — problem-styled, no leaked details', () => {
  it('renders the generic problem-styled alert copy', () => {
    render(<ErrorScreen error={new Error('boom')} reset={() => {}} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't read the board.");
    // Problem-styled — distinct from the informational empty registers.
    expect(alert).toHaveClass('alert-error');
  });

  it('never echoes the raw error message / fs path / stack (security req 4)', () => {
    const secret = '/home/luis0ares/dynac/secret/status.yaml: EACCES boom-stack-frame';
    const { container } = render(
      <ErrorScreen error={new Error(secret)} reset={() => {}} />,
    );

    expect(container.textContent).not.toContain(secret);
    expect(container.textContent).not.toContain('/home/luis0ares');
    expect(container.textContent).not.toContain('EACCES');
    expect(container.textContent).not.toContain('boom-stack-frame');
    // Only the generic copy is shown.
    expect(container.textContent).toContain("Couldn't read the board.");
  });
});
