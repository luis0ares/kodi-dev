# ChatiDev Memory / Knowledge-Persistence Investigation

**Scope:** `/home/luis0ares/dynac/new-xpto/archive/chatidev` (ChatiDev v4.4.0, predecessor of kodi).
**Purpose:** Extract prior art for kodi's proposed 0–5 veracity-score memory feature.
**Method:** Read of `.chati/`, `.chati.dev/` (constitution, intelligence layer, hooks, schemas, `_cli/memory/*` engine source), `.claude/rules/chati/`, `artifacts/`, `CLAUDE.md`, `CLAUDE.local.md`.

**Caveat on evidence:** this archived project ran only a few pipeline steps, so the runtime stores are nearly empty (`.chati/memories/*` dirs exist but hold 0 files; `artifacts/decisions/` and `artifacts/handoffs/` are empty). The memory *design* is fully present in the framework: schema, constitution articles, intelligence docs, and — most importantly — the actual engine implementation under `.chati.dev/_cli/memory/`.

---

## Executive summary of the memory model

ChatiDev has a real, multi-store, entirely **file-based** memory system ("Memory Layer", Constitution Article XIII) with:

- Per-agent + shared markdown/JSON stores under `.chati/memories/` (gitignored runtime state).
- A JSON-Schema-defined memory record with **continuous confidence (0.0–1.0)**, an **evidence counter**, **access counter**, **hot/warm/cold attention tiers** with explicit promotion/demotion rules, **cognitive sectors** (episodic/semantic/procedural/reflective), and **storage tiers** (session/daily/durable) for time-based expiry.
- Automatic capture (regex extraction per turn, PreCompact session digests, error→gotcha frequency promotion), automatic consolidation ("Dream" system: dedupe, merge, contradiction count, prune-to-archive), and automatic injection (PRISM `UserPromptSubmit` hook + bracket-based progressive retrieval).
- A separate, strictly **append-only** "Decision Trail" of known-bad states with hash/similarity-based **Echo Detection** to stop re-introducing already-rejected knowledge.
- **No file association and no code-change-triggered re-evaluation** — the two things kodi's veracity proposal adds. ChatiDev's confidence only ever goes *up* (merge/corroboration) or decays passively with time; it is never re-verified against reality after creation.

---

## 1. Is there a memory system at all? Where does knowledge live?

Yes — several coordinated stores, all plain files, no DB.

### 1a. `.chati/memories/` — the runtime memory store (gitignored)

Layout (documented in `.chati.dev/intelligence/memory-layer.md`, physically present in the archive as empty per-agent dirs: `architect/`, `dev/`, `qa-*/`, `shared/`, each with `durable/` and `daily/`, `shared/` also with `session/`):

```
.chati/memories/
  shared/                # cross-agent
    durable/             # permanent, never expires
    daily/               # day-level consolidation, archived after 30 days
    session/             # ephemeral digests, cleaned on next session start
    gotchas.json         # promoted error patterns (shared store)
    error-log.json       # raw error occurrences (7-day retention)
    consolidated.json    # output of Dream consolidation
    archive/             # pruned entries (never hard-deleted)
  {agent-name}/          # agent-private
    MEMORY.md            # flat markdown memory file per agent
    durable/  daily/
  index.json             # derived, rebuildable search index
```

### 1b. The memory record schema — `.chati.dev/schemas/memory.schema.json`

Each memory is a Markdown file with YAML frontmatter. Required: `id, type, agent, tags, confidence, sector, tier, created_at`. Full field set:

- `id`: `mem-YYYY-MM-DD-NNN`
- `type`: `decision | error_pattern | resolution | user_correction | validated_pattern | gotcha | lesson`
- `confidence`: number 0.0–1.0 — "System confidence in this memory"
- `sector`: `episodic | semantic | procedural | reflective`
- `tier`: `hot | warm | cold` — "hot (>0.7, auto-loaded), warm (0.3-0.7, on-demand), cold (<0.3, explicit search)"
- `access_count` (int), `evidence_count` (int, "Number of corroborating observations"), `last_accessed`, `created_at`, `expires_at` (null = durable)
- `storage_tier`: `session | daily | durable`
- `scope`: `shared | private`

