---
name: tickets
description: >-
  Generate board tickets from a consolidated plan, one phase at a time, via the
  kodi tickets CLI. Use this whenever the user runs /tickets, or says things like
  "create tickets/issues for this", "turn the plan into work items", "ticket up
  phase 1", "put this on the board", "make the backlog for this phase" — anytime a
  planned phase should become actionable tickets.
---

# /tickets — Generate tickets from the plan

Turn a consolidated, phased plan (`docs/plan`) into tickets on the active board,
one phase at a time, on demand.

- Manage tickets ONLY through the CLI: `kodi tickets create`, `list`,
  `list-ready`, `set-status`, `delete`, … The CLI validates the ticket template
  and proxies the provider.
- Each ticket should trace to its drivers (PRD / ADR / security).
- Declare dependencies so `kodi tickets list-ready` reflects the real order.
- Remote board mutations are dry-run unless `--yes`.
