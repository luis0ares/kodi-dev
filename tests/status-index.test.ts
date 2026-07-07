import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  composeFile,
  emptyDocument,
  load,
  parse,
  remove,
  resolveFile,
  save,
  serialize,
  slugForStatus,
  statusForSlug,
  upsert,
  type StatusIndexDocument,
} from '../src/providers/status-index.js';
import { TICKET_STATUSES, type TicketStatus } from '../src/templates/ticket.js';

let dir: string;
let statusYaml: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kodi-status-index-'));
  statusYaml = join(dir, 'docs', 'tickets', 'status.yaml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build a document by upserting the given placements (exercises the real API). */
function docWith(placements: ReadonlyArray<{ key: string; column: TicketStatus; slug: string }>) {
  const doc = emptyDocument();
  for (const p of placements) upsert(doc, p);
  return doc;
}

/** Strip the null-prototype so structural matchers compare values cleanly. */
function plain(doc: StatusIndexDocument): unknown {
  return JSON.parse(JSON.stringify(doc));
}

describe('status-index — constants & frozen slug map (SR-1, data-model §3)', () => {
  it('pins the schema version at 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('slugForStatus maps all five statuses to their frozen slug', () => {
    expect(slugForStatus('Pending')).toBe('pending');
    expect(slugForStatus('In progress')).toBe('in-progress');
    expect(slugForStatus('To review')).toBe('to-review');
    expect(slugForStatus('Done')).toBe('done');
    expect(slugForStatus('Blocked')).toBe('blocked');
  });

  it('statusForSlug inverts all five slugs', () => {
    expect(statusForSlug('pending')).toBe('Pending');
    expect(statusForSlug('in-progress')).toBe('In progress');
    expect(statusForSlug('to-review')).toBe('To review');
    expect(statusForSlug('done')).toBe('Done');
    expect(statusForSlug('blocked')).toBe('Blocked');
  });

  it('statusForSlug returns undefined for legacy/unknown slugs', () => {
    expect(statusForSlug('backlog')).toBeUndefined();
    expect(statusForSlug('Pending')).toBeUndefined();
    expect(statusForSlug('')).toBeUndefined();
    expect(statusForSlug('nope')).toBeUndefined();
  });

  it('the slug map is a total round-trip over the frozen status list', () => {
    for (const status of TICKET_STATUSES) {
      expect(statusForSlug(slugForStatus(status))).toBe(status);
    }
  });
});

describe('status-index — composeFile (data-model §2, SR-1)', () => {
  it('composes <folder-slug>/<KEY>-<slug>.md across statuses', () => {
    expect(composeFile('To review', 'KODI-001', 'add-dataset-import')).toBe(
      'to-review/KODI-001-add-dataset-import.md',
    );
    expect(composeFile('Pending', 'KODI-007', 'export-csv')).toBe('pending/KODI-007-export-csv.md');
    expect(composeFile('Blocked', 'KODI-002', 'parse-headers')).toBe(
      'blocked/KODI-002-parse-headers.md',
    );
    expect(composeFile('In progress', 'KODI-010', 'x')).toBe('in-progress/KODI-010-x.md');
    expect(composeFile('Done', 'ABC-42', 'a1-b2')).toBe('done/ABC-42-a1-b2.md');
  });

  it('always emits POSIX separators', () => {
    expect(composeFile('Pending', 'KODI-1', 'a')).not.toContain('\\');
  });

  it('SR-1: rejects malformed ticket keys (validate-before-compose)', () => {
    for (const badKey of ['kodi-1', 'KODI-', 'KODI', '../etc', '1KODI-1', 'KODI 1', '']) {
      expect(() => composeFile('Pending', badKey, 'ok-slug')).toThrow();
    }
  });

  it('SR-1: rejects malformed slugs (validate-before-compose)', () => {
    for (const badSlug of [
      'Bad_Slug',
      'has space',
      'trailing-',
      '-leading',
      'a--b',
      'a/b',
      '..',
      '.',
      'a.b',
      '',
    ]) {
      expect(() => composeFile('Pending', 'KODI-1', badSlug)).toThrow();
    }
  });
});

