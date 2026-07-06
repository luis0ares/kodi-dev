import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { resolveProvider } from '../providers/index.js';
import { TicketSchema, TICKET_STATUSES, type TicketStatus } from '../templates/ticket.js';

function out(data: unknown, json: boolean, human: () => string) {
  if (json) process.stdout.write(JSON.stringify(data) + '\n');
  else process.stdout.write(human() + '\n');
}

/** Build a ticket draft from a JSON file or from repeatable flags. */
function draftFromOptions(o: Record<string, unknown>) {
  if (o.file) {
    const raw = JSON.parse(readFileSync(String(o.file), 'utf-8'));
    return TicketSchema.parse(raw);
  }
  return TicketSchema.parse({
    title: o.title,
    summary: o.summary,
    acceptanceCriteria: o.ac ?? [],
    nonGoals: o.nonGoal ?? [],
    dependencies: o.dep ?? [],
    drivers: {
      prd: o.prd,
      adr: o.adr ?? [],
      security: o.security,
    },
    notes: o.notes,
  });
}

export function registerTicketsCommand(program: Command) {
  const tickets = program
    .command('tickets')
    .description('Manage tickets across the active provider (local / github / azure)');

  tickets
    .command('create')
    .description('Create a ticket (validates the template)')
    .option('-f, --file <path>', 'JSON draft file (validated against the ticket template)')
    .option('-t, --title <title>')
    .option('-s, --summary <summary>')
    .option('--ac <criterion>', 'acceptance criterion (repeatable)', collect, [])
    .option('--non-goal <text>', 'non-goal (repeatable)', collect, [])
    .option('--dep <key>', 'dependency ticket key (repeatable)', collect, [])
    .option('--prd <ref>', 'PRD driver')
    .option('--adr <ref>', 'ADR driver (repeatable)', collect, [])
    .option('--security <ref>', 'security driver')
    .option('--notes <text>')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (o) => {
      const draft = draftFromOptions(o);
      const created = await resolveProvider(process.cwd(), { yes: o.yes }).create(draft);
      out(created, o.json, () => `Created ${created.key} (${created.status}) — ${created.title}`);
    });

  tickets
    .command('list')
    .description('List all tickets')
    .option('--json', 'machine-readable output', false)
    .action(async (o) => {
      const refs = await resolveProvider().list();
      out(refs, o.json, () =>
        refs.length
          ? refs.map((t) => `${t.key}  ${t.status.padEnd(12)}  ${t.title}`).join('\n')
          : 'No tickets.',
      );
    });

  tickets
    .command('list-ready')
    .description('List tickets ready to start (no unmet dependency) + the blocked set')
    .option('--json', 'machine-readable output', false)
    .action(async (o) => {
      const res = await resolveProvider().listReady();
      out(res, o.json, () => {
        const ready = res.ready.map((t) => `  ${t.key}  ${t.title}`).join('\n') || '  (none)';
        const blocked =
          res.blocked
            .map((b) => `  ${b.ticket.key}  ${b.ticket.title}  ← ${b.blockedBy.join(', ')}`)
            .join('\n') || '  (none)';
        return `Ready:\n${ready}\n\nBlocked:\n${blocked}`;
      });
    });

  tickets
    .command('get <key>')
    .description('Show one ticket')
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      const t = await resolveProvider().get(key);
      if (!t) {
        process.stderr.write(`ticket ${key} not found\n`);
        process.exitCode = 1;
        return;
      }
      out(t, o.json, () => JSON.stringify(t, null, 2));
    });

  tickets
    .command('set-status <key> <status>')
    .description(`Transition a ticket (${TICKET_STATUSES.join(' | ')})`)
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, status, o) => {
      if (!TICKET_STATUSES.includes(status as TicketStatus)) {
        process.stderr.write(`invalid status "${status}". One of: ${TICKET_STATUSES.join(', ')}\n`);
        process.exitCode = 1;
        return;
      }
      const t = await resolveProvider(process.cwd(), { yes: o.yes }).setStatus(key, status as TicketStatus);
      out(t, o.json, () => `${t.key} → ${t.status}`);
    });

  tickets
    .command('start <key>')
    .description('Mark a ticket started (In progress)')
    .option('--branch <name>')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      const t = await resolveProvider(process.cwd(), { yes: o.yes }).start(key, { branch: o.branch });
      out(t, o.json, () => `${t.key} → ${t.status}`);
    });

  tickets
    .command('delete <key>')
    .description('Delete a ticket')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      await resolveProvider(process.cwd(), { yes: o.yes }).delete(key);
      out({ deleted: key }, o.json, () => `Deleted ${key}`);
    });

  tickets
    .command('next-id')
    .description('Compute the next ticket key')
    .option('--json', 'machine-readable output', false)
    .action(async (o) => {
      const id = await resolveProvider().nextId();
      out({ nextId: id }, o.json, () => id);
    });

  return tickets;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
