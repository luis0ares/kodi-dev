import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  DEFAULT_WORKTREES_DIR,
  findProjectRoot,
  loadBoardConfig,
  type ProviderName,
} from '../config.js';
import { DEFAULT_REMOTE, startAutopilotGit, startSliceGit } from '../git.js';
import { LegacyDataError, type LegacyDataReport } from '../providers/local.js';
import { resolveProvider } from '../providers/index.js';
import type { TicketProvider, TicketRef } from '../providers/types.js';
import {
  canonicalizeTicketKey,
  TicketSchema,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from '../templates/ticket.js';

/**
 * Make a PR reference readable in the ticket body it is written into.
 *
 * `link-pr` / `hand-off --pr` are kodi-internal BOOKKEEPING: they render a
 * `**PR:** <ref>` line into the issue/work-item body. Nothing they do — and
 * nothing GitHub exposes — populates the PR sidebar's Development panel, which
 * has no documented public REST or GraphQL mutation and is UI-only. What they
 * can do is store a value that is at least a cross-reference: `--pr 8` used to
 * render the inert literal `8`, so on GitHub a bare number becomes `#8`.
 * Azure work-item bodies are HTML with their own linkifier and their PR links
 * come from `az repos pr create --work-items`, so refs there are left as typed.
 */
export function normalizePrRef(ref: string, provider: ProviderName): string {
  const text = ref.trim();
  if (provider !== 'github') return text;
  return /^\d+$/.test(text) ? `#${text}` : text;
}

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
  draft.dependencies = draft.dependencies.map(canonicalizeTicketKey);
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
  provider: Pick<TicketProvider, 'list' | 'get'>,
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
    if (known.has(d)) continue;
    // The listing stops at the Done column, so "not listed" is not yet proof of a
    // typo — a dependency on finished work is the normal case. Confirm with one
    // targeted read (only for keys the listing did not already vouch for) rather
    // than warning about every satisfied dependency. A lookup that THROWS counts
    // as unknown: `az boards work-item show` exits non-zero for an id that does
    // not exist, and the listing above already proved the provider is reachable.
    let exists = false;
    try {
      exists = (await provider.get(d)) !== null;
    } catch {
      exists = false;
    }
    if (exists) continue;
    process.stderr.write(
      `warning: dependency ${d} matches no existing ticket (typo, or not created yet?)\n`,
    );
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
    .option('--iteration <name>', 'assign to an iteration/sprint (azure/github only)')
    .option(
      '--repository <repo>',
      'file the ticket in another repository (github only: OWNER/REPO)',
    )
    .option(
      '--no-project',
      'create the issue only — do not add it to the Projects v2 board (github only)',
    )
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (o) => {
      const draft = draftFromOptions(o);
      const provider = resolveProvider(process.cwd(), {
        yes: o.yes,
        repository: o.repository,
        noProject: o.project === false,
      });
      await warnUnknownDependencies(provider, draft.dependencies);
      try {
        let created: Awaited<ReturnType<typeof provider.create>> & { iteration?: string } =
          await provider.create(draft);
        // Iteration is board-native (see setIteration's doc) — assigned as a
        // separate step, never through create()'s Ticket draft. Skipped for a
        // dry-run preview (created.key is the '(dry-run)' placeholder, which
        // no provider can actually resolve/mutate against).
        if (o.iteration && created.key !== '(dry-run)') {
          created = await provider.setIteration(created.key, o.iteration);
        }
        out(created, o.json, () => {
          const line = `Created ${created.key} (${created.status}) — ${created.title}`;
          return o.iteration && created.key === '(dry-run)'
            ? `${line}\n(would assign iteration "${o.iteration}" — skipped in dry-run)`
            : line;
        });
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
    .description('List open tickets (Done is fetched only with --all)')
    .option('-a, --all', 'include the Done column', false)
    .option(
      '--iteration <name>',
      'list one iteration/sprint instead of the current one (azure/github only)',
    )
    .option(
      '--all-iterations',
      'disable iteration filtering — list tickets from every sprint (azure/github only)',
      false,
    )
    .option('--json', 'machine-readable output', false)
    .action(async (o) => {
      const refs = await resolveProvider().list({
        includeDone: o.all,
        iteration: o.iteration,
        allIterations: o.allIterations,
      });
      out(refs, o.json, () => {
        const body = refs.length
          ? refs
              .map(
                (t) =>
                  `${t.key}  ${t.status.padEnd(12)}  ${t.title}${t.iteration ? `  [${t.iteration}]` : ''}`,
              )
              .join('\n')
          : 'No tickets.';
        // Say what is missing, or an empty-looking board reads as an empty board.
        return o.all ? body : `${body}\n(Done tickets not fetched — pass --all)`;
      });
    });

  tickets
    .command('iterations')
    .description('List all iterations/sprints (azure/github only)')
    .option('--json', 'machine-readable output', false)
    .action(async (o) => {
      const its = await resolveProvider().listIterations();
      out(its, o.json, () =>
        its.length
          ? its
              .map(
                (i) =>
                  `${i.current ? '* ' : '  '}${i.name}${i.startDate ? `  (${i.startDate} → ${i.endDate ?? '?'})` : ''}`,
              )
              .join('\n')
          : 'No iterations.',
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
    .command('tree')
    .description('Dependency tree of every not-done ticket, with its status')
    .option('--json', 'machine-readable output', false)
    .action(async (o) => {
      const refs = await resolveProvider().list();
      const forest = buildDependencyForest(refs);
      out(forest.map(treeNodeToJson), o.json, () => renderForest(forest));
    });

  tickets
    .command('get <key>')
    // `show` is the name people reach for first; aliasing it beats answering a
    // guess with a bare `unknown command 'show'`.
    .alias('show')
    .description('Show one ticket (alias: show)')
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      key = canonicalizeTicketKey(key);
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
      key = canonicalizeTicketKey(key);
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
    .description(
      'Mark a ticket started (In progress, assigned to you on github/azure) and cut its ' +
        'slice/kodi-<id> branch — or an isolated worktree with --worktree, or the worktree ' +
        'an autopilot run shares with --autopilot',
    )
    .option(
      '--worktree',
      'create an isolated git worktree instead of checking out the branch in place',
      false,
    )
    .option(
      '--no-branch',
      'skip branch/worktree creation — use when bundling several tickets onto one ' +
        'already-cut branch (only the first `start` in the batch omits this)',
    )
    .option(
      '--push',
      'also publish the branch with upstream tracking (`git push -u`) — a PR head ' +
        'must exist on the remote before `kodi pr create` can open against it',
      false,
    )
    .option('--remote <name>', 'remote --push targets', DEFAULT_REMOTE)
    .option(
      '--autopilot <slug>',
      'cut or reuse one worktree on a branch named <slug>, shared by every ticket of an ' +
        'autopilot run, instead of slice/kodi-<id> (implies --worktree)',
    )
    .option(
      '--base <ref>',
      'base a NEW branch on this ref instead of sourceBranch or the current branch',
    )
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      key = canonicalizeTicketKey(key);
      for (const [flag, set] of [
        ['--autopilot', o.autopilot],
        ['--base', o.base],
      ]) {
        if (set && o.branch === false) {
          process.stderr.write(`${flag} and --no-branch are mutually exclusive\n`);
          process.exitCode = 1;
          return;
        }
      }
      if (o.worktree && o.branch === false) {
        process.stderr.write('--worktree and --no-branch are mutually exclusive\n');
        process.exitCode = 1;
        return;
      }
      if (o.push && o.branch === false) {
        process.stderr.write('--push and --no-branch are mutually exclusive\n');
        process.exitCode = 1;
        return;
      }
      let git: { branch: string; worktreePath?: string; pushed: boolean } | undefined;
      if (o.branch !== false) {
        const cfg = loadBoardConfig(process.cwd());
        const gitOpts = {
          worktreesDir: cfg.worktreesDir ?? DEFAULT_WORKTREES_DIR,
          root: findProjectRoot(process.cwd()),
          dryRun: !o.yes,
          sourceBranch: o.base ?? cfg.sourceBranch,
          push: o.push,
          remote: o.remote,
        };
        git = o.autopilot
          ? startAutopilotGit(o.autopilot, {
              ...gitOpts,
              reserved: [o.base, cfg.sourceBranch, cfg.prTarget],
            })
          : startSliceGit(key, { ...gitOpts, worktree: o.worktree });
      }
      const t = await resolveProvider(process.cwd(), { yes: o.yes }).start(key, {
        branch: git?.branch,
      });
      out(
        {
          ...t,
          branch: git?.branch,
          worktreePath: git?.worktreePath,
          ...(git ? { pushed: git.pushed } : {}),
        },
        o.json,
        () =>
          [
            `${t.key} → ${t.status}`,
            git
              ? git.worktreePath
                ? `worktree: ${git.worktreePath}`
                : `branch: ${git.branch}`
              : 'branch: skipped (--no-branch)',
            // A branch that exists only locally cannot be a PR head — say so at
            // `start`, rather than letting `pr create` be the one to discover it.
            git && !git.pushed
              ? `(local only — push it before \`kodi pr create\`, or re-run with --push)`
              : undefined,
          ]
            .filter(Boolean)
            .join('\n'),
      );
    });

  tickets
    .command('delete <key>')
    .description('Delete a ticket')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      key = canonicalizeTicketKey(key);
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
    .option('--iteration <name>', 'assign to an iteration/sprint (azure/github only)')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      key = canonicalizeTicketKey(key);
      const patch: Partial<Ticket> = o.file
        ? TicketSchema.partial().parse(JSON.parse(readFileSync(String(o.file), 'utf-8')))
        : buildPatch(o);
      if (patch.dependencies) patch.dependencies = patch.dependencies.map(canonicalizeTicketKey);
      const provider = resolveProvider(process.cwd(), { yes: o.yes });
      if (patch.dependencies) await warnUnknownDependencies(provider, patch.dependencies);
      // Iteration is board-native (see setIteration's doc) — never rides in the
      // Ticket patch. `--iteration` alone skips amend() entirely (no point
      // re-writing the ticket record for a purely board-native change); both
      // together apply the patch first, then the iteration, printing the latter.
      const hasPatch = Boolean(o.file) || Object.keys(patch).length > 0;
      let t: Awaited<ReturnType<typeof provider.amend>> & { iteration?: string };
      if (hasPatch) {
        t = await provider.amend(key, patch);
        if (o.iteration) t = await provider.setIteration(key, o.iteration);
      } else if (o.iteration) {
        t = await provider.setIteration(key, o.iteration);
      } else {
        t = await provider.amend(key, patch); // preserves today's behavior for a flagless amend
      }
      out(t, o.json, () => `Amended ${t.key}`);
    });

  tickets
    .command('link-pr <key> <pr>')
    .description(
      "Record a pull request on the ticket — writes a **PR:** line into the ticket's " +
        "body. kodi bookkeeping only: it does not populate GitHub's Development panel",
    )
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, pr, o) => {
      key = canonicalizeTicketKey(key);
      const ref = normalizePrRef(pr, loadBoardConfig(process.cwd()).provider);
      const t = await resolveProvider(process.cwd(), { yes: o.yes }).amend(key, { prUrl: ref });
      out(t, o.json, () => `${t.key} ↔ ${ref}`);
    });

  tickets
    .command('deps <key>')
    .description("Read a ticket's dependencies, or declare new ones with --add")
    .option('--add <key>', 'declare a dependency (repeatable)', collect, [])
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      key = canonicalizeTicketKey(key);
      const provider = resolveProvider(process.cwd(), { yes: o.yes });
      const current = await provider.get(key);
      if (!current) {
        process.stderr.write(`ticket ${key} not found\n`);
        process.exitCode = 1;
        return;
      }
      if (o.add.length) {
        const added = (o.add as string[]).map(canonicalizeTicketKey);
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
    .description(
      'End of slice: move to To review and optionally record the PR. Idempotent — ' +
        're-running on a ticket already in To review just (re-)writes the PR link',
    )
    .option('--pr <ref>', 'record the PR at hand-off (same bookkeeping as link-pr)')
    .option('--yes', 'execute remote mutations (default: dry-run)', false)
    .option('--json', 'machine-readable output', false)
    .action(async (key, o) => {
      key = canonicalizeTicketKey(key);
      const provider = resolveProvider(process.cwd(), { yes: o.yes });
      const ref = o.pr ? normalizePrRef(o.pr, loadBoardConfig(process.cwd()).provider) : undefined;
      if (ref) await provider.amend(key, { prUrl: ref });
      const t = await provider.setStatus(key, 'To review');
      out(t, o.json, () => `${t.key} → ${t.status}${ref ? ` (PR ${ref})` : ''}`);
    });

  return tickets;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * A node in the not-done dependency forest built by {@link buildDependencyForest}.
 * `base` marks a dependency-free root (nothing left to do before it — a "start
 * here" ticket); `repeat` marks a node re-encountered via a second dependency edge
 * (a DAG), shown once more as a reference but not re-expanded.
 */
export interface TreeNode {
  ref: TicketRef;
  children: TreeNode[];
  base: boolean;
  repeat: boolean;
}

/** Numeric-aware key sort so `1206` < `1210` and `KODI-2` < `KODI-10`. */
function byKeyNumeric(a: TicketRef, b: TicketRef): number {
  return a.key.localeCompare(b.key, undefined, { numeric: true });
}

/**
 * Build the dependency forest of every not-done ticket. A ticket hangs beneath
 * each not-done ticket it depends on; a dependency already Done is satisfied and
 * creates no edge, so a ticket whose blockers are all Done surfaces as a root
 * ("base"). Done tickets are excluded entirely. DAG re-encounters are shown once
 * (marked `repeat`) and not re-expanded, and any node left unreachable by a
 * dependency cycle is still surfaced as a non-base pseudo-root so nothing is lost.
 */
export function buildDependencyForest(refs: TicketRef[]): TreeNode[] {
  const active = refs.filter((t) => t.status !== 'Done');
  const byKey = new Map(active.map((t) => [t.key, t]));
  const children = new Map<string, TicketRef[]>();
  const blockerCount = new Map<string, number>();
  for (const t of active) {
    let blockers = 0;
    for (const dep of t.dependencies) {
      if (!byKey.has(dep)) continue; // dep is Done / unknown → not a tree edge
      blockers++;
      const arr = children.get(dep) ?? [];
      arr.push(t);
      children.set(dep, arr);
    }
    blockerCount.set(t.key, blockers);
  }

  const seen = new Set<string>();
  const build = (ref: TicketRef, base: boolean): TreeNode => {
    if (seen.has(ref.key)) return { ref, children: [], base, repeat: true };
    seen.add(ref.key);
    const kids = (children.get(ref.key) ?? [])
      .slice()
      .sort(byKeyNumeric)
      .map((k) => build(k, false));
    return { ref, children: kids, base, repeat: false };
  };

  const roots = active.filter((t) => (blockerCount.get(t.key) ?? 0) === 0).sort(byKeyNumeric);
  const forest = roots.map((r) => build(r, true));
  // Cycle survivors (never reached from a root) — surface rather than drop them.
  for (const ref of active.slice().sort(byKeyNumeric))
    if (!seen.has(ref.key)) forest.push(build(ref, false));
  return forest;
}

/** One tree line: `<key>  (<status>)  <title>` plus a base/repeat annotation. */
function formatTreeNode(node: TreeNode): string {
  let line = `${node.ref.key}  (${node.ref.status})  ${node.ref.title}`;
  if (node.repeat) line += '  ⇢ (shown above)';
  else if (node.base) line += node.ref.status === 'Pending' ? '  [BASE] ◄ start here' : '  [BASE]';
  return line;
}

/** Render the forest with box-drawing branches (`├─`/`└─`/`│`). */
export function renderForest(forest: TreeNode[]): string {
  if (forest.length === 0) return 'No not-done tickets to show.';
  const lines: string[] = [];
  const walk = (node: TreeNode, prefix: string, isLast: boolean) => {
    lines.push(`${prefix}${isLast ? '└─ ' : '├─ '}${formatTreeNode(node)}`);
    const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
    node.children.forEach((c, i) => walk(c, childPrefix, i === node.children.length - 1));
  };
  forest.forEach((n, i) => walk(n, '', i === forest.length - 1));
  return lines.join('\n');
}

/** Serialize a forest node to the nested `--json` shape (mirrors the visual tree). */
function treeNodeToJson(node: TreeNode): unknown {
  return {
    key: node.ref.key,
    status: node.ref.status,
    title: node.ref.title,
    base: node.base,
    ...(node.repeat ? { repeat: true } : {}),
    children: node.children.map(treeNodeToJson),
  };
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
