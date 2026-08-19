---
name: ticket-start
description: >-
  Start ONE backlog ticket and drive it as a vertical slice via the
  build-orchestrator. Use this whenever the user runs /ticket-start, or says things
  like "start ticket KODI-014", "begin the next slice", "build this ticket",
  "let's implement <ticket>", "pick up the next ready ticket", "kick off the build"
  — anytime build work should begin on a ticket.
---

# /ticket-start [ticket] — Build one vertical slice

Resolve which ticket (recommend from `kodi tickets list-ready` if none given),
collect an optional complement, decide branch vs. worktree, **move the ticket to
In progress and cut its branch/worktree with `kodi tickets start <key> --yes`**
(`--worktree` per that decision), then spawn the `build-orchestrator` sub-agent
to drive it end-to-end.

**`kodi tickets start <key> --yes` is mandatory and always precedes the
`build-orchestrator` spawn.** Never skip it, never spawn the orchestrator first.
`--yes` is required: without it the call is a dry-run and nothing moves — no board
transition, no branch, no worktree. The command assigns the ticket to the user,
transitions it to the `In progress` column configured at `kodi init`, and cuts a
`slice/kodi-<id>` branch (or, with `--worktree`, a worktree — see below) — so the
board and the working tree both reflect that work started before any code is
written.

## Branch or worktree

Every slice gets a `slice/kodi-<id>` branch, based on the current active branch
(or, if `sourceBranch` is set in `kodi-dev.yaml`, that fixed base every time,
regardless of what's currently checked out). By default `kodi tickets start`
checks it out in place (the current working tree switches to it). Pass
`--worktree` instead to create an isolated worktree at
`.claude/worktrees/slice-kodi-<id>` (the branch's `/` is flattened to `-` in the
directory name so worktrees don't all nest under one shared `slice/` folder;
configurable via `worktreesDir` in `kodi-dev.yaml`) — the current checkout is
left untouched, useful for running another slice in parallel or keeping a
long-lived session on its own branch.

If the human's complement already says how to start it ("in a worktree", "on a
new branch", …), use that. Otherwise ask, after collecting the complement and
before starting the ticket: branch (switches the current checkout) or worktree
(own directory, current checkout untouched)?

## Starting multiple tickets at once

If the complement names more than one ticket to build together as one slice, run
`kodi tickets start` once per ticket — but only the FIRST call cuts the
branch/worktree. Every following call adds `--no-branch`, so it only moves the
board status and skips creating another branch/worktree for what is really one
shared slice:

```bash
kodi tickets start 123 --yes                 # cuts slice/kodi-123 (or --worktree)
kodi tickets start 456 --no-branch --yes     # → In progress only, same branch
kodi tickets start 789 --no-branch --yes     # → In progress only, same branch
```

`--worktree` and `--no-branch` are mutually exclusive on a single call (a
worktree IS a branch) — `kodi` rejects the combination.

The roster is deliberately small: one engineer per side (`backend-engineer`,
`frontend-engineer`) owns its code, its tests AND its QA in a single context — there are
no tester agents. Each engineer invokes **its own QA** (`backend-qa`, `frontend-qa`),
which answers to that engineer and verifies, criterion by criterion, that the work
actually meets the ticket's acceptance criteria: **MET**, **MET DIFFERENTLY** (allowed
only with a convincing, evidenced justification — what was asked, what was built, the
proof it reaches the same goal, why the wording was impossible), or **NOT MET**
(blocking). The QA agents also run their side's gate, once.

**The build-orchestrator owns the whole, and only it declares the ticket green.** It
scouts once, delegates, then does what no single engineer can: check that the two sides
fit the same contract, that every acceptance criterion is claimed by somebody, and that
the cross-side check is clean. It accepts or rejects each MET DIFFERENTLY. Only after
that does it open the PR and hand off — the ticket is finished when the orchestrator
says so, not when a QA passes.

**Security and refactor are NOT slice steps.** They are human-invoked skills —
`/security` audits a scope you name, `/refactor` cleans up a target you name — and the
orchestrator never spawns them. If a slice surfaces something worth either, it says so
in its report and you decide.

**Regression first, side gates inside QA, cross-side check last.** While implementing,
the feedback signal is a scoped regression over what the slice touched — never the full
suite. Each side's full gate runs once inside its QA; the orchestrator runs only the
cross-side integration/E2E check, and never re-runs a side gate. **A red report stops
the slice**: it routes straight back to the owning engineer. Remediation is capped at 2
rounds; a slice that will not converge is surfaced to the human instead of looped on.

**The roster is triaged, not fixed.** The orchestrator writes a Slice Brief that every
sub-agent works from and spawns only the side(s) the slice's surface actually needs — a
backend-only slice runs no frontend agent and no `frontend-qa`. This is deliberate:
re-derived context, split code/test hand-offs and duplicated gate runs are what make a
slice expensive.

Take the PR to `To Review` via `kodi pr` — never to `Done`. On remote boards this
is binding: `.claude/rules/ticket-completion.md` (In review + PR on finish; `Done`
only on the user's explicit order).

## Flow

1. **Resolve the ticket(s)** — one or more given keys, or recommend from
   `kodi tickets list-ready`. Several keys named together (e.g. "start 123, 456
   and 789") means one bundled slice on one shared branch/worktree — see
   *Starting multiple tickets at once* above.
2. **Optional complement** — let the human add detail not in the ticket; if it
   contradicts the ticket, reconcile first (the complement wins) and confirm.
3. **Choose branch or worktree** — from the complement if it already said so;
   otherwise ask (see *Branch or worktree* above).
4. **Start the ticket(s) on the board** — `kodi tickets start <key> --yes` (add
   `--worktree` per step 3; add `--no-branch` on every key after the first when
   bundling several). Assigns each to the user, moves it to the configured
   `In progress` column, and — once, for the first key — cuts the branch/worktree.
   This runs BEFORE the
   orchestrator is spawned, every time.
5. **Spawn `build-orchestrator`** with the ticket(s) + complement + the branch name
   (and the worktree path as its working directory, if one was created); it owns
   the slice→gate loop and the hand-off.
6. **Relay** its result (the sub-agent's output is not shown to the human directly).
