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
collect an optional complement, then spawn the `build-orchestrator` sub-agent to
drive it end-to-end on its own branch.

The build-orchestrator is the hub: engineers (`backend-engineer`,
`frontend-engineer`) write feature code; testers (`backend-tester`,
`frontend-tester`) write tests; `refactor-engineer` tidies the code behavior-
preservingly as the last implementation step (once tests are green); gates
(`qa-implementation`, `qa-visual`) plus a `security` bracket. The slice closes ONLY when every gate is green, there is no
Critical/High security finding, and qa-implementation AND qa-visual are positive.
Take the PR to `To Review` via `kodi pr` — never to `Done`. On remote boards this
is binding: `.claude/rules/ticket-completion.md` (In review + PR on finish; `Done`
only on the user's explicit order).

## Flow

1. **Resolve the ticket** — a given key, or recommend from `kodi tickets list-ready`.
2. **Optional complement** — let the human add detail not in the ticket; if it
   contradicts the ticket, reconcile first (the complement wins) and confirm.
3. **Spawn `build-orchestrator`** with the ticket + complement; it owns the branch,
   the security bracket, the slice→gate loop, and the hand-off.
4. **Relay** its result (the sub-agent's output is not shown to the human directly).
