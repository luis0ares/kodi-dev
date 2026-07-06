---
name: ticket-start
description: >-
  Build phase. Start one backlog ticket and drive it as a vertical slice. Use when
  the user runs /ticket-start, says "start ticket X", or "begin the next slice".
---

# /ticket-start [ticket] — Build one vertical slice

Resolve which ticket (recommend from `kodi tickets list-ready` if none given),
collect an optional complement, then spawn the `build-orchestrator` sub-agent to
drive it end-to-end on its own branch.

The build-orchestrator is the hub: engineers (`backend-engineer`,
`frontend-engineer`) write feature code; testers (`backend-tester`,
`frontend-tester`) write tests; gates (`qa-implementation`, `qa-visual`) plus a
`security` bracket. The slice closes ONLY when every gate is green, there is no
Critical/High security finding, and qa-implementation AND qa-visual are positive.
Take the PR to `To Review` via `kodi pr` — never to `Done`.

> Agents for this phase are authored in F5. This skeleton defines the flow only.
