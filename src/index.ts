import { Command } from 'commander';
import { registerAddCommand } from './commands/add.js';
import { registerHookCommand } from './commands/hook.js';
import { registerInitCommand } from './commands/init.js';
import { registerPrCommand } from './commands/pr.js';
import { registerTicketsCommand } from './commands/tickets.js';

import { version, name, description } from '../package.json';

const program = new Command();

program
  .name(name)
  .description(description)
  .version(version, '-v, --version', 'output the current version');

registerTicketsCommand(program);
registerPrCommand(program);
registerHookCommand(program);
registerInitCommand(program);
registerAddCommand(program);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
