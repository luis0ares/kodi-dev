import { describe, expect, it } from 'vitest';
import {
  canonicalizeTicketKey,
  renderTicketMarkdown,
  slugify,
  TicketSchema,
  type StoredTicket,
} from '../src/templates/ticket.js';

describe('ticket template', () => {
  it('applies defaults and validates a minimal draft', () => {
    const t = TicketSchema.parse({
      title: 'Add dataset import',
      summary: 'Users can import a dataset from CSV.',
      acceptanceCriteria: ['CSV upload works', 'Rows are validated'],
    });
    expect(t.status).toBe('Pending');
    expect(t.dependencies).toEqual([]);
    expect(t.drivers.adr).toEqual([]);
  });

  it('rejects a draft with no acceptance criteria', () => {
    const r = TicketSchema.safeParse({ title: 'X ok', summary: 'y', acceptanceCriteria: [] });
    expect(r.success).toBe(false);
  });

  it('rejects a too-short title', () => {
    const r = TicketSchema.safeParse({ title: 'ab', summary: 'y', acceptanceCriteria: ['z'] });
    expect(r.success).toBe(false);
  });

  it('slugifies titles into kebab-case', () => {
    expect(slugify('Add Dataset Import!')).toBe('add-dataset-import');
    expect(slugify('  Wizard — Screens  ')).toBe('wizard-screens');
  });

  it('canonicalizes prefixed dependency keys so hand-typed refs resolve', () => {
    // unpadded / mis-padded / lowercase all fold to the generated key form
    expect(canonicalizeTicketKey('KODI-1')).toBe('KODI-001');
    expect(canonicalizeTicketKey('kodi-42')).toBe('KODI-042');
    expect(canonicalizeTicketKey('KODI-0007')).toBe('KODI-007');
    expect(canonicalizeTicketKey('  KODI-3  ')).toBe('KODI-003');
    // already-canonical and wide numbers are unchanged
    expect(canonicalizeTicketKey('KODI-001')).toBe('KODI-001');
    expect(canonicalizeTicketKey('KODI-1000')).toBe('KODI-1000');
  });

  it('leaves bare numeric ids and free-form refs untouched (github/azure safe)', () => {
    expect(canonicalizeTicketKey('42')).toBe('42'); // github issue / azure work-item id
    expect(canonicalizeTicketKey('#7')).toBe('#7');
    expect(canonicalizeTicketKey('N/A')).toBe('N/A');
    expect(canonicalizeTicketKey('see AUTH board')).toBe('see AUTH board');
  });

  it('normalizes dependency keys when parsing a draft through the template path', () => {
    // the CLI maps this over draft.dependencies; verify the helper composes with a real key
    const t = TicketSchema.parse({
      title: 'Dependent task',
      summary: 'y',
      acceptanceCriteria: ['z'],
      dependencies: ['KODI-2'],
    });
    expect(t.dependencies.map(canonicalizeTicketKey)).toEqual(['KODI-002']);
  });

  it('renders a readable markdown body', () => {
    const t: StoredTicket = {
      key: 'KODI-001',
      slug: 'add-dataset-import',
      title: 'Add dataset import',
      status: 'Pending',
      summary: 'Import a dataset from CSV.',
      acceptanceCriteria: ['CSV upload works'],
      nonGoals: ['No XLSX'],
      dependencies: ['KODI-000'],
      drivers: { adr: ['docs/adr/0002'], prd: 'docs/prd/0001' },
    };
    const md = renderTicketMarkdown(t);
    expect(md).toContain('# KODI-001 — Add dataset import');
    expect(md).toContain('**Status:** Pending');
    expect(md).toContain('**Depends on:** KODI-000');
    expect(md).toContain('- [ ] CSV upload works');
    expect(md).toContain('## Non-goals');
  });
});
