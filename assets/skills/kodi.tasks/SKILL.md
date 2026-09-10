---
name: kodi.tasks
description: >-
  Turn ONE approved PRD and its plan into work, spec-kit tasks + tasks-to-issues in
  one pass: the tasks-writer derives one vertical-slice ticket per user story with
  its T0nn step list and exact files, ordered by dependency and closed by a
  full-gate ticket, writes docs/plan/NNNN-<slug>.tasks.md, and returns the ticket
  table with the requirement-to-ticket matrix; the human approves the table and the
  main-loop creates the tickets on the board through kodi in the current iteration.
  Use whenever the user runs /kodi.tasks <prd>, or says "create the tickets",
  "break this into tasks", "put this on the board", "ticket up PRD 0019".
---

# /kodi.tasks <prd number or path> — from approved spec to board

One `tasks-writer` sub-agent derives. You approve with the human and run `kodi`.
The board is the source the build reads; the tasks file is the readable copy.

## 1. Refuse what is not ready

- PRD `status: Draft` → stop: `/kodi.plan` or `/kodi.clarify` finishes it.
- An open `[NEEDS CLARIFICATION]` in the PRD or the plan → stop: `/kodi.clarify`.
- An ADR the plan binds still `Proposed` → stop: the human accepts it or the
  feature waits.
- Tickets already tracing to this PRD: `kodi tickets list --all-iterations`, grep
  the PRD path. Any hit → show them and ask whether to delete them first
  (`kodi tickets delete <key> --yes`, one by one, on the human's yes) or stop.
  Never create a second set beside a live one.

## 2. Spawn `tasks-writer`

```
PRD: <path>   Plan: <path>   ADRs bound: <paths>
Ticket prefix: <from .claude/kodi-dev.yaml>
```

It writes `docs/plan/NNNN-<slug>.tasks.md` and returns: the table
`K | title | side | covers | deps`; the matrix `R-nnn → K` with **Uncovered** and
**Orphan**; **Owner's words not served**; one dry-run `kodi tickets create` per
ticket with `--dep K<n>` placeholders.

## 3. Check before the human sees it

An **Uncovered** id, an **Orphan** ticket, a non-empty **Owner's words not served**,
a set without a closing full-gate ticket, or a story ticket without T0nn steps is a
defect. Send it back once by `SendMessage` with the exact gap. Show the corrected
result.

## 4. Sign-off: the table

Show the table, the matrix and the three lists in the terminal. The human approves
the table as a whole or names rows to change; a change goes back to the writer once.

## 5. Create, in dependency order, in the current iteration

```bash
kodi tickets iterations
ITERATION=$(kodi tickets iterations | sed -n 's/^\* \(.*\)  (.*$/\1/p')
```

Nothing marked current → stop and ask which sprint. Never the backlog. `provider:
local` → no `--iteration`.

For each command from the writer, in the file's `## Order`: substitute the real keys
already returned into `--dep`, append `--iteration "$ITERATION" --yes`, run it,
capture the key it returns. Write the real key next to its `K<n>` in the tasks
file's `## Order` line. Finish:

```bash
kodi tickets tree
```

Show the tree. Point the human at `/kodi.build <first ready key>`.

## The closing ticket

No slice runs the full gate; `backend-qa` and `frontend-qa` verify with a scoped
regression. The writer's rules end every set with one ticket that depends on the
last slice and carries the project's full gate from `CLAUDE.md`, every drafted ADR
`Accepted`, no test infrastructure left behind, the E2E inside the gate or the cheaper
layer named, a by-hand walk, and no new feature work. A table without that row goes
back.

## Never

- Run `--yes` before the human approved the table.
- Create in the backlog, or guess a sprint name.
- Reword an acceptance criterion. It is the PRD's requirement text, verbatim.
