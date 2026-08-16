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
collect an optional complement, **move the ticket to In progress with
`kodi tickets start <key> --yes`**, then spawn the `build-orchestrator` sub-agent
to drive it end-to-end on its own branch.

**`kodi tickets start <key> --yes` is mandatory and always precedes the
`build-orchestrator` spawn.** Never skip it, never spawn the orchestrator first.
`--yes` is required: without it the call is a dry-run and nothing moves. The
command assigns the ticket to the user and transitions it to the `In progress`
column configured at `kodi init` — so the board reflects that work started before
any code is written.

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

1. **Resolve the ticket** — a given key, or recommend from `kodi tickets list-ready`.
2. **Optional complement** — let the human add detail not in the ticket; if it
   contradicts the ticket, reconcile first (the complement wins) and confirm.
3. **Start the ticket on the board** — `kodi tickets start <key> --yes`. Assigns it
   to the user and moves it to the configured `In progress` column. This runs
   BEFORE the orchestrator is spawned, every time.
4. **Spawn `build-orchestrator`** with the ticket + complement; it owns the branch,
   the security bracket, the slice→gate loop, and the hand-off.
5. **Relay** its result (the sub-agent's output is not shown to the human directly).
