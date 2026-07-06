import { Command } from 'commander';
import { registerAddCommand } from './commands/add.js';
import { registerHookCommand } from './commands/hook.js';
import { registerInitCommand } from './commands/init.js';
import { registerPrCommand } from './commands/pr.js';
import { registerTicketsCommand } from './commands/tickets.js';

const program = new Command();

program
  .name('kodi')
  .description('kodi.dev — Claude Code-native agent orchestrator')
  .version('0.0.0');

registerTicketsCommand(program);
registerPrCommand(program);
registerHookCommand(program);
registerInitCommand(program);
registerAddCommand(program);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
