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

The build-orchestrator is the hub: engineers (`backend-engineer`,
`frontend-engineer`) write feature code; testers (`backend-tester`,
`frontend-tester`) write tests; `refactor-engineer` tidies the code behavior-
preservingly as the last implementation step (once tests are green); gates
(`qa-implementation`, `qa-visual`) plus a `security` bracket. The slice closes ONLY when every gate is green, there is no
Critical/High security finding, and qa-implementation AND qa-visual are positive.

**Regression first, full gate last.** Throughout implementation the feedback signal is
a scoped regression over the areas the slice touched — never the full suite. The full
gate runs once, at the end, purely to confirm nothing else broke. **A red regression
stops the slice**: it routes straight back to the owning engineer, and no
`refactor-engineer`, `qa-implementation`, `qa-visual` or `security` verify is spawned
over known-broken code.

**The roster is triaged, not fixed.** The orchestrator scouts the slice once, writes
a Slice Brief that every sub-agent works from, and spawns only the specialists the
slice's surface actually needs — a backend-only slice runs no frontend agents and no
`qa-visual`; a slice with no security surface skips the guidance pass; the refactor
pass is conditional on the diff warranting it. This is deliberate: re-derived context
and unnecessary full-gate runs are what make a slice expensive.
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
   the security bracket, the slice→gate loop, and the hand-off.
6. **Relay** its result (the sub-agent's output is not shown to the human directly).
