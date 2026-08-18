---
name: oreplan
description: >-
  Re-plan or expand ONE phase of the consolidated plan, given new context. Use this
  whenever the user runs /oreplan, or says things like "redo phase 2", "expand this
  phase", "the plan for phase X changed", "a decision changed, update that phase",
  "rework the plan for <phase>" — anytime a single planned phase needs revising
  without re-running the whole plan.
---

# /oreplan <phase> [context] — Re-plan one phase

Operate on a single phase in `docs/plan` — never the board.

1. Read the phase + the passed context; classify impact: foundation invalidated
   (ADR/scope changed) → propose a FULL re-plan of the phase; otherwise EXPAND.
   Default = expand.
2. Because both overwrite human-approved artifacts, **show the diff and get
   sign-off** before writing.
3. Run the planning sub-loop scoped to the phase → `phases` re-validates →
   `qa-planning` re-gates.
4. If tickets already exist for the phase, **flag the delta**; the human decides
   whether to re-run /tickets. Do not touch the board yourself.
