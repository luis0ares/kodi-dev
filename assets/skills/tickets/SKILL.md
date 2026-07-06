---
name: tickets
description: >-
  Generate board tickets from the consolidated plan (per phase, on demand). Use
  when the user runs /tickets or is ready to turn a planned phase into work items.
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
