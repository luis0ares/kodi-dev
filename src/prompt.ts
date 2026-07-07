import { confirm as inqConfirm, input as inqInput, select as inqSelect } from '@inquirer/prompts';

/**
 * Minimal interactive prompt abstraction so the init wizard is testable — tests
 * inject a scripted prompter, production uses @inquirer/prompts (arrow-key
 * navigation, type-to-filter, paginated lists). Non-TTY calls fall back to
 * defaults so automation/CI never hangs.
 */
export interface Prompter {
  /** Pick one of `choices` with the arrow keys (Enter confirms). */
  select(message: string, choices: string[]): Promise<string>;
  /** Free-text input with an optional default. */
  input(message: string, def?: string): Promise<string>;
  /** Yes/no confirmation. */
  confirm(message: string, def?: boolean): Promise<boolean>;
  close(): void;
}

export function readlinePrompter(): Prompter {
  return {
    async select(message, choices) {
      if (choices.length === 0) throw new Error(`${message}: no choices available`);
      if (!process.stdin.isTTY) {
        throw new Error(`cannot prompt "${message}" in non-interactive mode — pass the corresponding flag`);
      }
      return inqSelect({
        message,
        choices: choices.map((c) => ({ value: c, name: c })),
        loop: false,
      });
    },
    async input(message, def) {
      if (!process.stdin.isTTY) return def ?? '';
      return inqInput({ message, default: def });
    },
    async confirm(message, def = true) {
      if (!process.stdin.isTTY) return def;
      return inqConfirm({ message, default: def });
    },
    close() {
      /* @inquirer manages its own lifecycle per prompt */
    },
  };
}
