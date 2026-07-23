import { describe, expect, it } from 'vitest';
import { buildDependencyForest, renderForest, type TreeNode } from '../src/commands/tickets.js';
import type { TicketStatus } from '../src/templates/ticket.js';
import type { TicketRef } from '../src/providers/types.js';

function ref(
  key: string,
  status: TicketStatus,
  dependencies: string[] = [],
  title = `Ticket ${key}`,
): TicketRef {
  return { key, title, status, slug: key.toLowerCase(), dependencies };
}

describe('tickets tree — buildDependencyForest', () => {
  it('roots the dependency-free tickets and nests dependents beneath them', () => {
    const forest = buildDependencyForest([
      ref('1206', 'Pending'),
      ref('1207', 'Pending', ['1206']),
      ref('1208', 'Pending', ['1206']),
    ]);
    expect(forest).toHaveLength(1);
    expect(forest[0].ref.key).toBe('1206');
    expect(forest[0].base).toBe(true);
    expect(forest[0].children.map((c) => c.ref.key)).toEqual(['1207', '1208']);
    expect(forest[0].children.every((c) => c.base === false)).toBe(true);
  });

  it('excludes Done tickets, and a ticket blocked only by a Done ticket becomes a base', () => {
    const forest = buildDependencyForest([
      ref('1', 'Done'),
      ref('2', 'Pending', ['1']), // its only blocker is Done → satisfied → a base
    ]);
    expect(forest.map((n) => n.ref.key)).toEqual(['2']);
    expect(forest[0].base).toBe(true);
  });

  it('shows a shared (DAG) dependent once and marks the second occurrence as repeat', () => {
    const forest = buildDependencyForest([
      ref('1', 'Pending'),
      ref('2', 'Pending', ['1']),
      ref('3', 'Pending', ['1']),
      ref('4', 'Pending', ['2', '3']), // depends on both 2 and 3
    ]);
    const under2 = forest[0].children.find((c) => c.ref.key === '2')!;
    const under3 = forest[0].children.find((c) => c.ref.key === '3')!;
    // fully expanded under its first parent (2), a bare repeat under the second (3)
    expect(under2.children.map((c) => c.ref.key)).toEqual(['4']);
    expect(under2.children[0].repeat).toBe(false);
    expect(under3.children[0].ref.key).toBe('4');
    expect(under3.children[0].repeat).toBe(true);
    expect(under3.children[0].children).toEqual([]);
  });

  it('sorts roots and children numerically (1206 < 1210, not lexically)', () => {
    const forest = buildDependencyForest([
      ref('1210', 'Pending', ['1206']),
      ref('1206', 'Pending'),
      ref('1207', 'Pending', ['1206']),
    ]);
    expect(forest[0].children.map((c) => c.ref.key)).toEqual(['1207', '1210']);
  });

  it('surfaces cycle survivors rather than dropping them', () => {
    // 1 ↔ 2 depend on each other → neither is a root, but both must still appear
    const forest = buildDependencyForest([
      ref('1', 'Pending', ['2']),
      ref('2', 'Pending', ['1']),
    ]);
    const keys = new Set<string>();
    const collect = (n: TreeNode) => {
      keys.add(n.ref.key);
      n.children.forEach(collect);
    };
    forest.forEach(collect);
    expect(keys).toEqual(new Set(['1', '2']));
    expect(forest.every((n) => n.base === false)).toBe(true); // cycle nodes aren't bases
  });

  it('returns an empty forest when every ticket is Done', () => {
    expect(buildDependencyForest([ref('1', 'Done'), ref('2', 'Done')])).toEqual([]);
  });
});

describe('tickets tree — renderForest', () => {
  it('draws box branches, shows status, and flags the ready base with "start here"', () => {
    const out = renderForest(
      buildDependencyForest([
        ref('1206', 'Pending', [], 'audit_logs table'),
        ref('1207', 'In progress', ['1206'], 'Mutation audit: Patient'),
        ref('1208', 'Pending', ['1206'], 'Mutation audit: clinical'),
      ]),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('└─ 1206  (Pending)  audit_logs table  [BASE] ◄ start here');
    // status is rendered for every node
    expect(out).toContain('1207  (In progress)  Mutation audit: Patient');
    // branch glyphs + indentation for children
    expect(out).toContain('    ├─ 1207');
    expect(out).toContain('    └─ 1208');
  });

  it('marks an already-started base [BASE] without "start here"', () => {
    const out = renderForest(buildDependencyForest([ref('1', 'In progress', [], 'Base')]));
    expect(out).toBe('└─ 1  (In progress)  Base  [BASE]');
    expect(out).not.toContain('start here');
  });

  it('renders the repeat marker for a shared DAG dependent', () => {
    const out = renderForest(
      buildDependencyForest([
        ref('1', 'Pending'),
        ref('2', 'Pending', ['1']),
        ref('3', 'Pending', ['1']),
        ref('4', 'Pending', ['2', '3']),
      ]),
    );
    expect(out).toContain('⇢ (shown above)');
  });

  it('reports an empty forest with a friendly message', () => {
    expect(renderForest([])).toBe('No not-done tickets to show.');
  });
});
