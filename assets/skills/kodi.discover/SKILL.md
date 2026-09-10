---
name: kodi.discover
description: >-
  Run kodi's Discovery: grill the human on the main thread to learn what they want to
  build (greenfield) or what already exists, how they work and where they want to go
  (brownfield, after an investigator maps the tree), then write the durable
  artifacts: a thin CLAUDE.md, one rule per convention, PRD 0000 product vision,
  founding ADRs, and on brownfield one as-built PRD per module and one ADR per
  decision the code already took. Use whenever the user runs /kodi.discover, starts a
  NEW project, onboards kodi onto an existing repo, or says "let's figure out what
  we're building", "set up the project", "understand this codebase before we plan".
---

# /kodi.discover — Discovery (main-loop, grilling, one writer)

You (main-loop) talk to the human. Sub-agents investigate or write; they never
interview. There is no `briefing.md`; PRD 0000 is the briefing.

**Laws:** ask, never assume; ADR is law and only the human accepts one.

## 1. Detect the mode, confirm it

Code with substance (source files, a manifest, a git history) → propose
**brownfield**. Empty or a single new corner → propose **greenfield**. Confirm with
one question. Never assume on an ambiguous repo.

## 2. Brownfield only: spawn `discover-investigator` first

One spawn, the repo root as its scope. It returns the map: projects and stacks,
modules, decisions the code already took, docs and their drift, gates and
conventions, state, and **Gaps** with the question that settles each. Read it whole.
The grilling starts from its gaps, not from zero.

## 3. Grill. One question at a time. Recommended answer first.

Each question: the decision in one sentence, why it came up (on brownfield, quote the
investigator's row), two to four options that say what happens concretely if picked,
the recommended one first and why. `AskUserQuestion`, one question per call.

Cover, in this order, and stop a topic when the human has nothing to add:

| topic | greenfield asks | brownfield asks |
|---|---|---|
| problem | what hurts, for whom, what outcome | same, plus what the code already solves |
| users | roles, volumes, what each does | which roles the code has, which are missing |
| how they work today | current process, tools, friction | how the TEAM works: gates, branches, review, board, what never merges |
| constraints | regulatory, integrations, timeline, budget | same, plus the decisions the map found: confirm each or mark it as debt |
| destination | the first shippable thing, then the next | where the product must get to, what is half-built and what to finish or drop |
| stack | language and framework per project, database, auth, async, deploy, board and PR tooling, with a recommended default each | which existing docs are still true, which modules deserve an as-built PRD, which decisions deserve an ADR |

Record every answer **verbatim**. The writer receives your transcript, not a
summary.

## 4. Approve the artifact list

Before anything is written, show the human the list: `CLAUDE.md` (new or diff), the
rules with one line each, PRD 0000, each ADR with its one-line decision, and on
brownfield each as-built PRD with its module. Never a document whose status is
already `Accepted` or `Approved`. The human strikes or adds rows. Only the approved
list is written.

## 5. Spawn `discover-writer`

One spawn, brief:

```
MODE: greenfield | brownfield
Owner: <git user or named>   Date: <YYYY-MM-DD>   Provider: <from .claude/kodi-dev.yaml or asked>
Human's answers (verbatim, by topic): <the transcript>
Investigator map: <pasted, brownfield only>
Approved artifact list: <numbers and slugs>
Existing docs to respect: <paths, brownfield only>
```

It returns paths written, diffs proposed for files that existed, open questions.

## 6. Close

Show the human: the diffs for `CLAUDE.md` and any existing rule (apply only on yes),
the PRD 0000 `## In the owner's words` and `## Where it must get to` verbatim, each
ADR's `## Decision`, the open questions. An ADR the human accepts gets
`**Status:** Accepted` with their name and today's date; the rest stay `Proposed`.
PRD 0000 becomes `status: Approved` on their yes.

Then point them at `/kodi.plan <user story>` for the first feature.

## Never

- Delegate the interview. Sub-agents cannot talk to the human.
- Write a plan or tickets. That is `/kodi.plan` and `/kodi.tasks`.
- Write `briefing.md`.
