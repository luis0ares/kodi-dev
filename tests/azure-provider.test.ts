import { describe, expect, it } from 'vitest';
import { mdToHtml } from '../src/html.js';
import {
  createArgs,
  descriptionHtml,
  parseWorkItem,
  STATUS_COLUMN,
} from '../src/providers/azure.js';
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

describe('markdown → html', () => {
  it('converts headings, lists, and bold; passes the kodi marker through', () => {
    const html = mdToHtml('# Title\n\n- a\n- b\n\n**bold** text\n<!-- kodi:ticket {} -->');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<!-- kodi:ticket {} -->');
  });
});

describe('azure provider — command construction', () => {
  it('builds a create command with org and project', () => {
    const args = createArgs({ organization: 'https://dev.azure.com/acme', project: 'Proj' }, 'T', '<p>x</p>', 'AI Generated');
    expect(args.slice(0, 6)).toEqual(['az', 'boards', 'work-item', 'create', '--title', 'T']);
    expect(args).toContain('System.BoardColumn=AI Generated');
    expect(args).toContain('--organization');
    expect(args).toContain('https://dev.azure.com/acme');
    expect(args).toContain('Proj');
  });

  it('maps statuses to board columns', () => {
    expect(STATUS_COLUMN['Pending']).toBe('AI Generated');
    expect(STATUS_COLUMN['To review']).toBe('To Review');
    expect(STATUS_COLUMN['Done']).toBe('Done');
  });
});

describe('azure provider — description round-trip', () => {
  it('embeds and recovers the canonical ticket via the marker', () => {
    const t = stored();
    const desc = descriptionHtml(t);
    const back = parseWorkItem(
      { 'System.Description': desc, 'System.BoardColumn': 'In Progress' },
      7,
    );
    expect(back).not.toBeNull();
    expect(back!.key).toBe('7');
    expect(back!.title).toBe('Add dataset import');
    expect(back!.dependencies).toEqual(['42']);
    expect(back!.status).toBe('In progress'); // derived from the board column
  });

  it('returns null when there is no marker', () => {
    expect(parseWorkItem({ 'System.Description': '<p>plain</p>' }, 1)).toBeNull();
  });
});
