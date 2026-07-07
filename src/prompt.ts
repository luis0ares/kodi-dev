import { createInterface, type Interface } from 'node:readline/promises';

/**
 * Minimal interactive prompt abstraction so the init wizard is testable — tests
 * inject a scripted prompter, production uses readline. No external dependency.
 */
export interface Prompter {
  /** Pick one of `choices` (numbered). Returns the chosen value. */
  select(message: string, choices: string[]): Promise<string>;
  /** Free-text input with an optional default. */
  input(message: string, def?: string): Promise<string>;
  /** Yes/no confirmation. */
  confirm(message: string, def?: boolean): Promise<boolean>;
  close(): void;
}

export function readlinePrompter(): Prompter {
  let rl: Interface | null = null;
  const io = () => (rl ??= createInterface({ input: process.stdin, output: process.stdout }));

  return {
    async select(message, choices) {
      if (choices.length === 0) throw new Error(`${message}: no choices available`);
      process.stdout.write(`\n${message}\n`);
      choices.forEach((c, i) => process.stdout.write(`  ${i + 1}) ${c}\n`));
      while (true) {
        const answer = (await io().question(`Select [1-${choices.length}]: `)).trim();
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1];
        process.stdout.write('  Invalid selection.\n');
      }
    },
    async input(message, def) {
      const suffix = def ? ` (${def})` : '';
      const answer = (await io().question(`${message}${suffix}: `)).trim();
      return answer || def || '';
    },
    async confirm(message, def = true) {
      const hint = def ? 'Y/n' : 'y/N';
      const answer = (await io().question(`${message} [${hint}]: `)).trim().toLowerCase();
      if (!answer) return def;
      return answer.startsWith('y');
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}
