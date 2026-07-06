---
name: oplan
description: >-
  Planning phase. Drive the hub-and-spoke planning loop to produce a consolidated,
  phased plan in docs/plan. Use when the user runs /oplan or wants to plan a new
  project/feature from briefing.md.
---

# /oplan — Planning (main-loop orchestrator, hub-and-spoke)

You (main-loop) are the hub. For each manager: spawn it → it returns a plan
naming its leaves → YOU spawn the leaves → they return → YOU validate. Loop until
`qa-planning` passes.

**Order:** `detail` (PRD — human sign-off) → `architect` ∥ `ux` (parallel,
sealed-bid, you reconcile cross-review and surface conflicts) → `phases` (split
into MVP-first phases) → `qa-planning` (validation gate only). Then write the
phased plan to `docs/plan` for human review.

Subtrees: `architect` → `system-architect`, `data-engineer`; `ux` →
`researcher`, `brand`, `component-engineer`.

## The hub loop, per manager

1. Spawn the manager in **PLAN mode** → it returns which leaves are needed + a
   brief per leaf.
2. YOU spawn those leaves (in parallel) → they return drafts to you.
3. Spawn the manager in **VALIDATE mode** → `pass` or a gap list; loop the
   responsible leaf until it passes.
Run `architect` and `ux` as two such loops in parallel; reconcile cross-cutting
conflicts yourself and take genuine decisions (ADR sign-off, scope) to the human.

**Laws:** ask-never-assume; ADR is law. Do NOT generate tickets here (that is
/tickets).
