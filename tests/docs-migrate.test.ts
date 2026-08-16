import { describe, expect, it } from 'vitest';
import { runMigrate } from '../src/commands/docs.js';
import type { CreateDocInput, DocContent, DocRef, DocsProvider } from '../src/providers/types.js';

/** Minimal in-memory DocsProvider stub — enough surface for runMigrate, no `az`/fs. */
class StubDocsProvider implements DocsProvider {
  readonly name = 'stub';
  docs = new Map<string, DocContent>();
  updateIndexCalls = 0;
  failPutFor = new Set<string>();

  async nextId(): Promise<string> {
    throw new Error('not used by migrate');
  }

  async list(type?: string): Promise<DocRef[]> {
    return [...this.docs.values()]
      .filter((d) => !type || d.type === type)
      .map(({ id, type, slug, name, description }) => ({ id, type, slug, name, description }));
  }

  async get(id: string): Promise<DocContent | null> {
    return this.docs.get(id) ?? null;
  }

  async create(type: string, input: CreateDocInput): Promise<DocContent> {
    return this.put(`${type.toUpperCase()}-0001`, input);
  }

  async put(id: string, input: CreateDocInput): Promise<DocContent> {
    if (this.failPutFor.has(id)) throw new Error(`stub failure for ${id}`);
    const type = id.split('-')[0].toLowerCase();
    const doc: DocContent = {
      id,
      type,
      slug: input.name.toLowerCase().replace(/\s+/g, '-'),
      name: input.name,
      description: input.description,
      meta: { name: input.name, description: input.description, type, ...input.meta },
      body: input.body,
    };
    this.docs.set(id, doc);
    return doc;
  }

  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }

  async updateIndex(): Promise<void> {
    this.updateIndexCalls++;
  }
}

function seed(provider: StubDocsProvider, id: string, over: Partial<DocContent> = {}): void {
  const type = id.split('-')[0].toLowerCase();
  provider.docs.set(id, {
    id,
    type,
    slug: 'x',
    name: `Doc ${id}`,
    description: 'desc',
    meta: { name: `Doc ${id}`, description: 'desc', type },
    body: 'body',
    ...over,
  });
}

describe('runMigrate', () => {
  it('copies every doc from source to target, preserving ids', async () => {
    const source = new StubDocsProvider();
    seed(source, 'PRD-0001');
    seed(source, 'ADR-0001');
    const target = new StubDocsProvider();

    const result = await runMigrate(source, target, { apply: true });

    expect(result).toEqual({ total: 2, migrated: 2, skipped: 0, failed: 0 });
    expect(await target.get('PRD-0001')).not.toBeNull();
    expect(await target.get('ADR-0001')).not.toBeNull();
  });

  it('scopes to one type when given', async () => {
    const source = new StubDocsProvider();
    seed(source, 'PRD-0001');
    seed(source, 'ADR-0001');
    const target = new StubDocsProvider();

    const result = await runMigrate(source, target, { type: 'prd', apply: true });

    expect(result.total).toBe(1);
    expect(await target.get('PRD-0001')).not.toBeNull();
    expect(await target.get('ADR-0001')).toBeNull();
  });

  it('skips a doc that already exists on the target unless --force', async () => {
    const source = new StubDocsProvider();
    seed(source, 'PRD-0001', { name: 'New content' });
    const target = new StubDocsProvider();
    seed(target, 'PRD-0001', { name: 'Existing content' });

    const skipResult = await runMigrate(source, target, { apply: true });
    expect(skipResult).toEqual({ total: 1, migrated: 0, skipped: 1, failed: 0 });
    expect((await target.get('PRD-0001'))?.name).toBe('Existing content');

    const forceResult = await runMigrate(source, target, { force: true, apply: true });
    expect(forceResult).toEqual({ total: 1, migrated: 1, skipped: 0, failed: 0 });
    expect((await target.get('PRD-0001'))?.name).toBe('New content');
  });

  it('counts a failed write without aborting the rest of the batch', async () => {
    const source = new StubDocsProvider();
    seed(source, 'PRD-0001');
    seed(source, 'PRD-0002');
    const target = new StubDocsProvider();
    target.failPutFor.add('PRD-0001');

    const result = await runMigrate(source, target, { apply: true });

    expect(result).toEqual({ total: 2, migrated: 1, skipped: 0, failed: 1 });
    expect(await target.get('PRD-0002')).not.toBeNull();
  });

  it('calls updateIndex exactly once, only when apply is true', async () => {
    const source = new StubDocsProvider();
    seed(source, 'PRD-0001');
    seed(source, 'PRD-0002');

    const dryRunTarget = new StubDocsProvider();
    await runMigrate(source, dryRunTarget, { apply: false });
    expect(dryRunTarget.updateIndexCalls).toBe(0);

    const appliedTarget = new StubDocsProvider();
    await runMigrate(source, appliedTarget, { apply: true });
    expect(appliedTarget.updateIndexCalls).toBe(1);
  });

  it('still migrates in a dry-run preview (apply: false) — only the index update is skipped', async () => {
    const source = new StubDocsProvider();
    seed(source, 'PRD-0001');
    const target = new StubDocsProvider();

    const result = await runMigrate(source, target, { apply: false });
    // the stub always "writes" — a real azure-wiki target's put() is itself
    // dry-run-gated internally via execMutate, which this stub doesn't model.
    expect(result.migrated).toBe(1);
    expect(target.updateIndexCalls).toBe(0);
  });

  it('reports one onProgress event per doc, in order, with a running index/total and the right status', async () => {
    const source = new StubDocsProvider();
    seed(source, 'PRD-0001');
    seed(source, 'PRD-0002');
    const target = new StubDocsProvider();
    seed(target, 'PRD-0002'); // already on the target -> should report "skipped"
    target.failPutFor.add('PRD-0001'); // -> should report "failed"

    const events: Array<{ index: number; total: number; id: string; status: string }> = [];
    await runMigrate(source, target, {
      apply: true,
      onProgress: (e) => events.push({ index: e.index, total: e.total, id: e.ref.id, status: e.status }),
    });

    expect(events).toEqual([
      { index: 1, total: 2, id: 'PRD-0001', status: 'failed' },
      { index: 2, total: 2, id: 'PRD-0002', status: 'skipped' },
    ]);
  });
});