describe('status-index — serialization determinism (headline AC, data-model §1/§7)', () => {
  it('emits ticket keys lexicographically regardless of insertion order', () => {
    const doc = docWith([
      { key: 'KODI-010', column: 'Pending', slug: 'ten' },
      { key: 'KODI-002', column: 'In progress', slug: 'two' },
      { key: 'KODI-001', column: 'To review', slug: 'one' },
    ]);
    const text = serialize(doc);
    const i1 = text.indexOf('KODI-001:');
    const i2 = text.indexOf('KODI-002:');
    const i10 = text.indexOf('KODI-010:');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i10);
  });

  it('is byte-stable: same input serializes identically', () => {
    const doc = docWith([
      { key: 'KODI-003', column: 'Done', slug: 'c' },
      { key: 'KODI-001', column: 'Pending', slug: 'a' },
    ]);
    expect(serialize(doc)).toBe(serialize(doc));
  });

  it('is insertion-order independent: two build orders yield the identical string', () => {
    const a = docWith([
      { key: 'KODI-010', column: 'Pending', slug: 'ten' },
      { key: 'KODI-002', column: 'Blocked', slug: 'two' },
      { key: 'KODI-001', column: 'To review', slug: 'one' },
    ]);
    const b = docWith([
      { key: 'KODI-001', column: 'To review', slug: 'one' },
      { key: 'KODI-002', column: 'Blocked', slug: 'two' },
      { key: 'KODI-010', column: 'Pending', slug: 'ten' },
    ]);
    expect(serialize(a)).toBe(serialize(b));
  });

  it('round-trips: parse(serialize(doc)) preserves the normalized doc', () => {
    const doc = docWith([
      { key: 'KODI-002', column: 'Blocked', slug: 'parse-headers' },
      { key: 'KODI-001', column: 'To review', slug: 'add-dataset-import' },
    ]);
    const back = parse(serialize(doc));
    expect(plain(back)).toEqual(plain(doc));
    expect(back.columns).toEqual([...TICKET_STATUSES]);
  });

  it('format: single trailing LF newline, no CR, POSIX file separators', () => {
    const doc = docWith([{ key: 'KODI-001', column: 'Pending', slug: 'x' }]);
    const text = serialize(doc);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\\');
  });

  it('format: version 1 and the five columns in frozen order', () => {
    const text = serialize(emptyDocument());
    expect(text).toContain('version: 1');
    const order = TICKET_STATUSES.map((s) => text.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(parse(text).columns).toEqual([...TICKET_STATUSES]);
  });

  it('shape: each ticket entry carries exactly column + file (no phantom keys)', () => {
    const doc = docWith([{ key: 'KODI-001', column: 'Pending', slug: 'x' }]);
    const back = parse(serialize(doc));
    for (const key of Object.keys(back.tickets)) {
      expect(Object.keys(back.tickets[key]).sort()).toEqual(['column', 'file']);
    }
  });

  it('matches the data-model §7 example shape for a known small doc', () => {
    const doc = docWith([
      { key: 'KODI-001', column: 'To review', slug: 'add-dataset-import' },
      { key: 'KODI-002', column: 'Blocked', slug: 'parse-headers' },
      { key: 'KODI-007', column: 'Pending', slug: 'export-csv' },
    ]);
    const text = serialize(doc);
    expect(text).toContain('column: To review');
    expect(text).toContain('file: to-review/KODI-001-add-dataset-import.md');
    expect(text).toContain('file: blocked/KODI-002-parse-headers.md');
    expect(text).toContain('file: pending/KODI-007-export-csv.md');
  });
});

describe('status-index — resolveFile containment & invariants (SR-2, I2/I4)', () => {
  it('happy path: resolves inside the tickets root ending in the relative pointer', () => {
    const resolved = resolveFile(statusYaml, 'KODI-007', {
      column: 'Pending',
      file: 'pending/KODI-007-export-csv.md',
    });
    const root = join(dir, 'docs', 'tickets');
    expect(resolved).toBe(join(root, 'pending', 'KODI-007-export-csv.md'));
    expect(resolved.startsWith(root)).toBe(true);
  });

  it('SR-2: rejects traversal / escaping pointers', () => {
    const cases: string[] = [
      '../evil.md',
      '/etc/passwd',
      'C:\\x',
      'pending\\KODI-007-export-csv.md',
      '\\\\host\\share\\x.md',
      'pending/../pending/KODI-007-export-csv.md',
      '',
    ];
    for (const file of cases) {
      expect(() => resolveFile(statusYaml, 'KODI-007', { column: 'Pending', file })).toThrow();
    }
  });

  it('I2: rejects when the folder segment disagrees with the column', () => {
    expect(() =>
      resolveFile(statusYaml, 'KODI-007', {
        column: 'Done',
        file: 'pending/KODI-007-export-csv.md',
      }),
    ).toThrow();
  });

  it('I4: rejects when the <KEY> segment differs from the map key', () => {
    expect(() =>
      resolveFile(statusYaml, 'KODI-007', {
        column: 'Pending',
        file: 'pending/KODI-999-export-csv.md',
      }),
    ).toThrow();
  });

  it('rejects a malformed key argument', () => {
    expect(() =>
      resolveFile(statusYaml, 'kodi-7', { column: 'Pending', file: 'pending/kodi-7-x.md' }),
    ).toThrow();
  });
});

