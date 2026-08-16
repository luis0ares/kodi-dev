import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDocsProvider } from '../src/providers/local-docs.js';

const TYPES = ['prd', 'adr', 'security'];

let dir: string;
let provider: LocalDocsProvider;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kodi-docs-test-'));
  provider = new LocalDocsProvider(TYPES, dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalDocsProvider', () => {
  it('creates a doc under docs/<type>/<NNNN>-<slug>.md with valid frontmatter', async () => {
    const doc = await provider.create('prd', {
      name: 'Document Handling',
      description: 'In-platform viewer',
      body: '# PRD 0001\n',
    });
    expect(doc.id).toBe('PRD-0001');
    const path = join(dir, 'docs', 'prd', '0001-document-handling.md');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('name: Document Handling');
    expect(raw).toContain('type: prd');
    expect(raw).toContain('# PRD 0001');
  });

  it('auto-increments the id per type, independent of other types', async () => {
    await provider.create('prd', { name: 'A', description: 'a', body: 'x' });
    await provider.create('prd', { name: 'B', description: 'b', body: 'x' });
    const c = await provider.create('adr', { name: 'C', description: 'c', body: 'x' });
    expect(c.id).toBe('ADR-0001');
    const b = await provider.get('PRD-0002');
    expect(b?.name).toBe('B');
  });

  it('get resolves by numeric prefix regardless of slug casing in the id', async () => {
    await provider.create('security', { name: 'Auth Hardening', description: 'x', body: 'y' });
    const doc = await provider.get('security-1');
    expect(doc?.name).toBe('Auth Hardening');
    expect(doc?.slug).toBe('auth-hardening');
  });

  it('get returns null for an id that does not exist', async () => {
    expect(await provider.get('PRD-9999')).toBeNull();
    expect(await provider.get('not-an-id')).toBeNull();
  });

  it('list filters by type and omits other types when no type is given', async () => {
    await provider.create('prd', { name: 'A', description: 'a', body: 'x' });
    await provider.create('adr', { name: 'B', description: 'b', body: 'x' });
    expect((await provider.list('prd')).map((r) => r.id)).toEqual(['PRD-0001']);
    const all = await provider.list();
    expect(all.map((r) => r.id).sort()).toEqual(['ADR-0001', 'PRD-0001']);
  });

  it('put creates-or-overwrites at an EXACT id without auto-incrementing', async () => {
    const put1 = await provider.put('PRD-0007', { name: 'Imported', description: 'x', body: 'y' });
    expect(put1.id).toBe('PRD-0007');
    // a second put at the same id overwrites rather than minting PRD-0008
    const put2 = await provider.put('PRD-0007', { name: 'Imported v2', description: 'x2', body: 'y2' });
    expect(put2.id).toBe('PRD-0007');
    const doc = await provider.get('PRD-0007');
    expect(doc?.name).toBe('Imported v2');
    expect((await provider.list('prd')).length).toBe(1);
  });

  it('put renames the file when the name (and so the slug) changes', async () => {
    await provider.put('PRD-0001', { name: 'Old Title', description: 'x', body: 'y' });
    const oldPath = join(dir, 'docs', 'prd', '0001-old-title.md');
    expect(existsSync(oldPath)).toBe(true);
    await provider.put('PRD-0001', { name: 'New Title', description: 'x', body: 'y' });
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(join(dir, 'docs', 'prd', '0001-new-title.md'))).toBe(true);
  });

  it('delete removes the file', async () => {
    await provider.create('prd', { name: 'Gone', description: 'x', body: 'y' });
    await provider.delete('PRD-0001');
    expect(await provider.get('PRD-0001')).toBeNull();
  });

  it('delete throws for an unknown id', async () => {
    await expect(provider.delete('PRD-0001')).rejects.toThrow(/not found/);
  });

  it('updateIndex writes docs/README.md grouped by type with name + description', async () => {
    await provider.create('prd', { name: 'Alpha', description: 'first', body: 'x' });
    await provider.create('adr', { name: 'Beta', description: 'second', body: 'x' });
    await provider.updateIndex();
    const readme = readFileSync(join(dir, 'docs', 'README.md'), 'utf-8');
    expect(readme).toContain('## Prd');
    expect(readme).toContain('## Adr');
    expect(readme).toContain('[Alpha](./prd/0001-alpha.md)');
    expect(readme).toContain('— first');
  });

  // Regression: a strict-frontmatter parse silently skipped every file in a
  // real copied EPR-V2 docs tree (ADRs with no frontmatter, PRDs with a bare
  // `title:` field) — `docs migrate` reported "0 of 0" against real content.
  it('adopts a pre-existing file with NO frontmatter (raw, never written through kodi)', async () => {
    mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'adr', '0001-clean-architecture-layering.md'),
      '# ADR 0001 — Clean Architecture layering\n\n**Status:** Accepted\n',
      'utf-8',
    );
    const refs = await provider.list('adr');
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe('ADR-0001');
    expect(refs[0].name).toBe('ADR 0001 — Clean Architecture layering');
    expect(refs[0].description).toBe('');
    const doc = await provider.get('ADR-0001');
    expect(doc?.body).toContain('**Status:** Accepted');
  });

  it('adopts a pre-existing file whose frontmatter uses `title:` instead of `name:` (the real EPR-V2 PRD shape)', async () => {
    mkdirSync(join(dir, 'docs', 'prd'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'prd', '0009-document-handling.md'),
      '---\nPRD: 9\ntitle: Document Handling\nstatus: Shipped\n---\n\n# PRD 0009\n',
      'utf-8',
    );
    const doc = await provider.get('PRD-0009');
    expect(doc?.name).toBe('Document Handling');
    expect(doc?.meta.status).toBe('Shipped');
  });

  it('numbers a NEW doc past pre-existing unfrontmattered files instead of colliding with them', async () => {
    mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'adr', '0001-old.md'), '# Old ADR\n', 'utf-8');
    writeFileSync(join(dir, 'docs', 'adr', '0002-older.md'), '# Older ADR\n', 'utf-8');
    const created = await provider.create('adr', { name: 'New ADR', description: 'x', body: 'y' });
    expect(created.id).toBe('ADR-0003');
  });

  // Regression for a real incident: `create()`'s auto-numbering and `put()`'s
  // rename-cleanup (which deletes whatever file already occupies a NUMBER when
  // writing a differently-slugged doc there) must agree on what "already
  // occupies that number" means. When numbering was based on strict/validated
  // docs while the rename-cleanup scanned every raw `NNNN-*.md` file, a fresh
  // `create()` could mint a number a legacy file already had — silently
  // DELETING that unrelated pre-existing file as a side effect of the "rename."
  // This actually happened against real copied EPR-V2 content in the playground.
  it('never deletes an unrelated pre-existing file via the create -> put rename-cleanup path', async () => {
    mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
    // a legacy file with NO frontmatter, occupying number 1 — exactly the shape
    // that predates kodi and must never be silently destroyed by auto-numbering.
    const legacyPath = join(dir, 'docs', 'adr', '0001-clean-architecture-layering.md');
    writeFileSync(legacyPath, '# ADR 0001 — Clean Architecture layering\n\nOriginal content.\n', 'utf-8');

    const created = await provider.create('adr', {
      name: 'Totally Unrelated New Doc',
      description: 'x',
      body: 'y',
    });

    expect(created.id).not.toBe('ADR-0001'); // must not have picked the occupied number
    expect(existsSync(legacyPath)).toBe(true); // and the legacy file must survive untouched
    expect(readFileSync(legacyPath, 'utf-8')).toContain('Original content.');
  });

  // Regression: real EPR-V2 `docs/plan`/`docs/diagrams` use free-form filenames
  // with NO numeric prefix at all (`foundation-part1.md`, `container.md`) —
  // unlike PRD/ADR/security, which already had `<NNNN>-<slug>.md` names. These
  // were invisible to `list`/`migrate` entirely (a filename-shape gap, not a
  // frontmatter one). Adoption assigns and PERSISTS a real id via rename.
  describe('adopting unnumbered legacy files', () => {
    it('renames a plain <name>.md file to <NNNN>-<slug>.md and gives it a real id', async () => {
      mkdirSync(join(dir, 'docs', 'diagrams'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'diagrams', 'container.md'), '# Container diagram\n\nSome content.\n', 'utf-8');

      const refs = await provider.list('diagrams');

      expect(refs).toHaveLength(1);
      expect(refs[0].id).toBe('DIAGRAMS-0001');
      expect(refs[0].name).toBe('Container diagram'); // from the H1, since there was no frontmatter
      expect(existsSync(join(dir, 'docs', 'diagrams', 'container.md'))).toBe(false); // old name is gone
      const newPath = join(dir, 'docs', 'diagrams', '0001-container.md');
      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(newPath, 'utf-8')).toContain('name: Container diagram'); // normalized on adoption
    });

    it('never adopts README.md (a type-folder overview, not an artifact)', async () => {
      mkdirSync(join(dir, 'docs', 'plan'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'plan', 'README.md'), '# Plan overview\n', 'utf-8');
      expect(await provider.list('plan')).toEqual([]);
      expect(existsSync(join(dir, 'docs', 'plan', 'README.md'))).toBe(true); // untouched
    });

    it('numbers multiple unnumbered files deterministically, past any already-numbered ones', async () => {
      mkdirSync(join(dir, 'docs', 'plan'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'plan', '0001-phase-0.md'), '# Phase 0\n', 'utf-8');
      writeFileSync(join(dir, 'docs', 'plan', 'foundation-part1.md'), '# Foundation Part 1\n', 'utf-8');
      writeFileSync(join(dir, 'docs', 'plan', 'foundation-part2.md'), '# Foundation Part 2\n', 'utf-8');

      const refs = await provider.list('plan');

      expect(refs.map((r) => r.id).sort()).toEqual(['PLAN-0001', 'PLAN-0002', 'PLAN-0003']);
    });

    it('is idempotent — a second list() does not re-adopt or renumber', async () => {
      mkdirSync(join(dir, 'docs', 'diagrams'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'diagrams', 'data-model.md'), '# Data model\n', 'utf-8');

      const first = await provider.list('diagrams');
      const second = await provider.list('diagrams');

      expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
      expect(first[0].id).toBe('DIAGRAMS-0001');
    });
  });

  it('never enumerates the reserved "tickets" type even if passed explicitly in docsTypes', async () => {
    const p = new LocalDocsProvider(['tickets', 'prd'], dir);
    // a ticket-shaped doc file under docs/tickets/ must never surface via list()
    mkdirSync(join(dir, 'docs', 'tickets'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'tickets', '0001-not-a-doc.md'),
      '---\nname: x\ndescription: y\ntype: tickets\n---\n\nbody',
      'utf-8',
    );
    expect(await p.list()).toEqual([]);
  });
});
