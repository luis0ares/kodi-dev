import { Command } from 'commander';
import { ORCHESTRATOR_BOOTSTRAP } from '../bootstrap.js';

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
          additionalContext: ORCHESTRATOR_BOOTSTRAP,
        },
      };
      process.stdout.write(JSON.stringify(payload));
    });

  return hook;
}
