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

Turn a consolidated, phased plan (`kodi docs list plan` / `kodi docs get
PLAN-000N`) into tickets on the active board, one phase at a time, on demand.

- Manage tickets ONLY through the CLI: `kodi tickets create`, `list`,
  `list-ready`, `set-status`, `delete`, … The CLI validates the ticket template
  and proxies the provider.
- Each ticket should trace to its drivers — the PRD/ADR/security doc **ids**
  (`PRD-0001`, `ADR-0003`, `SECURITY-0014`) via `kodi tickets create --prd --adr
  --security`, never a file path.
- Declare dependencies so `kodi tickets list-ready` reflects the real order.
- Remote board mutations are dry-run unless `--yes`.
