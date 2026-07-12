import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { ORCHESTRATOR_BOOTSTRAP } from '../bootstrap.js';
import { ragDbPath } from '../config.js';
import { openDb } from '../memory/db.js';
import { lookupCollection, recentMemories } from '../memory/store.js';

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
 * `kodi hook <event>` — emit the JSON a Claude Code hook expects on stdout.
 * `kodi init` wires SessionStart → `kodi hook session-start`, so the bootstrap
 * is versioned with the CLI instead of living in a loose script.
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

  return hook;
}
