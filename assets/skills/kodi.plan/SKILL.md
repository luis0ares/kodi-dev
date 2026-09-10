---
name: kodi.plan
description: >-
  Run kodi's Planning for ONE feature from a user story the human types after the
  command, spec-kit specify + plan in one pass: capture the story verbatim, grill at
  most five questions with a recommended answer each, then one plan-writer writes a
  short PRD (WHAT and WHY, R-nnn, [NEEDS CLARIFICATION]) and a caveman technical plan
  (files, contracts, data, bound PRDs and ADRs), plus an ADR only when the feature
  forces one; the human approves both. Use whenever the user runs /kodi.plan <story>,
  or says "plan this feature", "spec this out", "I want to implement X", "let's plan
  this" — anytime an idea should become a PRD and a plan.
---

# /kodi.plan <user story> — one feature, one PRD, one plan

You (main-loop) talk to the human and run nothing but reads. One `plan-writer`
sub-agent writes. Nobody else is spawned.

**Laws:** ask, never assume; ADR is law and only the human accepts one.

## 1. The user story is the anchor

The text after the command is the owner's words. Copy it exactly, typos included.
Given across several messages → concatenate in order. A path → the file's content.
Never paraphrase it, in a brief, a question or a file.

No story typed → ask for one sentence: who, wants what, so that what. Then continue.

## 2. Grill, five questions at most, one at a time

Before anything is written. Read the story and find what admits two readings, in
priority: scope and non-goals, permissions and tenancy, user experience and states,
data and lifecycle, integrations, the rest. Ask the highest-impact ones first.
`AskUserQuestion`, one question per call, each carrying:

1. the decision in one sentence and what changes with the answer;
2. the sentence of the story that admits two readings, quoted;
3. two to four options, each saying what happens concretely if picked and what it
   costs; never a bare term as a label;
4. the recommended option first, marked `(Recommended)`, with the reason.

Stop when the human says so or at five. Record every answer verbatim. A question
you can answer from the tree (a route exists, a table has a column) is answered by
`Grep`, not asked.

## 3. Numbers and neighbours

- PRD number: `ls docs/prd | grep -oE '^[0-9]{4}' | sort | tail -1`, plus one.
- Plan number: the same number as the PRD.
- ADR number: next over `docs/adr`, handed over whether or not one turns out needed.
- Neighbours: grep `docs/prd/README.md` and `docs/adr/README.md` for the entities,
  modules and routes in the story. Hand the two or three files that hit. Never a
  directory.
- Owner: the git user unless named.

## 4. Spawn `plan-writer` in PLAN mode

```
MODE: PLAN
User story (verbatim): <text>
Grilling answers (verbatim): - Q: … → A: …
PRD number: NNNN   Plan number: NNNN   ADR number if needed: NNNN
Owner: <name>   Date: <YYYY-MM-DD>
Neighbours (read nothing else): <paths>
```

It returns the PRD path, the plan path, an ADR path or `no ADR`, the markers left
with a recommended answer each, and an ADR conflict if any.

**ADR conflict → stop.** Show the ADR line and the story sentence side by side.
Changing the ADR is the human's decision; nothing proceeds until they make it.

## 5. Sign-off

Show in the terminal, not by path:

- PRD: `## In the owner's words`, `## Users and stories`, `## Requirements`,
  `## Assumptions`, every open `[NEEDS CLARIFICATION]`;
- plan: `## Scope`, `## Data`, `## Contract`, `## Open`;
- ADR `## Decision` if drafted.

Ask for approval. A change request goes back to the writer by `SendMessage`, once
per request; show the diff. On yes: PRD `status: Approved`, ADR `**Status:**
Accepted` with the human's name and date, or it stays `Proposed` and the feature
does not proceed to tasks.

**Open markers block approval.** Point the human at `/kodi.clarify` or let them
strike the marker; never approve over one.

## 6. Close

Say what exists and what is next:

```
PRD:  docs/prd/NNNN-<slug>.md   Approved
Plan: docs/plan/NNNN-<slug>.md
ADR:  docs/adr/NNNN-<slug>.md   Accepted | Proposed | none
Next: /kodi.clarify NNNN (open items) or /kodi.tasks NNNN
```

## Never

- Spawn more than one writer, or any planning manager. There are none.
- Write a `docs/plan/` phase document. The plan and the tickets are the plan.
- Create tickets. That is `/kodi.tasks`.
- Approve a PRD, accept an ADR, or strike a marker for the human.
