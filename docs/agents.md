# kodi agents & orchestration

kodi ships a **small, neutral team of sub-agents** and drives them through five explicit
commands. There is **no auto-advancing pipeline and no message bus** — a human runs one
command at a time, the main-loop grills them on the main thread, and one writer sub-agent
per command produces durable artifacts the next command reads.

Every agent knows its **role**, not your stack. The stack lives in a thin `CLAUDE.md`
(written during discovery) and in installable **skill-packs** (`kodi add`), so the same
engineer agent builds a FastAPI service or a Next.js app without being rewritten. No agent
pins a model: every sub-agent inherits the session's model.

Three laws hold across every command:

- **Ask, never assume.** Every genuine decision (mode, scope, an ADR change, a ticket
  table, a deviation from a criterion) goes to the human.
- **ADR is law.** Approved decisions are followed; changing or accepting one is the
  human's call.
- **The owner's words are the anchor.** A user story or a discovery answer is copied
  verbatim into the brief and the artifact. Nothing is paraphrased between the prompt
  and the ticket.

| Command                    | Grilling                     | Writer                 | Output                                                                     |
| -------------------------- | ---------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `/kodi.discover`           | main-loop, topic by topic    | `discover-writer`      | thin `CLAUDE.md`, one rule per convention, PRD 0000, founding ADRs; brownfield: as-built PRDs and ADRs |
| `/kodi.plan <user story>`  | main-loop, five questions    | `plan-writer`          | `docs/prd/NNNN-<slug>.md` + `docs/plan/NNNN-<slug>.md`, ADR only when forced |
| `/kodi.clarify <prd>`      | main-loop, five questions    | `plan-writer`          | answers in `## Clarifications`, ambiguous sentences replaced               |
| `/kodi.tasks <prd>`        | main-loop approves the table | `tasks-writer`         | `docs/plan/NNNN-<slug>.tasks.md`, one ticket per user story on the board   |
| `/kodi.build <ticket>`     | —                            | `build-orchestrator`   | `ui-designer` → engineers with their own QA → PR in To Review              |
| `/kodi.security`, `/kodi.refactor` | —                    | main-loop              | audit reports / a tidied target                                            |

---

## `/kodi.discover`

**Goal:** establish the durable context every later command reads. The main-loop is the
only one that talks to the human.

- **`discover-investigator`** (brownfield only) — runs *before* the grilling. Maps every
  project and its stack, the modules, the decisions the code already took (tenancy, auth,
  async, layout, persistence, deploy), the existing docs and how far they still match the
  code, the gates and conventions, and what is half-built. Returns a map whose **Gaps**
  seed the grilling. Read-only.
- **The grilling** covers problem, users, how they work today, constraints, destination
  and — greenfield — the stack choices; brownfield — how the team works and which
  existing docs are still true. One question at a time, recommended answer first.
- **The human approves the artifact list** before anything is written.
- **`discover-writer`** writes the approved list from the verbatim answers and the map:
  the thin `CLAUDE.md` (or a diff when one exists), one `.claude/rules/` file per
  convention, `docs/prd/0000-product-vision.md`, the founding ADRs and, on brownfield,
  one as-built PRD per module and one ADR per decision found. It never rewrites an
  `Accepted` document and never writes `briefing.md`.

## `/kodi.plan <user story>`

**Goal:** one feature, one PRD, one plan — spec-kit's `specify` + `plan` in one pass.

- The user story typed after the command is copied **verbatim**; it becomes
  `## In the owner's words` at the top of the PRD.
- The main-loop asks **at most five questions** before anything is written, each with
  the quoted sentence that admits two readings, concrete options and a recommendation.
- **`plan-writer`** writes:
  - `docs/prd/NNNN-<slug>.md` — short prose: users and stories (P1, P2 …), requirements
    `R-nnn`, permissions and tenancy in full sentences, edge cases, non-goals,
    assumptions, and at most three inline `[NEEDS CLARIFICATION: …]` markers. Under 200
    lines; longer means two features.
  - `docs/plan/NNNN-<slug>.md` — **caveman**: no articles, no filler, exact paths and
    names. Data, backend, frontend, contract, tests, the rules that bind, risks, open
    items. Under 150 lines.
  - an ADR only when the feature binds code outside itself and no ADR already decides
    it. An accepted ADR that forbids the story stops the command.
