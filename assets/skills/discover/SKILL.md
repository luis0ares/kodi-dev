---
name: discover
description: >-
  Run kodi's Briefing phase — interview the human on the main thread, investigate
  with the WU sub-agents, and produce briefing.md + a thin CLAUDE.md. Use this
  whenever the user runs /discover, is starting a NEW project, onboarding kodi onto
  an existing repo, or says things like "let's figure out what we're building",
  "set up the project", "discover the requirements", "understand this codebase
  before we plan" — anytime project context must be established BEFORE planning,
  even if they never say the word "discover".
---

# /discover — Briefing (you are the main-loop orchestrator)

You run this phase **on the main thread** — only you talk to the human. The WU
agents are sub-agents that **investigate and report; they never interview**.

## Laws (always)

- **Ask, never assume.** Every genuine decision (mode, scope, contradictions,
  unknowns) goes to the human.
- Produce durable artifacts; there is no message bus — you coordinate directly.

## Flow

### 1. Detect the mode, then confirm
Check whether the project already has code (source files, a manifest, a git
history with substance). Propose **brownfield** (code exists) or **greenfield**
(new) and **confirm with the human** — never assume on an ambiguous repo (empty
repo, a monorepo with one new corner).

### 2. Run the grill (you, on the main thread)
Interview the human to cover:
- **WHAT** is the problem and the desired outcome.
- **WHO** are the users.
- **HOW** they work today (current process, tools, friction).
- **Constraints** (technical, regulatory, timeline, integrations).
Keep it a real conversation; ask follow-ups. Do not delegate the interview.

### 3. Investigate with the WU sub-agents (parallel, no interviewing)
Spawn as needed via the Agent tool:
- **`brownfield-wu`** — only if code exists. Give it the repo; it returns a
  technical map (stack, architecture, integrations, tests, tech debt).
- **`greenfield-wu`** — point it at any seed material (docs, mockups, sample data,
  links) and the domain; it returns facts. **SKIP it** if there is nothing to
  investigate.
Pass paths, not prose. They return reports to you.

### 4. Reconcile & raise open questions
Read the WU reports. Where they conflict with the grill or with each other, or
leave gaps, **raise those questions with the human** before synthesizing.

### 5. Synthesize (delegate to `brief`)
Spawn **`brief`**, handing it your grill notes and the WU report paths. It writes:
- **`briefing.md`** (root, transient) — the discovery report consumed by `/oplan`.
- **`CLAUDE.md`** (root, thin) — identity, stack (or `TBD`), provider, gate
  commands, skill-packs, doc locations.

### 6. Close
Show the human the two artifacts and the remaining open questions. Briefing is
done when the human is satisfied; then suggest `/oplan`.

> This phase never generates a plan or tickets — that is `/oplan` and `/tickets`.
