import { describe, expect, it } from 'vitest';
import {
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