There is **no field for associated files/paths** (see §3).

### 1c. Per-agent `MEMORY.md` — the simpler store actually wired into injection

`.chati.dev/_cli/memory/agent-memory.js` reads/writes `.chati/memories/{agent}/MEMORY.md`: `## Category` headers with `- entry (confidence) [tags]` bullets, where confidence is a **string token** `high | medium | low` (default medium). This is the file the PRISM hook actually injects (§6).

### 1d. `.chati.dev/intelligence/` — committed, framework-level knowledge

- `gotchas.yaml` — curated pitfalls (G001–G005) with `technology, pattern, severity, description, mitigation, discovered_by, discovered_at`. Header: *"Agents READ from this file before implementation / Agents APPEND new entries / QA agents VALIDATE entries before they become permanent / NEVER overwritten during upgrades."*
- `patterns.yaml` — successful patterns (P001–P003) with `context, pattern, outcome, score (0–100), agent, recorded_at, notes`.
- `confidence.yaml` — **per-agent confidence calibration** (see §2c).
- `memory-layer.md`, `context-engine.md`, `decision-engine.md` — the design docs.

### 1e. Session + artifact stores

- `.chati/session.yaml` — pipeline state, per-agent scores, `decision_trail[]` (append-only), `correction_cycles`, context-token accounting.
- `.chati/timeline.json` — append-only event log (`agent_completed`, `correction_triggered` events with scores are present in the archive).
- `artifacts/decisions/`, `artifacts/handoffs/` — markdown decision records and two-layer handoffs (Constitution Article III: *"Decisions are recorded in `artifacts/decisions/`"*; handoff format in `.chati.dev/tasks/orchestrator-handoff.md`: YAML frontmatter with `agent, timestamp, status, quality_score` + Decisions/Open Questions sections).
- `CLAUDE.md` "Current State" section — auto-rewritten after each handoff by "Magic Docs" (`.chati.dev/_cli/memory/magic-docs.js`), including a `### Recent Decisions` block (max 5).

---

## 2. Scoring / trust / confidence / veracity — THE key question

ChatiDev has **four distinct scoring axes**, deliberately kept separate. This separation is the strongest prior art for kodi.

### 2a. `confidence` (0.0–1.0) — trust in the memory content

- Set **at creation, by heuristic of capture type**, not by verification. `memory-extractor.js` assigns fixed base confidences per extraction pattern: decision 0.6, resolution 0.7, **user_correction 0.8** (user statements trusted most), validated_pattern 0.6, error_pattern 0.5. Per-turn extractions "start at warm tier (confidence 0.5)" (Article XIII §9).
- **Changed only by merging**: during Dream consolidation duplicates merge and *"keep highest confidence ... increment evidence"* (`dream.js` `consolidate()`: `existing.confidence = Math.max(...)`, `evidence_count += ...`). Confidence never decreases; there is no re-verification step that could lower it.
- **Thresholds**: `confidence >= 0.7` at extraction → tier `hot`; Article XIII §5: heuristic proposals (promoting a learned pattern into a rule) require **`confidence > 0.9` AND `evidence_count >= 5` AND explicit user approval**.
- **Dual-scale bug (cautionary tale)**: numeric 0–1 in the schema vs string `high/medium/low` in `MEMORY.md`. `dream.js` `normalizeConfidence()` exists precisely because *"the Math.max(string, string) path produces NaN and the rule never fires"* (fix F-A5-010; mapping high=0.9, medium=0.7, low=0.5). One concept, two encodings, real bug.

### 2b. Attention score + hot/warm/cold tier — retrieval priority (distinct from trust)

`memory-layer.md`:

```
score = base_relevance * recency_factor * access_modifier * confidence
```

