# `kodi memory` — Improvement Plan & Competitive Analysis

> Status: living engineering doc · Last updated: 2026-07-12
> Scope: the cross-session memory store shipped in `src/memory/` (`db.ts`, `store.ts`, `template.ts`) and `src/commands/memory.ts`.
> Baseline design decisions (FTS5/BM25, no embeddings, `node:sqlite`, one global DB, CLI-only transport) are **locked** — this doc improves on that baseline, it does not re-litigate it.

---

## 1. Executive summary

`kodi memory` is a machine-global, cross-session knowledge store for AI coding agents. Claude (or any agent that can run Bash) persists findings about a repo — decisions, gotchas, conventions, architecture notes — into a single SQLite database at `~/.kodi/rag.db`, partitioned into one collection per project, and retrieves them later via lexical full-text search (FTS5/BM25) plus metadata filters (`--type`, `--ticket`, `--file`, `--since`). A SessionStart hook injects a small digest of recent memories into every new session, and a `/remember` skill plus an installed rule teach the agent to store and query.

**Where it stands.** The design occupies a deliberately contrarian position in a market that has almost universally converged on embeddings: zero runtime dependencies, zero API keys, fully offline, one file, instant startup. That's a genuine moat for a CLI tool — every competitor surveyed below either requires a Python runtime, a vector DB, an LLM/embedding API, a server process, or all four. The closest philosophical relatives are Claude Code's own file-based memory (grep-able Markdown, no vectors) and claude-mem's FTS5 core — evidence that "lexical + structure beats vectors for developer-tool memory" is a defensible bet, not a shortcut.

**Where it can go.** The competitive gap is not storage — it's *retrieval intelligence* and *memory lifecycle*. Every serious competitor does three things we don't: (1) rank by more than raw text match (recency, importance, usage), (2) consolidate memory over time (merge near-duplicates, invalidate stale facts, decay), and (3) scope injection to what the agent is *about to do*, not just what happened recently. All three are achievable inside the locked design — pure SQL + heuristics, no embeddings required — and an optional sqlite-vec + local-ONNX hybrid layer remains a clean, additive upgrade path the schema already anticipates.

**Bottom line.** The recommended next step (§5) is **retrieval-quality bundle v1**: smarter FTS query building + recency/BM25 blended scoring + active-ticket-scoped digest. It is the highest leverage per unit of effort, needs no new dependencies, and directly attacks the two weakest links in the current loop (naive OR-of-tokens matching and a recent-N-only digest).

---

## 2. The baseline (what we shipped)

Quick recap so the rest of the doc is self-contained:

| Aspect | Decision |
|---|---|
| Retrieval | SQLite **FTS5 + BM25**, metadata filters. No embeddings, no API keys, offline. |
| Engine | Node built-in `node:sqlite` (`DatabaseSync`), FTS5 compiled in. `engines: node>=24`. Zero new runtime deps. |
| Location | One DB: `~/.kodi/rag.db` (`$KODI_HOME` override). WAL mode on. |
| Partitioning | One **collection per project**: id `<slug>-<shorthash(rootPath)>`, bound in `.claude/kodi-dev.yaml`, registered in DB by root path; auto-provisioned. |
| Record | `id`, `collection`, `content` (FTS-indexed), `type` (`decision\|gotcha\|convention\|architecture\|reference\|task-note`), `ticket?`, `files[]`, `createdAt`, `contentHash` (dedup), derived `title`. |
| Commands | `store` (idempotent by hash), `query` (`--type/--ticket/--file/--since/--limit/--json`), `list`, `amend`, `rm`, `export`/`import` (YAML, dedup). |
| Wiring | SessionStart hook prints recent-N digest; `/remember` skill + rule drive store/query behavior. |
| Transport | CLI only. No MCP server. |
| Future-proofing | Schema designed so a vector column/table can be added later. |

Implementation facts referenced later: FTS is a standalone `memories_fts(memory_id UNINDEXED, content, title)` table kept in sync manually; query text becomes `"tok1" OR "tok2" …`; digest = `recentMemories(limit 5)` = newest-first; `--file` filter is `files_json LIKE '%…%'`.

---

## 3. Competitive analysis

### 3.1 The landscape at a glance

