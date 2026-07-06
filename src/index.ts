import { Command } from 'commander';
import { registerHookCommand } from './commands/hook.js';
import { registerInitCommand } from './commands/init.js';
import { registerTicketsCommand } from './commands/tickets.js';

const program = new Command();

program
  .name('kodi')
  .description('kodi.dev — Claude Code-native agent orchestrator')
  .version('0.0.0');

registerTicketsCommand(program);
registerHookCommand(program);
registerInitCommand(program);

// --- Skeletons wired in later phases (F4/F5) -------------------------------
program
  .command('pr')
  .description('Manage pull requests (proxy gh/az) — F5')
  .action(() => {
    process.stderr.write('kodi pr: not implemented yet (F5).\n');
    process.exitCode = 1;
  });

program
  .command('add')
  .description('Install a skill-pack — F5')
  .action(() => {
    process.stderr.write('kodi add: not implemented yet (F5).\n');
    process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
