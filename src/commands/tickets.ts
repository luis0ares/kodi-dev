import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { LegacyDataError, type LegacyDataReport } from '../providers/local.js';
import { resolveProvider } from '../providers/index.js';
import type { TicketProvider } from '../providers/types.js';
import {
  canonicalizeDependencyKey,
  TicketSchema,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from '../templates/ticket.js';

function out(data: unknown, json: boolean, human: () => string) {
  if (json) process.stdout.write(JSON.stringify(data) + '\n');
  else process.stdout.write(human() + '\n');
}

/** Build a ticket draft from a JSON file or from repeatable flags. Dependency
 * keys are canonicalized (e.g. `KODI-1` → `KODI-001`) so hand-typed refs resolve
 * against the generated keys instead of silently blocking. */
function draftFromOptions(o: Record<string, unknown>): Ticket {
  const draft = o.file
    ? TicketSchema.parse(JSON.parse(readFileSync(String(o.file), 'utf-8')))
    : TicketSchema.parse({
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
  draft.dependencies = draft.dependencies.map(canonicalizeDependencyKey);
  return draft;
}

/**
 * Best-effort advisory: warn (never block) on any declared dependency key that
 * matches no existing ticket — the typo that would otherwise keep a ticket
 * blocked forever with no signal. Runs only when deps are declared, so dep-less
 * commands pay no extra provider round-trip, and swallows a listing failure so
 * the advisory can never turn a valid mutation into an error.
 */
async function warnUnknownDependencies(
  provider: Pick<TicketProvider, 'list'>,
  deps: string[],
): Promise<void> {
  if (!deps.length) return;
  let known: Set<string>;
  try {
    known = new Set((await provider.list()).map((t) => t.key));
  } catch {
    return;
  }
  for (const d of deps) {
    if (!known.has(d)) {
      process.stderr.write(
        `warning: dependency ${d} matches no existing ticket (typo, or not created yet?)\n`,
      );
    }
  }
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
      const provider = resolveProvider(process.cwd(), { yes: o.yes });
      await warnUnknownDependencies(provider, draft.dependencies);
      try {
        const created = await provider.create(draft);
        out(created, o.json, () => `Created ${created.key} (${created.status}) — ${created.title}`);
      } catch (err) {
        // Clean-start hard stop (ADR-0001 §2.6): render the refusal on BOTH the
        // human and structured `--json` surfaces via out(), then exit non-zero.
        // Do NOT rethrow — the generic index.ts catch only writes stderr and would
        // miss the machine-readable surface.
        if (err instanceof LegacyDataError) {
          out(err.report, o.json, () => renderLegacyRefusal(err.report));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
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
      const t = await resolveProvider(process.cwd(), { yes: o.yes }).setStatus(
        key,
        status as TicketStatus,
      );
      out(t, o.json, () => `${t.key} → ${t.status}`);
    });

  tickets
    .command('start <key>')
    .description('Mark a ticket started (In progress)')
    .option('--branch <name>')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      const t = await resolveProvider(process.cwd(), { yes: o.yes }).start(key, {
        branch: o.branch,
      });
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

  tickets
    .command('amend <key>')
    .description('Edit a ticket (from --file patch or flags)')
    .option('-f, --file <path>', 'JSON patch (validated against the template)')
    .option('-s, --summary <text>')
    .option('--notes <text>')
    .option('--ac <criterion>', 'replace acceptance criteria (repeatable)', collect, [])
    .option('--dep <key>', 'replace dependencies (repeatable)', collect, [])
    .option('--pr <ref>', 'link a PR')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      const patch: Partial<Ticket> = o.file
        ? TicketSchema.partial().parse(JSON.parse(readFileSync(String(o.file), 'utf-8')))
        : buildPatch(o);
      if (patch.dependencies) patch.dependencies = patch.dependencies.map(canonicalizeDependencyKey);
      const provider = resolveProvider(process.cwd(), { yes: o.yes });
      if (patch.dependencies) await warnUnknownDependencies(provider, patch.dependencies);
      const t = await provider.amend(key, patch);
      out(t, o.json, () => `Amended ${t.key}`);
    });

  tickets
    .command('link-pr <key> <pr>')
    .description('Bind a pull request to a ticket')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, pr, o) => {
      const t = await resolveProvider(process.cwd(), { yes: o.yes }).amend(key, { prUrl: pr });
      out(t, o.json, () => `${t.key} ↔ ${pr}`);
    });

  tickets
    .command('deps <key>')
    .description("Read a ticket's dependencies, or declare new ones with --add")
    .option('--add <key>', 'declare a dependency (repeatable)', collect, [])
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      const provider = resolveProvider(process.cwd(), { yes: o.yes });
      const current = await provider.get(key);
      if (!current) {
        process.stderr.write(`ticket ${key} not found\n`);
        process.exitCode = 1;
        return;
      }
      if (o.add.length) {
        const added = (o.add as string[]).map(canonicalizeDependencyKey);
        await warnUnknownDependencies(provider, added);
        const deps = Array.from(new Set([...current.dependencies, ...added]));
        const t = await provider.amend(key, { dependencies: deps });
        out(t.dependencies, o.json, () => `${key} deps: ${t.dependencies.join(', ') || '(none)'}`);
      } else {
        out(
          current.dependencies,
          o.json,
          () => `${key} deps: ${current.dependencies.join(', ') || '(none)'}`,
        );
      }
    });

  tickets
    .command('hand-off <key>')
    .description('End of slice: move to To review and optionally link the PR')
    .option('--pr <ref>', 'link the PR at hand-off')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      const provider = resolveProvider(process.cwd(), { yes: o.yes });
      if (o.pr) await provider.amend(key, { prUrl: o.pr });
      const t = await provider.setStatus(key, 'To review');
      out(t, o.json, () => `${t.key} → ${t.status}${o.pr ? ` (PR ${o.pr})` : ''}`);
    });

  return tickets;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Human-readable clean-start refusal. Built only from the fixed folder names and
 * the numeric count in the report (SR-J: no attacker-controlled filenames or
 * frontmatter interpolated). Names the folders + count, states clean-start will
 * not migrate, and instructs the user how to proceed.
 */
function renderLegacyRefusal(report: LegacyDataReport): string {
  const list = report.folders.map((f) => `docs/tickets/${f}`).join(' and ');
  const files = `${report.ticketCount} ticket file${report.ticketCount === 1 ? '' : 's'}`;
  return (
    `Refusing to create: legacy ticket data detected under ${list} (at least ${files}).\n` +
    `kodi uses a clean-start model and will not migrate, move, or modify legacy tickets.\n` +
    `Move or remove the legacy tickets under ${list}, then re-run.`
  );
}

/** Build a partial ticket patch from only the flags the user actually set. */
function buildPatch(o: Record<string, any>): Partial<Ticket> {
  const patch: Partial<Ticket> = {};
  if (o.summary !== undefined) patch.summary = o.summary;
  if (o.notes !== undefined) patch.notes = o.notes;
  if (o.ac?.length) patch.acceptanceCriteria = o.ac;
  if (o.dep?.length) patch.dependencies = o.dep;
  if (o.pr) patch.prUrl = o.pr;
  return patch;
}