- `recency_factor`: exponential decay since last access; `access_modifier`: logarithmic boost by access count.
- Tier bands: **HOT** (>0.7, pre-loaded automatically), **WARM** (0.3–0.7, on demand), **COLD** (<0.3, explicit search only).
- **Explicit tier-transition rules** — the closest thing to kodi's "score goes up when loaded":
  - COLD→WARM: `access_count >= 3` OR `evidence_count >= 2`
  - WARM→HOT: `confidence > 0.7` AND `evidence >= 5`
  - HOT→WARM/COLD: natural decay when not accessed
  - ANY→ARCHIVE: `score < 0.1` for 90+ days
- Note: promotion is driven by **usage and corroboration counts**, never by a veracity check. Being loaded often makes a memory hotter regardless of whether it is still true.

### 2c. Agent calibration — `intelligence/confidence.yaml` (subtle and valuable)

Tracks how much to trust each *agent's* output per technology/pattern (e.g. `dev.by_technology.react: 0.92`). Its `calibration_status` enum is the most nuanced trust idea in the codebase:

> `seed` — initial estimate, NOT measured from real runs. Treat as a prior, not evidence. Replaced by measured values after runs.
> `uncalibrated` — no data yet. ... **Do not treat the absence of a number as low confidence; it means unknown.**
> `calibrated` — overall and breakdowns reflect measured results across runs.

i.e. ChatiDev explicitly distinguishes *"we guessed this score"* from *"we measured this score"* from *"we don't know"* — directly relevant to kodi's question of what a fresh memory's score means.

### 2d. Quality/artifact scores (0–100) and evidence-bound verdicts

- Every agent artifact gets a 0–100 quality score against gate thresholds (95%/90%/85%, `.claude/rules/chati/quality.md`, `qa-gate-tmpl.yaml`: `result: APPROVED | NEEDS CORRECTION | ESCALATED`). These score *artifacts*, not memories, but the threshold-band pattern (pass / review-window / fail) is reusable.
- **Evidence-Bound Verdicts** (Constitution Article XXII §2): *"QA agents MUST NOT issue quality verdicts based solely on LLM inference. Every defect classified as ERROR or WARNING MUST be backed by at least one piece of tool-produced evidence. ... Findings that lack EVIDENCE_EXCERPT are classified as SUGGESTION."* — the principle "no evidence ⇒ downgrade the claim's authority" is exactly a veracity mechanism, applied to QA findings rather than memories.

### 2e. Frequency-based promotion for gotchas

`gotchas.js`: raw errors are logged; when a normalized error pattern occurs **3+ times within 24h** (`ERROR_PATTERN_THRESHOLD = 3`) it is promoted to a gotcha with `count`, `first_seen/last_seen`, `severity` (INFO/WARNING/CRITICAL, regex-classified), `resolution: null`. Trust is earned by **repetition**, not assertion.

---

## 3. File association

**Essentially absent — this is ChatiDev's biggest memory gap and kodi's main addition.**

- `memory.schema.json` has **no files/paths field**. File names appear only in free-text memory bodies (the example in `memory-layer.md` lists `@/lib/auth/jwt.ts`, `@/middleware.ts` under an `## Implementation` heading — unparseable prose, not metadata).
- Gotcha deduplication actively **destroys** path information: `gotchas.js` `normalizeErrorMessage()` does `.replace(/\/[^\s]+/g, '/PATH')` — paths are noise for pattern matching, so they are stripped.
- The session digest schema (`templates/session-memory-tmpl.yaml`) has a `files_changed` section (1000-token budget) — but per session, not per memory, and it is among the first sections truncated.
- The one real file-association mechanism is for **framework artifacts**, not memories: the Entity Registry (`.chati.dev/data/entity-registry.yaml`, Article XIV) stores per-entity `path`, `keywords`, `dependencies`, `adaptability` (0.0–1.0) and a **SHA-256 `checksum`** — *"Checksum validation ensures file integrity. Mismatches indicate unauthorized or untracked modifications"* (constitution line 403). That checksum-per-path idea is the borrowable seed for kodi's "re-evaluate memories when their file changes".

---

## 4. Re-evaluation / staleness / invalidation

ChatiDev handles staleness **passively (time/usage decay)**, never **actively (re-verification)**.

