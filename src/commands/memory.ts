import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { openDb } from '../memory/db.js';
import {
  amendMemory,
  exportMemories,
  importMemories,
  insertMemory,
  queryMemories,
  removeMemory,
  resolveCollection,
  type Collection,
  type QueryHit,
} from '../memory/store.js';
import {
  fileNames,
  MEMORY_TYPES,
  MemoryDraftSchema,
  MemoryExportDocSchema,
  type MemoryRecord,
  type MemoryType,
} from '../memory/template.js';

function out(data: unknown, json: boolean, human: () => string) {
  if (json) process.stdout.write(JSON.stringify(data) + '\n');
  else process.stdout.write(human() + '\n');
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Validate a --type flag value against the enum (throws with a clear message). */
function asType(v: unknown): MemoryType | undefined {
  if (v == null) return undefined;
  if (!MEMORY_TYPES.includes(v as MemoryType)) {
    throw new Error(`invalid --type "${v}". One of: ${MEMORY_TYPES.join(', ')}.`);
  }
  return v as MemoryType;
}

/** One line per memory for the human surface. */
function renderLine(m: MemoryRecord & { score?: number }): string {
  const files = m.files.length ? `  {${fileNames(m.files).join(', ')}}` : '';
  const ticket = m.ticket ? `  ${m.ticket}` : '';
  return `${m.id}  [${m.type}]${ticket}  ${m.title}${files}`;
}

function renderList(hits: QueryHit[]): string {
  return hits.length ? hits.map(renderLine).join('\n') : 'no memories';
}

/** Open the memory DB, run `fn`, and always close it. */
function withDb<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Like {@link withDb}, but also resolves this project's collection first. */
function withCollection<T>(fn: (db: ReturnType<typeof openDb>, col: Collection) => T): T {
  return withDb((db) => fn(db, resolveCollection(db)));
}

export function registerMemoryCommand(program: Command) {
  const memory = program
    .command('memory')
    .description('Cross-session knowledge store (lexical FTS) — store/query project findings');

  memory
    .command('store')
    .description('Store a finding (deduped by content — idempotent)')
    .option('-d, --draft <path>', 'YAML draft file (validated against the memory template)')
    .option('-c, --content <text>', 'the finding to remember')
    .option('-t, --type <type>', `one of: ${MEMORY_TYPES.join(', ')}`)
    .option('--ticket <key>', 'ticket/task in flight (optional)')
    .option('--file <path>', 'repo-relative file the finding touches (repeatable)', collect, [])
    .option('--title <text>', 'optional display title (else derived from content)')
    .option('--json', 'machine-readable output', false)
    .action((o) => {
      const draft = o.draft
        ? MemoryDraftSchema.parse(parseYaml(readFileSync(String(o.draft), 'utf-8')))
        : MemoryDraftSchema.parse({
            content: o.content,
            type: o.type,
            ticket: o.ticket,
            files: o.file ?? [],
            title: o.title,
          });
      withCollection((db, col) => {
        const { record, deduped } = insertMemory(db, col.collection, draft);
        out({ ...record, deduped }, o.json, () =>
          deduped
            ? `Already stored (dedup): ${record.id} — ${record.title}`
            : `Stored ${record.id} [${record.type}] — ${record.title}`,
        );
      });
    });

  memory
    .command('query [text...]')
    .description('Search memories (BM25 text + filters), scoped to this project')
    .option('-t, --type <type>', 'filter by type')
    .option('--ticket <key>', 'filter by ticket')
    .option('--file <path>', 'filter by a referenced file path (substring)')
    .option('--since <iso>', 'only memories created on/after this ISO timestamp')
    .option('-n, --limit <n>', 'max results (default 10)', (v) => Number(v))
    .option('--json', 'machine-readable output', false)
    .action((text: string[], o) => {
      withCollection((db, col) => {
        const hits = queryMemories(db, col.collection, {
          text: text?.length ? text.join(' ') : undefined,
          type: asType(o.type),
          ticket: o.ticket,
          file: o.file,
          since: o.since,
          limit: o.limit,
        });
        out(hits, o.json, () => renderList(hits));
      });
    });

  memory
    .command('list')
    .description('Browse recent memories in this project (newest first)')
    .option('-t, --type <type>', 'filter by type')
    .option('--ticket <key>', 'filter by ticket')
    .option('-n, --limit <n>', 'max results (default 10)', (v) => Number(v))
    .option('--json', 'machine-readable output', false)
    .action((o) => {
      withCollection((db, col) => {
        const hits = queryMemories(db, col.collection, {
          type: asType(o.type),
          ticket: o.ticket,
          limit: o.limit,
        });
        out(hits, o.json, () => renderList(hits));
      });
    });

  memory
    .command('amend <id>')
    .description('Edit a memory in place')
    .option('-c, --content <text>')
    .option('-t, --type <type>')
    .option('--ticket <key>')
    .option('--file <path>', 'replace referenced files (repeatable)', collect)
    .option('--title <text>')
    .option('--json', 'machine-readable output', false)
    .action((id: string, o) => {
      withDb((db) => {
        const updated = amendMemory(db, id, {
          content: o.content,
          type: asType(o.type),
          ticket: o.ticket,
          files: o.file,
          title: o.title,
        });
        if (!updated) {
          out({ error: 'not found', id }, o.json, () => `no memory ${id}`);
          process.exitCode = 1;
          return;
        }
        out(updated, o.json, () => `Amended ${updated.id} — ${updated.title}`);
      });
    });

  memory
    .command('rm <id>')
    .description('Delete a memory')
    .option('--json', 'machine-readable output', false)
    .action((id: string, o) => {
      withDb((db) => {
        const removed = removeMemory(db, id);
        out({ removed, id }, o.json, () => (removed ? `Removed ${id}` : `no memory ${id}`));
        if (!removed) process.exitCode = 1;
      });
    });

  memory
    .command('export')
    .description('Export this project’s memories as YAML (all, or one --type)')
    .option('-t, --type <type>', 'export only this type')
    .option('-f, --file <path>', 'write to a file (default: stdout)')
    .action((o) => {
      withCollection((db, col) => {
        const records = exportMemories(db, col.collection, asType(o.type));
        const doc = {
          collection: col.name,
          exportedAt: new Date().toISOString(),
          memories: records.map((m) => ({
            content: m.content,
            type: m.type,
            ticket: m.ticket,
            files: m.files,
            title: m.title,
            createdAt: m.createdAt,
          })),
        };
        const yaml = stringifyYaml(doc);
        if (o.file) {
          writeFileSync(String(o.file), yaml, 'utf-8');
          process.stderr.write(`Exported ${records.length} memories -> ${o.file}\n`);
        } else {
          process.stdout.write(yaml);
        }
      });
    });

  memory
    .command('import <path>')
    .description('Import memories from a YAML file into this project (deduped)')
    .option('-t, --type <type>', 'import only this type')
    .option('--json', 'machine-readable output', false)
    .action((path: string, o) => {
      const doc = MemoryExportDocSchema.parse(parseYaml(readFileSync(path, 'utf-8')));
      withCollection((db, col) => {
        const res = importMemories(db, col.collection, doc.memories, asType(o.type));
        out(res, o.json, () => `Imported: +${res.added} added, ${res.skipped} skipped`);
      });
    });

  return memory;
}
