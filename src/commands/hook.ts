import { existsSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { Command } from 'commander';
import { ORCHESTRATOR_BOOTSTRAP } from '../bootstrap.js';
import { findProjectRoot, ragDbPath } from '../config.js';
import { openDb } from '../memory/db.js';
import {
  flagStaleForFile,
  insertMemory,
  lookupCollection,
  queryMemories,
  reconcileStale,
  resolveCollection,
} from '../memory/store.js';
import { MemoryDraftSchema, type MemoryRecord } from '../memory/template.js';
import { AUTO_INJECT_MIN, RELEVANCE_MIN } from '../memory/veracity.js';

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

/** Render a memory as a one-line `- Nscore★ [type] TICKET title` bullet. */
function bullet(m: MemoryRecord): string {
  return `- ${m.score}★ [${m.type}] ${m.ticket ? m.ticket + ' ' : ''}${m.title}`;
}

/**
 * A compact digest of this project's TRUSTED memories (score ≥ 4), appended to the
 * SessionStart context. First runs the out-of-band reconcile (catch a git pull the
 * Write hook never saw), then injects only auto-band findings. Best-effort.
 */
function memoryDigest(): string {
  return withReadDb('', (db) => {
    const col = lookupCollection(db);
    if (!col) return '';
    try {
      reconcileStale(db, findProjectRoot(), col.collection);
    } catch {
      /* reconcile is best-effort */
    }
    const recent = queryMemories(db, col.collection, { minScore: AUTO_INJECT_MIN, limit: 5 });
    if (recent.length === 0) return '';
    return (
      `\n\n## Project memory (kodi)\n\n` +
      `Trusted findings (score ≥ ${AUTO_INJECT_MIN}) for this project — query more with ` +
      `\`kodi memory query <text>\`, and \`kodi memory verify <id>\` when a finding is confirmed/refuted:` +
      `\n\n${recent.map(bullet).join('\n')}\n`
    );
  });
}

/**
 * Memories relevant to the just-submitted prompt (score ≥ 3), token-budgeted. Pure
 * lexical FTS — no LLM. Best-effort; returns '' when nothing trusted+relevant is found.
 */
function promptInjection(prompt: string, cwd: string): string {
  if (!prompt.trim()) return '';
  return withReadDb('', (db) => {
    const col = lookupCollection(db, cwd);
    if (!col) return '';
    // Only trustworthy (≥ 3) memories, top few, capped by a small char budget (~300 tok).
    const hits = queryMemories(db, col.collection, {
      text: prompt,
      minScore: RELEVANCE_MIN,
      limit: 3,
    });
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

/** The repo-relative report path embedded in a vulnerability string, else null. */
export function parseVulnFile(vuln: string): string | null {
  const m = vuln.match(/([A-Za-z0-9_.\-/]+\/[A-Za-z0-9_.\-]+\.[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * Deterministically capture security findings from a `kodi pr create --vulnerability …`
 * as `gotcha` memories — no LLM. Each finding must carry a file (memories require one),
 * so we capture only vulns whose string embeds a report path (which kodi's own format
 * does). Hand-off capture was dropped: a hand-off has no file to verify against.
 * Deduped/idempotent. Best-effort: never throws.
 */
function captureFromCommand(command: string, cwd: string, root: string): void {
  try {
    const vulns = parseVulnerabilities(command);
    if (vulns.length === 0) return;
    const db = openDb();
    try {
      const col = resolveCollection(db, cwd);
      for (const v of vulns) {
        const file = parseVulnFile(v);
        if (!file) continue; // no file -> not storable
        insertMemory(
          db,
          col.collection,
          MemoryDraftSchema.parse({
            content: `Security finding: ${v}`,
            type: 'gotcha',
            files: [file],
          }),
          root,
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
 * A file was written/edited: flag memories linked to it as needs-reverify (cheap +
 * deterministic; the agent re-judges later). Best-effort; never throws.
 */
function flagStaleForEdit(filePath: string, root: string): void {
  try {
    if (!existsSync(ragDbPath())) return;
    const rel = isAbsolute(filePath) ? relative(root, filePath) : filePath;
    const db = openDb();
    try {
      flagStaleForFile(db, root, rel);
    } finally {
      db.close();
    }
  } catch {
    /* best-effort */
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
    .description('Capture security findings + flag file-edited memories stale (PostToolUse)')
    .action(async () => {
      const input = await readHookInput();
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
      const root = findProjectRoot(cwd);
      // Bash: capture security findings from a kodi pr create.
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      if (command) captureFromCommand(command, cwd, root);
      // Write/Edit: flag memories linked to the edited file as needs-reverify.
      const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
      if (filePath) flagStaleForEdit(filePath, root);
      // Pure side effect — emit nothing.
    });

  return hook;
}
