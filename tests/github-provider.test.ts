import { describe, expect, it } from 'vitest';
import {
  createArgs,
  parseIssue,
  serializeBody,
  STATUS_LABEL,
} from '../src/providers/github.js';
import { TicketSchema, type StoredTicket } from '../src/templates/ticket.js';

function stored(over: Record<string, unknown> = {}): StoredTicket {
  const t = TicketSchema.parse({
    title: 'Add dataset import',
    summary: 'Import a dataset from CSV.',
    acceptanceCriteria: ['CSV upload works'],
    dependencies: ['42'],
    ...over,
  });
  return { ...t, key: '7', slug: t.slug ?? 'add-dataset-import' };
}

describe('github provider — command construction', () => {
  it('builds a create command with repo and label', () => {
    expect(createArgs('owner/repo', 'My title', '/tmp/body.md', 'kodi:pending')).toEqual([
      'gh', 'issue', 'create', '--title', 'My title', '--body-file', '/tmp/body.md',
      '--label', 'kodi:pending', '--repo', 'owner/repo',
    ]);
  });

  it('omits repo and label when not provided', () => {
    expect(createArgs(undefined, 'T', '/b.md')).toEqual([
      'gh', 'issue', 'create', '--title', 'T', '--body-file', '/b.md',
    ]);
  });

  it('maps non-done statuses to labels', () => {
    expect(STATUS_LABEL['Pending']).toBe('kodi:pending');
    expect(STATUS_LABEL['In progress']).toBe('kodi:in-progress');
    expect(STATUS_LABEL['To review']).toBe('kodi:to-review');
  });
});

describe('github provider — body round-trip', () => {
  it('serializes and parses a ticket losslessly (open issue)', () => {
    const t = stored();
    const body = serializeBody(t);
    expect(body).toContain('<!-- kodi:ticket');
    const back = parseIssue({ number: 7, state: 'OPEN', body });
    expect(back).not.toBeNull();
    expect(back!.key).toBe('7');
    expect(back!.title).toBe('Add dataset import');
    expect(back!.dependencies).toEqual(['42']);
    expect(back!.status).toBe('Pending');
  });

  it('derives Done from a closed issue', () => {
    const t = stored();
    const back = parseIssue({ number: 7, state: 'CLOSED', body: serializeBody(t) });
    expect(back!.status).toBe('Done');
  });

  it('returns null for an issue without the kodi marker', () => {
    expect(parseIssue({ number: 1, state: 'OPEN', body: 'just a normal issue' })).toBeNull();
  });
});
