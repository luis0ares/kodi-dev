---
name: kodi.build
description: >-
  Start ONE board ticket and drive it as a vertical slice via the
  build-orchestrator: move it to In progress and cut its branch or worktree with
  kodi, then spawn the orchestrator, which scouts once, writes the Slice Brief from
  the ticket's owner's words, plan sections and T0nn steps, runs ui-designer when
  the slice renders UI, then the engineers with their own QA, and closes with a PR
  and hand-off. Use whenever the user runs /kodi.build <ticket>, or says "start
  ticket KODI-014", "build this ticket", "begin the next slice", "pick up the next
  ready ticket", "kick off the build".
---

# /kodi.build [ticket…] — build one vertical slice

Resolve the ticket, collect an optional complement, choose branch or worktree,
**start it on the board with `kodi tickets start <key> --yes`**, then spawn
`build-orchestrator`. The start is mandatory and always precedes the spawn: without
`--yes` nothing moves.

## Flow

1. **Resolve the ticket(s).** A given key, or recommend from `kodi tickets
   list-ready`. Several keys named together mean one bundled slice on one shared
   branch.
2. **Optional complement.** The human adds detail the ticket lacks. It contradicts
   the ticket → reconcile first, the complement wins, confirm.
3. **Branch or worktree.** From the complement if it said so; otherwise ask, with
   the consequence in each option: branch switches the current checkout; worktree
   gets its own directory at `.claude/worktrees/slice-kodi-<id>` and leaves the
   checkout untouched. A worktree has no `.env`: symlink it, never copy
   (`ln -s ../../../.env <worktree>/.env`).
4. **Start on the board.**

   ```bash
   kodi tickets start <key> --yes                 # cuts slice/kodi-<key>, or --worktree
   kodi tickets start <key2> --no-branch --yes    # bundling: every key after the first
   ```

   `--worktree` and `--no-branch` are mutually exclusive on one call.
5. **Spawn `build-orchestrator`** with the ticket key(s), the complement, the
   branch name, and the worktree path as working directory if one was created.
6. **Relay its report.** Its output is not shown to the human directly. Relay the
   per-criterion outcome, every MET DIFFERENTLY it surfaced for a decision, the PR
   link, and anything it flagged for `/kodi.security` or `/kodi.refactor`.

## What the orchestrator does, so you can judge its report

- **Scouts once** and writes the Slice Brief every sub-agent works from: the plan
  sections the ticket points to, the T0nn steps verbatim, the design-system headings
  the plan cites, the owner's words, the criteria numbered, the exact files, the
  pattern, the contract, the scoped commands.
- **Triage:** backend-only → `backend-engineer`; UI changes → `ui-designer` first,
  then `frontend-engineer`; both sides → designer first, then both engineers in
  parallel once the contract is pinned.
- **Each engineer owns its code, its tests and its QA.** `backend-qa` and
  `frontend-qa` verify criterion by criterion with a scoped regression, never the
  full gate. The orchestrator never spawns a QA agent.
- **MET DIFFERENTLY is the human's call.** A justified deviation is surfaced to you
  before the PR opens; only an accepted one goes into the PR body. Relay it as a
  question with the criterion, the owner's words, what was built and the proof.
- **Remediation is capped at two rounds.** A slice that will not converge comes back
  as a diagnosis, not a third loop.
- **Closes with `kodi pr create` and `kodi tickets hand-off`.** Never `Done`; that is
  the human's call on merge, binding in `.claude/rules/ticket-completion.md`.

## Never

- Spawn the orchestrator before `kodi tickets start … --yes` ran.
- Run a gate or the E2E suite yourself. The regression is the orchestrator's and its
  engineers' job, scoped to the diff.
- Accept a MET DIFFERENTLY on the human's behalf.