- **Time-based expiry**: `expires_at` field; storage tiers — session memories deleted on next session start, daily archived after 30 days, durable permanent (`memory-manager.js` `cleanMemories()` deletes session-tier and expired files — a hard `unlinkSync`). Raw error log entries expire after 7 days (`clearExpiredErrors`).
- **Attention decay**: unaccessed memories drift HOT→WARM→COLD; `score < 0.1` for 90+ days → archive.
- **Dream consolidation** (`dream.js`, triggered from the PreCompact hook when >100 entries; 200-entry cap): Orient → Gather → Consolidate (dedupe by normalized-content SHA-256, merge keeping max confidence, sum evidence_count, mark cross-agent-corroborated entries `scope: shared`) → Prune (sort cold-first, then lowest confidence, then lowest access_count; remove overflow). *"Consolidation is non-destructive — removed entries are archived, not deleted"* to `.chati/memories/shared/archive/dream-{date}.json`.
- **Contradiction detection exists but does nothing**: `consolidate()` counts entries from the same agent with same type but different content hash (`contradictions++`) and reports the number — no resolution, no flagging of which entry wins. A recognized-but-unbuilt feature.
- **Gotcha invalidation** is a status flip, not deletion: `updateGotchaResolution()` sets `resolution` + `resolved_at`; the PRISM injector filters `!g.resolution` so resolved gotchas stop being injected but remain queryable history.
- **Verify-before-trusting** appears only at the QA layer: gotchas.yaml header (*"QA agents VALIDATE entries before they become permanent"*) and Evidence-Bound Verdicts (§2d). **No mechanism re-checks a memory against the codebase when code changes** — nothing watches file edits (there are PreToolUse hooks for governance, e.g. `mode-governance.js`, `git-push-authority.js`, but none touches memory).
- **Anti-relearning instead of re-verification**: the Decision Trail (Article XXII §3) records known-bad states so they are never re-introduced — Echo Detection flags any new finding with similarity ≥ 0.85 to a prior `what_was_wrong` or an exact `evidence_hash` match, and escalates instead of looping. It is "remember what was wrong" as a complement to "remember what is right".

---

## 5. Immutability vs editability

Mixed, with a clear split by record kind:

**Append-only / immutable:**
- `decision_trail[]`: *"Decision Trail entries are APPEND-ONLY — no entry may be deleted or modified after writing"* (constitution line 750); only the `resolved` boolean flips. Archived to `artifacts/decisions/fault-trail-{date}.md` at session end.
- Daily digests: *"Digests are append-only (never overwritten) and accumulate throughout the day"* (`memory-layer.md`; implemented in `session-digest.js` daily-append block).
- `intelligence/gotchas.yaml` / `patterns.yaml` / `confidence.yaml`: append entries, *"NEVER overwritten during upgrades"*.
- `reasoning_escalations[]`, `timeline.json`: append-only event logs.

**Edited in place:**
- Agent `MEMORY.md`: `writeAgentMemory()` reads all entries, appends, and **rewrites the whole file**; Dream rewrites `consolidated.json`; merge mutates confidence/evidence/tags of the surviving entry.
- `gotchas.json`: `count`, `last_seen`, `resolution` mutated in place (under an advisory file lock to avoid concurrent-writer ID collisions — `acquireLock` in `recordError`).
- `CLAUDE.md` Current State section: surgically rewritten every handoff (magic-docs regex replace; the file even documents a corruption bug that regex once caused).

**Conventions:** no supersede-vs-edit convention for memories. Deletion is user-reserved (Article XIII §6: *"Users MAY review, edit, or delete any memory at any time"*), while the system itself prefers **archive-over-delete** (Dream prune) — except session-tier/expired cleanup, which hard-deletes.

---

## 6. Retrieval / injection into context

Three delivery paths, all budget-conscious:

