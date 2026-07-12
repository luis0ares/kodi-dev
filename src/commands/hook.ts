import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { ORCHESTRATOR_BOOTSTRAP } from '../bootstrap.js';
import { ragDbPath } from '../config.js';
import { openDb } from '../memory/db.js';
import { lookupCollection, queryMemories, recentMemories } from '../memory/store.js';

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
 * A compact digest of this project's recent memories, appended to the SessionStart
 * context so past findings re-enter each session. Strictly read-only and best-effort:
 * if there is no DB, no collection, or no memories, it contributes nothing (and never
 * throws — a hook must not break session startup).
 */
function memoryDigest(): string {
  try {
    if (!existsSync(ragDbPath())) return '';
    const db = openDb();
    try {
      const col = lookupCollection(db);
      if (!col) return '';
      const recent = recentMemories(db, col.collection, 5);
      if (recent.length === 0) return '';
      const lines = recent.map((m) => `- [${m.type}] ${m.ticket ? m.ticket + ' ' : ''}${m.title}`);
      return (
        `\n\n## Project memory (kodi)\n\n` +
        `Recent findings for this project — query more with \`kodi memory query <text>\` ` +
        `and store new ones with \`kodi memory store\`:\n\n${lines.join('\n')}\n`
      );
    } finally {
      db.close();
    }
  } catch {
    return '';
  }
}

/**
 * Memories relevant to the just-submitted prompt, formatted as a small, token-budgeted
 * injection. Pure lexical FTS — no LLM, no network. Best-effort and read-only: returns
 * '' (inject nothing) when there is no DB, no collection, a trivial prompt, or no hit.
 */
function promptInjection(prompt: string, cwd: string): string {
  try {
    if (!prompt.trim() || !existsSync(ragDbPath())) return '';
    const db = openDb();
    try {
      const col = lookupCollection(db, cwd);
      if (!col) return '';
      // Keep it tight: the top few relevant memories, capped by a small char budget
      // (~300 tokens) so per-prompt injection never bloats context.
      const hits = queryMemories(db, col.collection, { text: prompt, limit: 3 });
      if (hits.length === 0) return '';
      const BUDGET = 1200;
      const lines: string[] = [];
      let used = 0;
      for (const m of hits) {
        const line = `- [${m.type}] ${m.ticket ? m.ticket + ' ' : ''}${m.title}`;
        if (used + line.length > BUDGET) break;
        lines.push(line);
        used += line.length + 1;
      }
      if (lines.length === 0) return '';
      return (
        `## Possibly relevant project memory (kodi)\n\n` +
        `Retrieved for your request — expand with \`kodi memory query "<topic>" --json\`:\n\n` +
        `${lines.join('\n')}\n`
      );
    } finally {
      db.close();
    }
  } catch {
    return '';
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

  return hook;
}