- The human approves the PRD and the plan and accepts the ADR. An open marker blocks
  approval.

## `/kodi.clarify <prd>`

**Goal:** close what the plan left open, as many times as needed.

- **`plan-writer`** in CLARIFY mode scans the PRD and the plan across scope, data, UX
  flow and states, non-functional, integrations, edge cases, terminology and completion
  criteria; open markers first. It returns at most five questions.
- The main-loop asks them one at a time; each answer goes to `## Clarifications` and
  replaces the ambiguous sentence in the PRD or the plan. No obsolete text survives.

## `/kodi.tasks <prd>`

**Goal:** from an approved spec to the board — spec-kit's `tasks` + tasks-to-issues.

- Refuses a Draft PRD, an open marker, a `Proposed` ADR, or a PRD that already has live
  tickets.
- **`tasks-writer`** derives by rule: a foundation ticket when the plan changes data, one
  vertical-slice ticket per user story, backend before frontend unless one cannot be
  tested without the other, a closing full-gate ticket last. Every `R-nnn` lands in a
  ticket; acceptance criteria are the requirement text verbatim; the ticket summary
  carries the owner's words, the plan path, the files, the pattern, the contract and
  the `T0nn [P] [US1]` steps. It writes `docs/plan/NNNN-<slug>.tasks.md`.
- The main-loop shows the ticket table, the requirement-to-ticket matrix (**Uncovered**,
  **Orphan**) and **Owner's words not served**. The human approves the table; only then
  does the main-loop run `kodi tickets create … --iteration "$ITERATION" --yes` in
  dependency order.

## `/kodi.build <ticket>`

**Goal:** one ticket, one vertical slice, one PR in To Review.

- The main-loop runs `kodi tickets start <key> --yes` (branch or worktree), then spawns
  **`build-orchestrator`**.
- **`build-orchestrator`** scouts once — the ticket, the plan sections it names, the
  design-system headings, `CLAUDE.md`, the rules, the actual files — and writes the
  **Slice Brief** every sub-agent works from: owner's words, criteria numbered, `T0nn`
  steps, touch points, pattern, contract, scoped commands. It triages the roster and
  never writes feature code.
- **`ui-designer`** runs *before* the frontend engineer whenever rendered output
  changes. It composes the primitives (`shadcn`, `frontend-design`) and returns
  components plus a short spec: props, states, variants, responsive and a11y behaviour.
- **`backend-engineer`** / **`frontend-engineer`** each own their side end to end: code,
  tests, and their own QA loop. Each invokes **`backend-qa`** / **`frontend-qa`**
  itself; the QA verifies criterion by criterion (MET, MET DIFFERENTLY with proof, NOT
  MET) with a scoped regression over the diff, never the full gate.
- **MET DIFFERENTLY is the human's call.** The orchestrator surfaces it with the
  criterion, the owner's words, what was built and the proof, and waits. Only an
  accepted deviation goes into the PR body.
- The orchestrator verifies the sides fit the same contract and every criterion is
  claimed, then opens the PR with `kodi pr create` and runs `kodi tickets hand-off`.
  Never `Done` — that is the human's sign-off on merge.

## On demand — `/kodi.security`, `/kodi.refactor`

Neither is a build step. `/kodi.security` audits a scope the human names and writes one
`docs/security/` report per confirmed breach. `/kodi.refactor <target>` cleans up a
target the human names, behavior-preservingly, in small steps under a green suite.

## How the commands connect

```
/kodi.discover ─► CLAUDE.md · rules · PRD 0000 · ADRs
      │
/kodi.plan <story> ─► docs/prd/NNNN · docs/plan/NNNN · (ADR)      ◄─┐ human approves
      │                                                             │
/kodi.clarify NNNN ─► markers closed, sentences replaced ───────────┘
      │
/kodi.tasks NNNN ─► docs/plan/NNNN.tasks.md · tickets on the board   ◄── human approves the table
      │
/kodi.build <key> ─► slice · scoped regression · PR in To Review     ◄── human merges to Done
```

Every arrow is a file on disk or a ticket on the board. A command can be re-run after a
`/clear` or `/compact` because nothing lives only in a conversation.
