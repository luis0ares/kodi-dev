import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { ORCHESTRATOR_BOOTSTRAP } from '../bootstrap.js';
import { ragDbPath } from '../config.js';
import { openDb } from '../memory/db.js';
import {
  insertMemory,
  lookupCollection,
  queryMemories,
  recentMemories,
  resolveCollection,
} from '../memory/store.js';
import { MemoryDraftSchema } from '../memory/template.js';

/** Read the JSON a Claude Code hook passes on stdin; {} on empty/invalid/TTY. */
function readHookInput(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      try {
        resolve(data.trim() ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

/**
 * Open the memory DB read-only for a hook, run `fn`, and always close. Returns
 * `fallback` when there is no DB yet or anything throws — a hook must never break the
 * session, so reads are strictly best-effort.
 */
function withReadDb<T>(fallback: T, fn: (db: ReturnType<typeof openDb>) => T): T {
  try {
    if (!existsSync(ragDbPath())) return fallback;
    const db = openDb();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return fallback;
  }
}

/** Render a memory as a one-line `- [type] TICKET title` bullet. */
function bullet(m: { type: string; ticket: string | null; title: string }): string {
  return `- [${m.type}] ${m.ticket ? m.ticket + ' ' : ''}${m.title}`;
}

/**
 * A compact digest of this project's recent memories, appended to the SessionStart
 * context so past findings re-enter each session. Strictly read-only and best-effort:
 * if there is no DB, no collection, or no memories, it contributes nothing.
 */
function memoryDigest(): string {
  return withReadDb('', (db) => {
    const col = lookupCollection(db);
    if (!col) return '';
    const recent = recentMemories(db, col.collection, 5);
    if (recent.length === 0) return '';
    return (
      `\n\n## Project memory (kodi)\n\n` +
      `Recent findings for this project — query more with \`kodi memory query <text>\` ` +
      `and store new ones with \`kodi memory store\`:\n\n${recent.map(bullet).join('\n')}\n`
    );
  });
}

/**
 * Memories relevant to the just-submitted prompt, formatted as a small, token-budgeted
 * injection. Pure lexical FTS — no LLM, no network. Best-effort and read-only: returns
 * '' (inject nothing) when there is no DB, no collection, a trivial prompt, or no hit.
 */
function promptInjection(prompt: string, cwd: string): string {
  if (!prompt.trim()) return '';
  return withReadDb('', (db) => {
    const col = lookupCollection(db, cwd);
    if (!col) return '';
    // Keep it tight: the top few relevant memories, capped by a small char budget
    // (~300 tokens) so per-prompt injection never bloats context.
    const hits = queryMemories(db, col.collection, { text: prompt, limit: 3 });
    const lines: string[] = [];
    let used = 0;
    for (const m of hits) {
      const line = bullet(m);
      if (used + line.length > 1200) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) return '';
    return (
      `## Possibly relevant project memory (kodi)\n\n` +
      `Retrieved for your request — expand with \`kodi memory query "<topic>" --json\`:\n\n` +
      `${lines.join('\n')}\n`
    );
  });
}

/**
 * Extract the values of every `--vulnerability` flag from a `kodi pr create` command
 * string (double / single / unquoted). These are security findings the slice
 * surfaced — durable facts worth remembering whether or not the PR actually opened
 * (dry-run included), so capturing them here is unambiguous.
 */
export function parseVulnerabilities(command: string): string[] {
  if (!/\bkodi\s+pr\s+create\b/.test(command)) return [];
  const out: string[] = [];
  const re = /--vulnerability(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

/** The ticket key of a `kodi tickets hand-off <key>` command, else null. */
export function parseHandoffKey(command: string): string | null {
  const m = command.match(/\bkodi\s+tickets\s+hand-off\s+([^\s'"]+)/);
  return m ? m[1] : null;
}

/**
 * Deterministically capture durable artifacts from a kodi command — no LLM, no
 * transcript parsing. Captures: the security findings on a `kodi pr create
 * --vulnerability …` (as `gotcha`, always — a vuln is a fact regardless of dry-run),
 * and a `kodi tickets hand-off <key>` slice-completion milestone (as `task-note`, but
 * ONLY on a real run — `dryRun` skips it so a preview isn't remembered as done).
 * Deduped/idempotent. Best-effort: never throws.
 */
function captureFromCommand(command: string, cwd: string, dryRun: boolean): void {
  try {
    const vulns = parseVulnerabilities(command);
    const handoff = dryRun ? null : parseHandoffKey(command);
    if (vulns.length === 0 && !handoff) return;
    const db = openDb();
    try {
      const col = resolveCollection(db, cwd);
      for (const v of vulns) {
        insertMemory(
          db,
          col.collection,
          MemoryDraftSchema.parse({ content: `Security finding: ${v}`, type: 'gotcha' }),
        );
      }
      if (handoff) {
        insertMemory(
          db,
          col.collection,
          MemoryDraftSchema.parse({
            content: `Ticket ${handoff} handed off to review — slice complete, PR opened.`,
            type: 'task-note',
            ticket: handoff,
          }),
        );
      }
    } finally {
      db.close();
    }
  } catch {
    /* capture is best-effort; a hook must never fail the tool call */
  }
}

/**
 * `kodi hook <event>` — emit the JSON a Claude Code hook expects on stdout.
 * `kodi init` wires SessionStart → `kodi hook session-start` and UserPromptSubmit →
 * `kodi hook user-prompt-submit`, so hook logic is versioned with the CLI instead of
 * living in loose scripts.
 */
export function registerHookCommand(program: Command) {
  const hook = program.command('hook').description('Emit Claude Code hook output (internal)');

  hook
    .command('session-start')
    .description('Emit the orchestrator bootstrap as SessionStart additionalContext')
    .action(() => {
      const payload = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: ORCHESTRATOR_BOOTSTRAP + memoryDigest(),
        },
      };
      process.stdout.write(JSON.stringify(payload));
    });

  hook
    .command('user-prompt-submit')
    .description('Inject memories relevant to the submitted prompt (UserPromptSubmit)')
    .action(async () => {
      const input = await readHookInput();
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
      const context = promptInjection(prompt, cwd);
      // No relevant memory → emit nothing (inject nothing), exit clean.
      if (!context) return;
      const payload = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: context,
        },
      };
      process.stdout.write(JSON.stringify(payload));
    });

  hook
    .command('post-tool-use')
    .description('Deterministically capture kodi artifacts into memory (PostToolUse)')
    .action(async () => {
      const input = await readHookInput();
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
      // A kodi mutation prints "[dry-run] …" when not executed (no --yes). Detect it
      // from the tool response so a previewed hand-off isn't captured as completed.
      const dryRun = JSON.stringify(input.tool_response ?? '').includes('[dry-run]');
      if (command) captureFromCommand(command, cwd, dryRun);
      // Capture is a pure side effect — emit nothing.
    });

  return hook;
}
