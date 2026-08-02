import { describe, expect, it } from 'vitest';
import { readyFromActive } from '../src/providers/ready.js';
import type { TicketRef } from '../src/providers/types.js';
import type { TicketStatus } from '../src/templates/ticket.js';

function ref(key: string, status: TicketStatus, dependencies: string[] = []): TicketRef {
  return { key, title: `T ${key}`, status, slug: `t-${key.toLowerCase()}`, dependencies };
}

describe('readiness from a not-done listing', () => {
  it('blocks on a dependency that is still visible (i.e. not done)', () => {
    const res = readyFromActive([ref('1', 'Pending'), ref('2', 'Pending', ['1'])]);
    expect(res.ready.map((t) => t.key)).toEqual(['1']);
    expect(res.blocked).toEqual([{ ticket: expect.objectContaining({ key: '2' }), blockedBy: ['1'] }]);
  });

  it('treats a dependency the listing does not contain as satisfied', () => {
    // This is the inversion that lets a listing skip the Done column: KODI-001 is
    // absent because it is Done, and proving that would have cost a second fetch.
    const res = readyFromActive([ref('2', 'Pending', ['1'])]);
    expect(res.ready.map((t) => t.key)).toEqual(['2']);
    expect(res.blocked).toEqual([]);
  });

  it('reports only the unmet subset when a ticket has both kinds of dependency', () => {
    const res = readyFromActive([ref('2', 'Pending'), ref('3', 'Pending', ['1', '2'])]);
    expect(res.blocked[0].blockedBy).toEqual(['2']); // '1' is gone → satisfied
  });

  it('never blocks on a Done ticket handed in by an --all listing', () => {
    const res = readyFromActive([ref('1', 'Done'), ref('2', 'Pending', ['1'])]);
    expect(res.ready.map((t) => t.key)).toEqual(['2']);
    expect(res.blocked).toEqual([]);
  });

  it('considers only Pending tickets for readiness (started work is not "ready")', () => {
    const res = readyFromActive([ref('1', 'In progress'), ref('2', 'To review')]);
    expect(res.ready).toEqual([]);
    expect(res.blocked).toEqual([]);
  });
});