### 6a. PRISM hook (`.chati.dev/hooks/prism-engine.js`, `UserPromptSubmit`)
Injects a `<chati-context>` XML block into **every prompt**:
- `<agent-memory>`: the active agent's `MEMORY.md` — **truncated to `raw.slice(0, 500)` characters** (so in practice almost nothing survives; the L1/L2/L3 progressive scheme below is the design, this 500-char cap is the reality).
- `<known-gotchas>`: top **3 unresolved** gotchas from `shared/gotchas.json`, ranked by `(agent match ? 10 : 0) + severity(CRITICAL 3/WARNING 2/INFO 1) + min(5, count)`; skipped entirely in the CRITICAL bracket. Comment: *"This is the reliable per-turn, all-agent delivery path; gotchas attached to a handoff alone do not reach interactive agents and do not survive the first agent memory write."*
- Plus mode, pipeline position, team context, and advisories (low-context, frustration detection).

### 6b. Bracket-based progressive retrieval (Progressive Reinforcement)
`context-engine.md` + `memory-layer.md`: retrieval depth scales with context depletion — FRESH: no memory injection; MODERATE: L1 metadata (~50 tokens — IDs/titles/tags); DEPLETED: L2 chunks (~200 tokens — summaries); CRITICAL: L3 full (~1000+ tokens, plus forced handoff). The counterintuitive rule: **budget INCREASES as context degrades** (1.5%→5.0% of window) because the model is forgetting its instructions. Claimed 60–95% token savings vs always loading full memories.

### 6c. Search + handoff + digest
- Keyword search only — no embeddings/RAG: `searchAllMemories()` (`search.js`) does substring matching across gotchas/agent memories/digests with additive heuristic relevance (0–100: agent match +30, message match +40, frequency +min(10,count), recency bonus decaying over 7 days). `getTopMemories()` sorts by confidence for programmatic access.
- Handoffs (two-layer: YAML frontmatter + markdown body) carry decisions/blockers to the next agent; `handoff-engine.js` also pulls `readAgentMemory` + `getRelevantGotchas` into the transition and updates CLAUDE.md.
- PreCompact digest (`session-digest.js`): 8-section structured digest with **per-section token budgets and an explicit `truncation_order`** (`session-memory-tmpl.yaml`, 10K total: decisions_made 3000, next_steps 2300, gotchas_found 2000, files_changed 1000...; `current_agent` and `pipeline_position` never truncated).
- **Bootstrap exception** (Article XIII §8a): before enough memories exist, the digest hook writes a minimal `MEMORY.md` tagged `[source:bootstrap]` at confidence `low`, so the injection layer is never empty — seeded knowledge explicitly marked as low-trust for later re-classification.

---

## 7. Unusual / clever things

**Worth stealing:**
1. **Evidence count separate from confidence** — corroboration (`evidence_count`) and trust (`confidence`) are different numbers; promotion requires both (`confidence > 0.9` AND `evidence >= 5`).
2. **`calibration_status: seed | uncalibrated | calibrated`** — a score means nothing without knowing whether it was guessed or measured; "unknown ≠ low".
3. **Append-only Decision Trail + Echo Detection** — negative memory ("this was wrong, don't redo it") with hash/similarity matching and escalation on recurrence.
4. **Frequency-based promotion** (3 occurrences/24h → gotcha) — knowledge must recur before it becomes durable.
5. **Archive-never-delete pruning** and resolved-flag-not-deletion for gotchas — forgetting is reversible and auditable.
6. **Explicit token budgets everywhere** — per-section digest budgets with truncation order; per-bracket injection budgets; 3-gotcha / 500-char caps.
7. **Evidence-bound verdicts** — claims without tool evidence are automatically demoted to suggestions.
8. **Unresolved-only injection filter** — status field directly gates what reaches context.
9. **Bootstrap entries tagged low-confidence** — cold-start content marked for later re-classification rather than trusted.

