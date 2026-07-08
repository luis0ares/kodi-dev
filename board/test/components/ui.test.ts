// Unit tests for the shared presentational helpers (`app/components/ui.ts`):
// the prUrl scheme allow-list (`safeHttpUrl`, security req 2), the empty/blank
// absence gate (`hasText`, §3), and the status→daisyUI color maps (§4) incl.
// the reserved-`primary` invariant. These are pure functions with no DOM, so
// this file stays in the default `node` environment (no jsdom docblock).

import { describe, expect, it } from 'vitest';
import { STATUS_BADGE, STATUS_LEFT, STATUS_TOP, hasText, safeHttpUrl } from '@/app/components/ui';
import { TICKET_STATUSES } from '@/lib/tickets/types';

describe('safeHttpUrl — prUrl scheme allow-list (security req 2)', () => {
  it('accepts http: and https: URLs', () => {
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
    expect(safeHttpUrl('https://github.com/org/repo/pull/7')).toBe(
      'https://github.com/org/repo/pull/7',
    );
  });

  it('trims surrounding whitespace before validating', () => {
    expect(safeHttpUrl('  https://example.com/pr  ')).toBe('https://example.com/pr');
  });

  it('rejects the javascript: scheme (XSS vector)', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects the data: scheme', () => {
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects the vbscript: scheme', () => {
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects the file: scheme', () => {
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects protocol-relative //host URLs', () => {
    expect(safeHttpUrl('//evil.example.com/pr')).toBeNull();
  });

  it('rejects garbage / non-URL text', () => {
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl('ftp://example.com')).toBeNull();
  });

  it('treats empty / whitespace / null / undefined as absent', () => {
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl('   ')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});

describe('hasText — empty/blank optional strings are absent (§3)', () => {
  it('is true for a string with visible content', () => {
    expect(hasText('x')).toBe(true);
    expect(hasText('  padded  ')).toBe(true);
  });

  it('is false for empty, whitespace-only, null, and undefined', () => {
    expect(hasText('')).toBe(false);
    expect(hasText('   ')).toBe(false);
    expect(hasText('\n\t ')).toBe(false);
    expect(hasText(null)).toBe(false);
    expect(hasText(undefined)).toBe(false);
  });
});

describe('status → daisyUI color maps (§4)', () => {
  it('maps each status to its documented count-badge color', () => {
    expect(STATUS_BADGE).toEqual({
      Pending: 'badge-neutral',
      'In progress': 'badge-info',
      'To review': 'badge-warning',
      Done: 'badge-success',
      Blocked: 'badge-error',
    });
  });

  it('maps each status to its documented top/left edge colors', () => {
    expect(STATUS_TOP).toEqual({
      Pending: 'border-t-neutral',
      'In progress': 'border-t-info',
      'To review': 'border-t-warning',
      Done: 'border-t-success',
      Blocked: 'border-t-error',
    });
    expect(STATUS_LEFT).toEqual({
      Pending: 'border-l-neutral',
      'In progress': 'border-l-info',
      'To review': 'border-l-warning',
      Done: 'border-l-success',
      Blocked: 'border-l-error',
    });
  });

  it('covers exactly the five canonical statuses', () => {
    expect(Object.keys(STATUS_BADGE).sort()).toEqual([...TICKET_STATUSES].sort());
  });

  it('never assigns the reserved `primary` color to any status (§4)', () => {
    const all = [
      ...Object.values(STATUS_BADGE),
      ...Object.values(STATUS_TOP),
      ...Object.values(STATUS_LEFT),
    ];
    for (const cls of all) {
      expect(cls).not.toContain('primary');
    }
  });
});
