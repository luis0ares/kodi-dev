---
name: kodi.clarify
description: >-
  Resolve what /kodi.plan left open on ONE feature: the plan-writer scans the PRD
  and the plan by category (scope, data, UX flow and states, non-functional,
  integrations, edge cases, terminology, completion criteria), open [NEEDS
  CLARIFICATION] markers first, and the main-loop asks at most five questions, one at
  a time, each with a recommended answer; every answer is written back into the PRD's
  Clarifications and replaces the ambiguous sentence in the PRD or the plan. Use
  whenever the user runs /kodi.clarify <prd>, or says "there are open points on the
  spec", "clarify the plan", "resolve the markers", "something is still ambiguous".
---

# /kodi.clarify <prd number or path> — close what the plan left open

Runs after `/kodi.plan`, before `/kodi.tasks`, as many times as needed. One
`plan-writer` sub-agent scans and writes; you ask.

## 1. Resolve the pair

`docs/prd/NNNN-*.md` and `docs/plan/NNNN-*.md`. Either missing → stop and say which.
A PRD with `status: Approved` and no open marker → say there is nothing to clarify
unless the human names a doubt; then pass that doubt as the first question's topic.

## 2. Spawn `plan-writer` in CLARIFY mode, first round

```
MODE: CLARIFY
PRD: <path>   Plan: <path>
Human's doubt, if any: <verbatim>
```

It returns at most five questions, markers first, each with the quoted ambiguous
sentence (file and heading), two to four options with what each costs, and the
recommended one with why. It does not write in this round.

## 3. Ask, one at a time

`AskUserQuestion`, one question per call, recommended option first and marked
`(Recommended)`. Options are concrete outcomes, never bare terms. Stop when the human
says `done` or at five. Past five, list what remains as **Deferred**.

Record each answer verbatim.

## 4. Send the answers back, `SendMessage` to the same agent

```
MODE: CLARIFY, answers
- Q: … → A: …
```

It appends each under `## Clarifications` in the PRD, replaces the ambiguous
sentence in the PRD or the plan, removes the marker, and validates: no duplicate
requirement, no orphan marker, no contradiction with an ADR `## Decision`. It
returns the sections rewritten.

## 5. Show and close

Show the rewritten sections verbatim and the markers still open. A PRD left with no
open marker and still `status: Draft` → ask whether to approve it now; on yes set
`status: Approved`. Then:

```
Open markers: <n>   Deferred: <list or none>
Next: /kodi.clarify NNNN again, or /kodi.tasks NNNN
```

## Never

- Edit the PRD or the plan yourself. The writer does, so the change is validated.
- Ask a question the tree answers. `Grep` first.
- Exceed five questions in one run.