**Worth avoiding:**
1. **Two encodings of one scale** (0–1 float vs high/medium/low strings) — caused a real NaN bug (F-A5-010) that silently disabled the promotion rule. kodi's single integer 0–5 avoids this; keep it single.
2. **Confidence assigned by capture-pattern heuristic, never verified** — a regex match on "confirmed..." gets 0.6 forever; trust only ever rises (max-on-merge). No path for a memory to be proven false except manual user deletion.
3. **No file association** — memories can't be invalidated when the code they describe changes.
4. **Contradiction detection that only counts** — detecting conflicting memories and doing nothing is worse than useless (it hides the problem in a report).
5. **Injection cap so small it defeats the system** (500 chars of MEMORY.md) — an elaborate scoring model feeding a keyhole.
6. **Complexity that outran usage** — 4 sectors × 3 tiers × 3 storage tiers × 2 scopes × 7 types, two parallel store formats (frontmatter files AND MEMORY.md), and the archive shows *zero real memories ever written*. The schema was richer than the data.

---

## Lessons for the kodi veracity-score design

Mapping each investigation item to kodi's proposal (0–5 score on file-associated memories; 3 = trustworthy-but-maybe-imperfect; verify-on-load → score up or delete; immutable memories; re-evaluate all memories of a file when the file is edited):