describe('status-index — upsert / remove / version gate (SR-4)', () => {
  it('upsert adds an entry with file composed from column + key + slug', () => {
    const doc = emptyDocument();
    upsert(doc, { key: 'KODI-001', column: 'Pending', slug: 'add-dataset-import' });
    expect(doc.tickets['KODI-001']).toEqual({
      column: 'Pending',
      file: 'pending/KODI-001-add-dataset-import.md',
    });
  });

  it('upsert on the same key updates column AND keeps file in sync', () => {
    const doc = emptyDocument();
    upsert(doc, { key: 'KODI-001', column: 'Pending', slug: 'add-dataset-import' });
    upsert(doc, { key: 'KODI-001', column: 'To review', slug: 'add-dataset-import' });
    expect(doc.tickets['KODI-001']).toEqual({
      column: 'To review',
      file: 'to-review/KODI-001-add-dataset-import.md',
    });
    expect(Object.keys(doc.tickets)).toEqual(['KODI-001']);
  });

  it('remove drops the entry', () => {
    const doc = docWith([{ key: 'KODI-001', column: 'Pending', slug: 'x' }]);
    remove(doc, 'KODI-001');
    expect(doc.tickets['KODI-001']).toBeUndefined();
    expect(Object.keys(doc.tickets)).toEqual([]);
  });

  it('SR-4: upsert and remove refuse an unsupported schema version', () => {
    const doc: StatusIndexDocument = {
      version: 2,
      columns: [...TICKET_STATUSES],
      tickets: Object.create(null) as StatusIndexDocument['tickets'],
    };
    expect(() => upsert(doc, { key: 'KODI-001', column: 'Pending', slug: 'x' })).toThrow();
    expect(() => remove(doc, 'KODI-001')).toThrow();
  });
});

describe('status-index — parse safety (SR-3)', () => {
  it('drops __proto__/constructor keys and does not pollute Object.prototype', () => {
    const text = [
      'version: 1',
      'columns: [Pending, In progress, To review, Done, Blocked]',
      'tickets:',
      '  __proto__:',
      '    column: Pending',
      '    file: pending/x.md',
      '  constructor:',
      '    column: Pending',
      '    file: pending/y.md',
      '  KODI-001:',
      '    column: Pending',
      '    file: pending/KODI-001-x.md',
      '',
    ].join('\n');
    const result = parse(text);
    expect(Object.getPrototypeOf(result.tickets)).toBeNull();
    expect(Object.keys(result.tickets)).toEqual(['KODI-001']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).column).toBeUndefined();
  });

  it('drops keys that do not match the ticket-key regex', () => {
    const text = [
      'version: 1',
      'tickets:',
      '  not-a-key:',
      '    column: Pending',
      '    file: pending/z.md',
      '  KODI-002:',
      '    column: Pending',
      '    file: pending/KODI-002-z.md',
      '',
    ].join('\n');
    expect(Object.keys(parse(text).tickets)).toEqual(['KODI-002']);
  });

  it('drops malformed entries (missing field or non-status column)', () => {
    const text = [
      'version: 1',
      'tickets:',
      '  KODI-003:',
      '    file: pending/KODI-003-a.md',
      '  KODI-004:',
      '    column: Nonsense',
      '    file: nonsense/KODI-004-a.md',
      '  KODI-005:',
      '    column: Pending',
      '    file: pending/KODI-005-a.md',
      '',
    ].join('\n');
    expect(Object.keys(parse(text).tickets)).toEqual(['KODI-005']);
  });

  it('returns an empty-shaped doc for non-object YAML', () => {
    const result = parse('null\n');
    expect(Object.keys(result.tickets)).toEqual([]);
    expect(result.columns).toEqual([...TICKET_STATUSES]);
  });
});

describe('status-index — load / save disk round-trip (mkdtemp, SR-5)', () => {
  it('save then load returns an equal document', () => {
    const doc = docWith([
      { key: 'KODI-002', column: 'Blocked', slug: 'parse-headers' },
      { key: 'KODI-001', column: 'To review', slug: 'add-dataset-import' },
    ]);
    save(statusYaml, doc);
    expect(plain(load(statusYaml))).toEqual(plain(doc));
  });

  it('on-disk content equals serialize(doc) byte-for-byte', () => {
    const doc = docWith([{ key: 'KODI-001', column: 'Pending', slug: 'x' }]);
    save(statusYaml, doc);
    expect(readFileSync(statusYaml, 'utf-8')).toBe(serialize(doc));
  });

  it('leaves no .tmp file behind after a successful save', () => {
    const doc = docWith([{ key: 'KODI-001', column: 'Pending', slug: 'x' }]);
    save(statusYaml, doc);
    expect(existsSync(`${statusYaml}.tmp`)).toBe(false);
  });

  it('load of a non-existent path returns an emptyDocument', () => {
    const missing = join(dir, 'nope', 'status.yaml');
    expect(plain(load(missing))).toEqual(plain(emptyDocument()));
  });

  it('load reads back a hand-written status.yaml', () => {
    const doc = docWith([{ key: 'KODI-009', column: 'Done', slug: 'ship-it' }]);
    writeFileSync(join(dir, 'status.yaml'), serialize(doc));
    expect(plain(load(join(dir, 'status.yaml')))).toEqual(plain(doc));
  });
});