| System | What it is | Retrieval | Local vs cloud | Runtime deps | Memory lifecycle (dedup/decay/update) | What kodi should borrow |
|---|---|---|---|---|---|---|
| **kodi memory** (baseline) | CLI knowledge store for coding agents | Lexical (FTS5/BM25) + metadata filters | 100% local, offline | None (Node ≥24 built-ins) | Exact-hash dedup only | — |
| **[mem0](https://github.com/mem0ai/mem0)** | "Universal memory layer" SDK + SaaS | Hybrid: vector + graph + KV, LLM-extracted facts, multi-signal fusion (semantic + BM25 + entity) | Both (OSS self-host or platform) | Python/TS SDK, vector DB, LLM API for extraction, optional Neo4j/Kuzu | Two-phase pipeline: LLM extraction → conflict detection & update (ADD/UPDATE/DELETE ops) | Conflict-aware update: new info can *supersede* old memories, not just pile up |
| **[Letta / MemGPT](https://www.letta.com/blog/memory-blocks/)** | Stateful-agent framework; agent self-manages memory via tools | Tiered: in-context "core memory blocks" + searchable recall + archival (vector) | Self-host or cloud | Python server, Postgres, LLM API | Agent itself rewrites/compacts its memory blocks (self-editing) | The *core block* idea: a small always-in-context, size-capped digest the agent curates — maps to our SessionStart digest |
| **[Zep / Graphiti](https://github.com/getzep/graphiti)** | Temporal knowledge graph memory ([paper](https://arxiv.org/abs/2501.13956)) | Hybrid: semantic + BM25 full-text + graph traversal; bi-temporal edges with `t_valid`/`t_invalid` | Graphiti OSS local-ish (needs Neo4j/FalkorDB + LLM); Zep is cloud | Python, graph DB, embeddings + LLM APIs | Fact **invalidation**: contradicted edges get an invalid-at timestamp instead of deletion | Temporal validity: mark memories superseded (not deleted) so history is auditable |
| **[txtai](https://github.com/neuml/txtai)** | All-in-one embeddings DB (vectors + sparse + graph + SQL, SQLite-backed) | Hybrid dense+sparse with SQL filtering | Fully local possible | Python, sentence-transformers/ONNX | None built-in (it's a search engine, not a memory manager) | Proof that SQLite + local ONNX embeddings is a viable fully-offline hybrid stack |
| **[LangMem (LangChain)](https://www.digitalocean.com/community/tutorials/langmem-sdk-agent-long-term-memory)** | SDK for agent long-term memory over LangGraph stores | Vector store search; semantic/episodic/procedural memory types | Local or hosted store | Python, LangGraph, embedding API | Background "memory manager" consolidates & updates memories after sessions | The **background consolidation pass** pattern (ours could be a `kodi memory compact` command) |
| **[LlamaIndex Memory](https://docs.llamaindex.ai/en/stable/module_guides/deploying/agents/memory/)** | Memory composed of blocks: static, fact-extraction, vector-retrieval | Per-block: static text, LLM fact extraction, vector search | Local possible | Python, usually embedding/LLM API | Fact block dedupes/updates extracted facts | Typed memory *blocks* with different retrieval strategies per type — analogous to per-`type` digest sections |
| **[Chroma](https://www.trychroma.com/products/chromadb)** | Embedded OSS vector DB (also does FTS + regex + metadata) | Dense + sparse + full-text + metadata, hybrid | Fully local (embedded) | Python/JS client + local model (default all-MiniLM-L6-v2) | None (storage layer) | Its "collection" ergonomics; validation that <100K-vector embedded local search is trivial scale |
| **[sqlite-vec](https://github.com/asg017/sqlite-vec)** | Vector-search SQLite extension, pure C, no deps, runs anywhere ([intro](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)) | Brute-force KNN over vectors in SQLite; pairs with FTS5 for [hybrid + RRF](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html) | Fully local | One loadable `.so`/`.dylib` (~100s of KB); needs `allowExtension: true` in [`node:sqlite`](https://nodejs.org/api/sqlite.html) | n/a | **The** designated vector upgrade path for our schema |
| **[sqlite-vss](https://github.com/asg017/sqlite-vss)** | Predecessor of sqlite-vec (Faiss-based) | Vector (Faiss) | Local | Heavy C++ deps, Linux/macOS only | n/a | Nothing — [explicitly deprecated in favor of sqlite-vec](https://alexgarcia.xyz/blog/2024/building-new-vector-search-sqlite/) |
| **[Cursor Memories + Rules](https://hindsight.vectorize.io/blog/2026/06/12/cursor-persistent-memory)** | IDE-native: auto-generated per-project "memories" + static `.cursor/rules/*.md` | Injection, not search: rules/memories loaded into every chat | Memories sync via Cursor cloud; rules are local files | None (product feature) | User approves/edits memories in settings | Reliability of *injection on first prompt* — our digest already does this; borrow their per-project scoping discipline |
| **[Claude Code memory](https://code.claude.com/docs/en/memory)** (CLAUDE.md + auto memory) | Markdown files: user-authored CLAUDE.md + Claude-maintained `MEMORY.md` index → topic files | File reads + grep; index loaded at session start, details on demand ([memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)) | Fully local files | None | Claude curates its own files; guidance: keep <200 lines | **Progressive disclosure**: load a cheap index first, fetch full records on demand — our digest should list titles, not bodies |
| **[claude-mem](https://github.com/thedotmack/claude-mem)** | Claude Code plugin: hooks capture everything, AI-compress, re-inject ([docs](https://docs.claude-mem.ai/introduction)) | **Hybrid: SQLite FTS5 + Chroma vectors**; layered "progressive disclosure" retrieval | Local (uses agent-sdk for compression) | Node, Chroma, background worker process | AI summarization/compression per session; `<private>` tag exclusion | Closest direct competitor. Borrow: observation capture via PostToolUse, token-cost-visible layered retrieval. Avoid: its background-worker complexity |
| **[OpenAI / ChatGPT memory](https://help.openai.com/en/articles/8590148-memory-faq)** | Product memory: saved memories + chat-history reference; "Dreaming V3" background synthesis ([overview](https://www.digitalapplied.com/blog/chatgpt-memory-dreaming-v3-openai-2026-guide)) | Opaque; synthesized memory state injected at chat start | Cloud only | n/a | Continuous background re-synthesis; memories update themselves over time | The *product* lesson: memory that maintains itself wins; explicit "manage memories" UI (our `list`/`amend`/`rm` already cover this) |
| **SQLite-as-RAG write-ups** ([sqlite.ai](https://blog.sqlite.ai/building-a-rag-on-sqlite), [sqlite-rag](https://github.com/sqliteai/sqlite-rag), [Alex Garcia](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)) | Pattern literature | FTS5 alone → known paraphrase misses; consensus fix = FTS5 + vec + **Reciprocal Rank Fusion** | Local | Varies | n/a | The exact hybrid recipe (RRF, k=60) when/if we add vectors |

### 3.2 What the landscape tells us

**1. Everyone converged on hybrid retrieval — but for conversational memory, not repo knowledge.** mem0, Zep, txtai, Chroma, claude-mem all fuse semantic + lexical (+ graph). Their driving use case is paraphrase-heavy conversational recall ("user said they're vegetarian" ↔ "dietary preferences"). Our corpus is different: short, technical, entity-dense notes written *by the same model that later queries them*. Identifiers (`ragDbPath`, `KODI_HOME`, ticket IDs, file paths) dominate, and BM25 is *strong* at exact-entity matching — Alex Garcia's own hybrid-search guidance notes exact matches like internal project names are where FTS shines. Lexical-first is the right default here; the gap is real but narrower than the market's marketing implies.

**2. Nobody else is dependency-free.** mem0 needs an LLM for extraction. Letta needs a server + Postgres. Zep/Graphiti needs a graph DB + two model APIs. claude-mem — our closest competitor — needs Chroma plus a background worker over HTTP. txtai/Chroma need Python-ecosystem model runtimes. kodi's "npm i -g and it works offline forever" story is unique in this table. Protect it: every improvement below is either pure SQL/TS, or explicitly **optional** (the sqlite-vec layer).

**3. The differentiator among serious systems is lifecycle, not storage.** mem0's extraction→conflict-resolution pipeline, Zep's bi-temporal fact invalidation, LangMem's background consolidation, OpenAI's "Dreaming" re-synthesis — the theme is that memory must be *maintained*, not just accumulated. We currently only append (exact-hash dedup). This is our biggest conceptual gap and it's fixable without any of their infrastructure (§4.2, §4.4).

**4. Claude Code's own memory validates our architecture — and defines the bar for injection.** Anthropic's auto memory is lexical, file-based, and uses progressive disclosure (index at start, details on demand). Our SessionStart digest is the same move; ours should get smarter about *what* to surface (active ticket, touched files) rather than *how much*.

**5. claude-mem is the competitor to watch.** Same host (Claude Code), same core engine choice (SQLite FTS5), massive adoption. Its bets that differ from ours: automatic capture of *everything* (vs our curated, rule-driven `store`), AI compression (costs tokens/latency), Chroma sidecar (dependency weight). kodi's counter-position is deliberate curation + zero deps + shared-across-tools CLI. Keep that position, but match its retrieval layering.

**6. sqlite-vec is the right vector path but carries maintenance risk.** It's tiny, pure C, WASM-capable, Mozilla Builders-backed — and it slots into `node:sqlite` via `new DatabaseSync(path, { allowExtension: true })` + `loadExtension()` ([Node docs](https://nodejs.org/api/sqlite.html)). But the project has had maintainer-availability gaps (community fork [vlasky/sqlite-vec](https://github.com/vlasky/sqlite-vec) exists for that reason). Conclusion: fine as an **optional, ship-nothing-by-default** layer; wrong as a hard dependency. For the embedding step, [Transformers.js + all-MiniLM-L6-v2 ONNX](https://huggingface.co/Xenova/all-MiniLM-L6-v2) runs offline in Node after a one-time model download (384-dim, good for note-sized text).

---

## 4. Gaps & risks in the current design

Ordered roughly by user-visible impact. Each maps to a roadmap item in §5.

### 4.1 Naive FTS query building (highest-impact retrieval bug-class)
`toFtsQuery` lowercases, strips punctuation, and ORs every token: `"fix" OR "the" OR "auth" OR "redirect"`. Consequences:
- Stopwords match everything → one common token can flood results; BM25 mitigates but doesn't eliminate.
- No phrase support (`"connection pool"` as a unit), no prefix matching (`provis*` → `provisionCollection`), no AND-tightening when many tokens are given.
- `bm25()` is called unweighted — `title` and `content` count equally, and the `memory_id UNINDEXED` column still occupies a weight slot.
- Code identifiers get shredded: `files_json` → `files` OR `json`; camelCase isn't split, so querying `ragDbPath` won't match a note that wrote `rag db path` (or vice versa).
→ Roadmap **N1**.

### 4.2 Lexical-only recall misses paraphrases (known, accepted — needs a bounded answer)
"auth token refresh loop" won't match a memory phrased "renewing the JWT re-triggers itself." Structural mitigations exist (store-time keyword enrichment, type/file filters), and the optional sqlite-vec hybrid is the full answer. The risk of doing nothing: silent recall failure — the agent re-learns something it already stored and trust in the feature erodes invisibly. → **N1** (partial), **L1** (full).

### 4.3 Digest is recent-N only — no relevance to current work
`recentMemories(limit 5)` = newest five, period. A 3-month-old critical gotcha about the file you're editing never surfaces; five task-notes from yesterday's unrelated ticket crowd the digest. No active-ticket scoping, no per-type prioritization (a `gotcha` should outrank a `task-note`), and the digest prints bodies rather than an index (contra the progressive-disclosure pattern Claude Code's own memory uses). → **N2**.

### 4.4 No ranking beyond raw BM25; no recency or importance signal
Query results order purely by BM25 (or purely by recency without text). There is no blended score, no importance field, no usage tracking (a memory retrieved 20 times is probably load-bearing), no decay for stale `task-note`s. Every mature system in §3 ranks on fused signals. → **N3**.

### 4.5 Dedup is exact-hash only; no near-duplicate handling
`contentHash` catches byte-identical re-stores. It does not catch "Vitest needs `pool: forks` for DB tests" vs "DB tests require Vitest fork pool" — and an agent re-discovering a fact will phrase it differently ~every time. Result: the store degrades into paraphrase clutter that also pollutes retrieval (near-dupes split BM25 mass and consume digest slots). Also: `amend` recomputes the hash but doesn't handle colliding with an existing row's `UNIQUE(collection_id, content_hash)` — it will throw an unhandled constraint error. → **N4** (+ quick fix for the amend bug).

### 4.6 No retention, eviction, or size limits
Nothing ever expires. `task-note`s are session-scoped by nature but immortal in practice. A busy repo accumulates hundreds of memories; digest and query quality decay monotonically. No `kodi memory stats`, no compaction, no cap warnings. → **X2** (stats now), **L2** (retention).

### 4.7 Concurrency: WAL is on, but that's it
Parallel agents (kodi's whole premise) can hit the same DB. WAL allows one writer + many readers, but:
- No `PRAGMA busy_timeout` — a second concurrent writer gets an immediate `SQLITE_BUSY` throw instead of a short wait.
- `rawInsert` does two statements (row + FTS) **without a transaction** — a crash between them leaves the FTS index inconsistent; same for `amendMemory`/`removeMemory`.
- Store-then-query within one agent is fine (synchronous), but cross-process races on `provisionCollection` (SELECT-then-INSERT) can double-insert on first use in two panes at once — the `root_path UNIQUE` constraint would throw rather than converge.
→ **X1** (cheap, do immediately).

### 4.8 No cross-collection / global search
Hard-won knowledge is siloed per project. "How did we fix this pnpm workspace issue in the other repo?" has no answer. Monorepos and multi-repo platforms want at least an opt-in `--global`. → **N5**.

### 4.9 No linkage between memories
Memories are atomic and unconnected: a `decision` can't reference the `gotcha` that motivated it; a superseding note can't point at what it replaces. Zep's edge-invalidation and mem0's UPDATE ops both rest on relations we don't have. Minimal viable version: a `relates_to`/`supersedes` link table. → **L3**.

### 4.10 Export is plaintext; multi-machine story is manual
YAML export may contain internal architecture notes, ticket names, file paths — fine locally, risky when the file is shared/committed. No encryption option, no merge-aware sync (import dedup is exact-hash, so paraphrased cross-machine duplicates double up). Deliberately out of near-term scope, but state the position: exports are sensitive artifacts; document that, add optional `age`-style encryption later. → **L4**.

### 4.11 Smaller sharp edges
- `--file` filter uses `LIKE '%str%'` on the JSON array — `--file api.ts` matches `webapi.tsx`. Needs `json_each` (SQLite has JSON1 built in).
- `title` is FTS-indexed but the digest/query UX never exploits titles as a first-class index (ties into 4.3's progressive disclosure).
- No `schema_version` table — future migrations (importance column, links table, vec table) need one. Add it with the first schema-touching change.
- Collection identity keys on absolute root path — the same repo cloned at two paths gets two collections (WSL vs Windows path duality is a live risk in this environment). A repo-fingerprint fallback (e.g., first-commit hash) could unify them; low priority, note it.

---

## 5. Prioritized improvement roadmap

Effort scale: **S** ≤ half a day · **M** ≈ 1–2 days · **L** ≈ 3–5 days. All items preserve locked decisions and the existing CLI surface (only additive flags).

### Phase 0 — Immediately (hygiene, ship this week)

#### X1 · Concurrency & integrity hardening — **S**
- **Problem:** §4.7 — no busy_timeout, non-transactional dual writes, racy provisioning.
- **Change:** in `openDb`: `PRAGMA busy_timeout = 5000`. Wrap `rawInsert`/`amendMemory`/`removeMemory` bodies in a transaction. Make `ensureCollectionRow`/`provisionCollection` use `INSERT ... ON CONFLICT(root_path) DO NOTHING` + re-select. Catch the `amend` hash-collision constraint error and report "amend would duplicate memory <id>".
- **Fits:** pure `db.ts`/`store.ts`; zero schema/CLI change.

#### X2 · `kodi memory stats` + `schema_version` — **S**
- **Problem:** §4.6/§4.11 — no visibility into growth; no migration anchor.
- **Change:** `stats` subcommand (per-collection counts by type, oldest/newest, DB size); create `schema_version` table now so every later phase has a migration hook.
- **Fits:** one command in `commands/memory.ts`; additive table.

### Phase 1 — Now (retrieval-quality bundle v1: the recommended next step, §6)

#### N1 · Richer FTS query building — **S/M**
- **Problem:** §4.1 — OR-of-tokens with no phrases, prefixes, weights, or identifier handling.
- **Change (all in `toFtsQuery` + one SQL line):**
  - Split camelCase/snake_case at index *and* query time (store a normalized shadow of content in the FTS row: `ragDbPath` → `ragDbPath rag db path`). FTS content is already a separate table, so no `memories` change.
  - Drop a small stopword list from the OR set; require ≥1 non-stopword.
  - Quoted spans in the query become FTS phrases; last token gets `*` prefix matching.
  - Two-pass matching: try AND of tokens first; if under `limit` results, fall back to OR (cheap "tightening").
  - Weight title: `bm25(memories_fts, 0.0, 1.0, 3.0)` (memory_id slot zeroed, title ×3).
- **Fits:** no schema migration except an FTS rebuild (`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')` after re-populating normalized text); no CLI change.

#### N2 · Active-context-scoped digest — **M**
- **Problem:** §4.3 — digest is recent-5 regardless of what the session is about.
- **Change:** replace `recentMemories` in the SessionStart hook with a composed digest budgeted at ~600 tokens:
  1. **Pinned section:** all `gotcha` + `decision` hits for the active ticket (from board state / branch name) — full content.
  2. **Warm section:** memories whose `files[]` intersect recently-changed files (`git diff --name-only HEAD~5`, cheap) — titles only.
  3. **Recent section:** newest N remaining — **titles + ids only**, with a printed hint: `kodi memory query --json <id|text>` to expand.
- **Fits:** new `digestMemories(db, collection, {ticket?, files?})` in `store.ts`; hook already exists; progressive disclosure per Claude Code's own pattern.

#### N3 · Blended scoring: BM25 × recency (× importance later) — **S**
- **Problem:** §4.4 — raw BM25 ignores age and weight class.
- **Change:** `score = bm25 * typeBoost * recencyFactor` computed in SQL: `recencyFactor = 1.0 / (1.0 + age_days/90.0)` (half-life ~3 months); `typeBoost`: gotcha/decision 1.5, convention/architecture 1.2, reference 1.0, task-note 0.7. Add `--rank bm25|blended` (default blended) for debuggability. Track `last_accessed_at`/`access_count` columns (updated on query hits) now so importance-by-usage can join the formula later.
- **Fits:** two nullable columns via `schema_version` migration; ORDER BY expression change in `queryMemories`.

#### N4 · Near-duplicate detection at store time — **M**
- **Problem:** §4.5 — paraphrase clutter; only byte-identical dedup.
- **Change:** on `store`, run the new N1 query with the draft's own content against the same collection+type; compute token-set Jaccard between draft and top hit (after camelCase/stopword normalization). If ≥0.8 → treat as dupe (return existing id, exit 0, message "near-duplicate of mem_x; use amend to update"); 0.5–0.8 → store but warn with the sibling id. `--force` bypasses. Pure lexical, zero deps — this is store-time hygiene, not a merge pass (merge is L2's compaction).
- **Fits:** `insertMemory` gains a pre-check; import loop reuses it with dupes counted as `skipped`.

### Phase 2 — Next

#### N5 · `--global` cross-collection query — **S**
- **Problem:** §4.8 — knowledge siloed per project.
- **Change:** `kodi memory query --global` drops the `collection_id` filter and prefixes results with collection name. Explicit opt-in only — never in the digest (cross-repo notes in context are noise and a mild confusion/leak risk in shared-screen situations). Pairs with `list --collections`.
- **Fits:** filter-list change in `queryMemories` + flag plumb-through.

#### N6 · `--file` filter correctness — **S**
- **Problem:** §4.11 — `LIKE` substring false-positives.
- **Change:** `EXISTS (SELECT 1 FROM json_each(m.files_json) WHERE json_each.value = ? OR json_each.value LIKE ? || '/%' ...)` — exact file or directory-prefix semantics. JSON1 is built into SQLite; no schema change.

#### N7 · Store-time keyword enrichment (paraphrase mitigation without vectors) — **M**
- **Problem:** §4.2 — bounded lexical answer to paraphrase misses.
- **Change:** optional `--keywords a,b,c` on `store`, appended to the FTS shadow text (not the displayed content). Update the `/remember` skill to instruct the agent: "include 3–5 alternate phrasings/synonyms as keywords." The *caller is already Claude* — we can get semantic expansion at write time for free, which is exactly the insight that killed the `claude -p` retrieval layer, applied where it's cheap instead.
- **Fits:** nullable `keywords` column + FTS shadow concat; additive flag.

### Phase 3 — Later

#### L1 · Optional hybrid search: sqlite-vec + local ONNX embeddings — **L**
- **Problem:** §4.2 in full — semantic recall for paraphrases.
- **Change:** `kodi memory index --semantic` (explicit opt-in): downloads [all-MiniLM-L6-v2 ONNX](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (~25 MB, one-time) and the sqlite-vec loadable for the platform; embeds each memory (they're note-sized — within MiniLM's ~256-token sweet spot) into a `vec0` table keyed by memory id; `openDb` gains `{ allowExtension: true }` **only when the feature is enabled** ([node:sqlite docs](https://nodejs.org/api/sqlite.html)). Query path: run FTS and KNN, fuse with [RRF (k=60)](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html) exactly as the sqlite-vec author prescribes. Everything degrades gracefully to FTS-only when the extension/model is absent — zero-dep default preserved.
- **Risks to manage:** sqlite-vec maintainer-availability history (pin version; the [community fork](https://github.com/vlasky/sqlite-vec) is a fallback); Transformers.js pulls onnxruntime (~heavy) — keep it an *optional* peer/lazy install, never in `dependencies`.
- **Fits:** the schema anticipated this; `vec0` virtual table + `embeddings_meta` (model, dims) via migration.

#### L2 · Retention & compaction — **M**
- **Problem:** §4.6 — unbounded growth, immortal task-notes.
- **Change:** `kodi memory compact`: (a) archive `task-note`s older than 90 days for closed tickets (move to an `archived` flag — soft delete, exportable, excluded from FTS/digest); (b) surface near-duplicate clusters (N4's Jaccard, run pairwise within type) with `--merge` to keep newest + union `files[]` + record a `supersedes` link (needs L3's table). Never auto-delete `decision`/`gotcha`. Warn in `stats` past ~500 active memories per collection.

#### L3 · Memory linking — **M**
- **Problem:** §4.9 — no supersedes/relates-to relations.
- **Change:** `memory_links(from_id, to_id, kind CHECK(kind IN ('supersedes','relates_to','caused_by')))`; `store --supersedes <id>` marks the target archived (Zep-style invalidation-not-deletion: history stays auditable); `query` output annotates `supersededBy`. This is the 20% of a knowledge graph that yields 80% of the value with zero graph infrastructure.

#### L4 · Sync & export hardening — **M/L**
- **Problem:** §4.10 — plaintext exports, no multi-machine story.
- **Change:** document exports-are-sensitive now (README + `/remember` skill note: never store secrets in memory content). Later: `export --encrypt` (age-style, passphrase); the honest multi-machine mechanism is export → commit to a private repo → `import` (already dedup-safe; N4 makes it paraphrase-dedup-safe). Do **not** build live DB sync — SQLite-over-Dropbox/OneDrive corruption is a classic failure mode.

### Roadmap summary

| # | Item | Effort | Deps | Gap |
|---|---|---|---|---|
| X1 | busy_timeout, transactions, race-safe provisioning | S | none | 4.7 |
| X2 | `stats` + `schema_version` | S | none | 4.6, 4.11 |
| N1 | FTS query building (phrase/prefix/weights/identifier-split) | S/M | none | 4.1, 4.2 |
| N2 | Context-scoped digest (ticket + files + titles-only recent) | M | none | 4.3 |
| N3 | Blended BM25 × recency × type scoring | S | X2 | 4.4 |
| N4 | Near-duplicate detection at store time | M | N1 | 4.5 |
| N5 | `--global` query | S | none | 4.8 |
| N6 | `--file` via `json_each` | S | none | 4.11 |
| N7 | Store-time keyword enrichment | M | N1 | 4.2 |
| L1 | Optional sqlite-vec + local ONNX hybrid (RRF) | L | X2 | 4.2 |
| L2 | Retention & compaction | M | N4, L3 | 4.6 |
| L3 | Memory linking (`supersedes`) | M | X2 | 4.9 |
| L4 | Export encryption; documented sync posture | M/L | N4 | 4.10 |

---

## 6. Recommended next step

**Ship the retrieval-quality bundle: N1 + N2 + N3 (with X1/X2 folded in as prep), before anything semantic.**

Why this and not the flashier hybrid-search work:

1. **It attacks the actual failure loop.** The feature succeeds only if the agent's *first* query finds the memory and the digest surfaces the *right* memories unprompted. Today both hinge on an OR-of-tokens query and a recent-5 digest — the weakest components in the pipeline. No amount of vector search fixes a digest that ignores the active ticket.
2. **Best leverage per effort.** ~3–4 days total, zero new dependencies, zero risk to the locked zero-dep story, and every subsequent item (near-dup detection, compaction, even RRF fusion) builds on N1's normalized matching and N3's scoring columns.
3. **It compounds with the corpus we don't have yet.** Semantic search shines on large, paraphrase-heavy corpora; collections are small today. Meanwhile every memory stored under the current naive matcher is a memory that may become unfindable. Fix retrieval before scale makes fixes retroactive work (N1's FTS shadow requires a rebuild — cheapest now).
4. **It keeps the strategic option open, cheaper.** N1's identifier-splitting + N7's write-time keyword enrichment shrink the paraphrase gap that L1 exists to close — after the bundle, measure real recall misses before spending an L on sqlite-vec. If misses persist, L1 is fully specified above and the schema is ready.

**Definition of done for the bundle:** phrase/prefix/AND-first queries with weighted BM25; digest = pinned ticket gotchas/decisions + file-relevant titles + recent titles within a token budget; blended ranking behind `--rank`; transactional writes with busy_timeout; `stats` + `schema_version` landed. Add a small retrieval regression fixture (20 stored memories, 15 canned queries with expected top-3) so N1/N3 changes are measurable, and so L1's future value can be judged with data instead of vibes.

---

## Appendix: sources

- mem0 — [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0) · [AI memory layer guide](https://mem0.ai/blog/ai-memory-layer-guide) · [architecture overview](https://mem0.ai/blog/what-is-ai-agent-memory)
- Letta / MemGPT — [Memory Blocks blog](https://www.letta.com/blog/memory-blocks/) · [MemGPT agents docs](https://docs.letta.com/guides/legacy/memgpt_agents_legacy)
- Zep / Graphiti — [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) · [github.com/getzep/graphiti](https://github.com/getzep/graphiti) · [Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)
- txtai — [github.com/neuml/txtai](https://github.com/neuml/txtai) · [intro post](https://medium.com/neuml/introducing-txtai-the-all-in-one-embeddings-database-c721f4ff91ad)
- LangMem — [DigitalOcean tutorial](https://www.digitalocean.com/community/tutorials/langmem-sdk-agent-long-term-memory) · [status notes](https://rywalker.com/research/langmem)
- LlamaIndex memory — [docs.llamaindex.ai memory guide](https://docs.llamaindex.ai/en/stable/module_guides/deploying/agents/memory/)
- Chroma — [trychroma.com](https://www.trychroma.com/products/chromadb)
- sqlite-vec — [github.com/asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) · [v0.1.0 announcement](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html) · [hybrid FTS+vec+RRF](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html) · [community fork](https://github.com/vlasky/sqlite-vec)
- sqlite-vss (deprecated) — [github.com/asg017/sqlite-vss](https://github.com/asg017/sqlite-vss) · [successor rationale](https://alexgarcia.xyz/blog/2024/building-new-vector-search-sqlite/)
- Cursor memories/rules — [Hindsight analysis](https://hindsight.vectorize.io/blog/2026/06/12/cursor-persistent-memory)
- Claude Code memory — [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) · [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- claude-mem — [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) · [docs](https://docs.claude-mem.ai/introduction)
- OpenAI memory — [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq) · [saved memories](https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work) · [Dreaming V3 coverage](https://www.digitalapplied.com/blog/chatgpt-memory-dreaming-v3-openai-2026-guide)
- SQLite-as-RAG pattern — [Building a RAG on SQLite](https://blog.sqlite.ai/building-a-rag-on-sqlite) · [sqliteai/sqlite-rag](https://github.com/sqliteai/sqlite-rag)
- node:sqlite extension loading — [nodejs.org/api/sqlite.html](https://nodejs.org/api/sqlite.html)
- Local embeddings in Node — [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) · [vector embeddings in Node.js](https://philna.sh/blog/2024/09/25/how-to-create-vector-embeddings-in-node-js/)