1. **Storage** — Borrow: plain files with YAML frontmatter worked; a JSON Schema for the record (`memory.schema.json`) is cheap and kept fields honest. Avoid: parallel store formats (schema'd files vs freeform `MEMORY.md`) — ChatiDev's injection path read the *unschema'd* one. One store, one format.

2. **Scoring** — Borrow three separations ChatiDev got right: (a) **trust vs retrieval-relevance vs corroboration are different axes** — kodi's 0–5 is trust; don't let load-frequency masquerade as veracity the way ChatiDev's access-count-driven tier promotion did. Consider keeping an `evidence_count`-like counter besides the 0–5. (b) **`calibration_status`**: distinguish "born at 3 (seed prior)" from "verified up to 3" — same number, very different meaning; a `verified_count` or `last_verified_at` field carries this. (c) **Evidence-bound changes**: a score change should require checkable evidence (the verify-on-load result), mirroring Article XXII's evidence rule. Also borrow the threshold-band idea (pass / review / fail) from quality gates for score semantics. Avoid: any secondary string scale.

3. **File association** — ChatiDev has none for memories; the seed to steal is the **Entity Registry's per-path SHA-256 checksum** (Article XIV). Store, per associated file at memory creation/verification time, the file's content hash — then "file edited since last verification" is a cheap O(1) staleness check, independent of edit hooks, and catches out-of-band edits (git pull, other tools) that a hook-only design misses.

4. **Re-evaluation** — This is kodi's genuinely new contribution; ChatiDev only has passive decay. Borrow the *trigger plumbing* though: ChatiDev already ran consolidation from a hook, fire-and-forget detached (`session-digest.js` auto-dream spawn) so the hot path never blocks — kodi's on-file-edit re-scoring should be equally async. Also borrow the Decision Trail idea: when verification *fails* and a memory is deleted, record *what was wrong* in an append-only trail with a content hash — otherwise the extractor/agent will happily re-learn the same false memory next week and kodi has no Echo Detection to catch it. Warning from ChatiDev's design: verification-on-every-load has a token/latency price; ChatiDev budgeted injection ruthlessly (3 gotchas, 500 chars, bracket budgets). Consider verifying on load only when the associated file's hash changed, or at score-dependent frequency (a 5 needs less checking than a 1 — though kodi's "even max-score ones get re-evaluated on file edit" correctly closes the loophole ChatiDev left: its HOT memories were never re-examined).

5. **Immutability** — kodi's "memories are NOT editable" matches ChatiDev's best-behaved store (the append-only Decision Trail), not its worst (in-place rewritten `MEMORY.md`, whose merge logic silently mutated confidence). One refinement from ChatiDev: it never hard-deleted knowledge the system had learned — Dream **archives** pruned entries; gotchas get a `resolution`, not deletion. kodi's "verify fails → delete" should probably be "verify fails → tombstone/archive with reason" — same context hygiene, but auditable, reversible, and it feeds the anti-relearning trail from point 4. (Keep user-initiated hard delete, per Article XIII §6.)

6. **Retrieval/injection** — Borrow: score-gated injection tiers (ChatiDev's HOT auto-load / WARM on-demand / COLD search-only maps cleanly onto 0–5 bands, e.g. 4–5 auto-inject, 2–3 on-demand, 0–1 never), unresolved/valid-only filters at the injection point, hard per-turn caps, and explicit truncation order. Avoid: making injection so stingy the memory system is decorative (the 500-char lesson), and avoid ChatiDev's positive feedback loop where being injected raises the score that causes injection — kodi's design breaks that loop correctly by making the *verification result*, not the load itself, move the score.

7. **General** — ChatiDev's memory layer was over-designed and under-used: 800+ framework files, zero memories on disk. The single biggest meta-lesson: **ship the smallest loop that actually runs** (capture → associate → verify → score → inject → re-verify on change) before adding sectors, tiers, scopes, and dream cycles. kodi's proposal is already that minimal loop — resist re-adding ChatiDev's taxonomy until real memories exist.

---

## Key evidence index (all paths relative to `/home/luis0ares/dynac/new-xpto/archive/chatidev/`)

| Topic | File |
|---|---|
| Memory record schema (confidence 0–1, tiers, sectors, evidence_count) | `.chati.dev/schemas/memory.schema.json` |
| Memory design doc (attention score formula, tier transitions, Dream, retrieval levels) | `.chati.dev/intelligence/memory-layer.md` |
| Memory governance (auto-capture, >0.9+evidence≥5 promotion, user edit rights, bootstrap) | `.chati.dev/constitution.md` Article XIII (lines 360–387); summary in `.claude/rules/chati/governance.md` |
| Decision Trail + Echo Detection (append-only, evidence_hash, ≥0.85 similarity) | `.chati.dev/constitution.md` Article XXII (lines ~700–760) |
| Agent memory read/write/bootstrap (high/medium/low strings, in-place rewrite) | `.chati.dev/_cli/memory/agent-memory.js` |
| Dream consolidation (normalizeConfidence NaN fix, max-merge, contradiction count, archive-prune) | `.chati.dev/_cli/memory/dream.js` |
| Gotcha lifecycle (3x/24h promotion, path-stripping normalization, resolution flag, file lock) | `.chati.dev/_cli/memory/gotchas.js` |
| Per-turn extraction (regex patterns, per-type base confidences, 3/turn cap) | `.chati.dev/_cli/memory/memory-extractor.js` |
| Injection hook (500-char memory cap, top-3 unresolved gotchas, brackets) | `.chati.dev/hooks/prism-engine.js` |
| Capture hook (PreCompact digest, daily append, bootstrap MEMORY.md, async dream spawn) | `.chati.dev/hooks/session-digest.js` / `.chati.dev/_cli/memory/session-digest.js` |
| Agent confidence calibration (seed/uncalibrated/calibrated) | `.chati.dev/intelligence/confidence.yaml` |
| Entity registry with per-path SHA-256 checksums + adaptability | `.chati.dev/intelligence/decision-engine.md`, `.chati.dev/data/entity-registry.yaml`, Article XIV |
| Digest token budgets + truncation order | `.chati.dev/templates/session-memory-tmpl.yaml` |
| Progressive retrieval / bracket budgets | `.chati.dev/intelligence/context-engine.md` |
| Search relevance heuristics (0–100 additive) | `.chati.dev/_cli/memory/search.js` |
| CLAUDE.md auto-update (Magic Docs) | `.chati.dev/_cli/memory/magic-docs.js` |
| Seeded knowledge stores | `.chati.dev/intelligence/gotchas.yaml`, `.chati.dev/intelligence/patterns.yaml` |
| Handoff format (frontmatter with quality_score, decisions) | `.chati.dev/tasks/orchestrator-handoff.md`, `.chati.dev/_cli/orchestrator/handoff-engine.js` |
| Empty runtime stores (design vs usage gap) | `.chati/memories/**` (0 files), `artifacts/decisions/`, `artifacts/handoffs/` (empty), `.chati/session.yaml`, `.chati/timeline.json` |
