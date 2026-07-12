# `kodi memory` — critical assessment: impact, token economics, what's worth changing

> Status: critique / decision doc · 2026-07-12
> An honest, adversarial look at whether the memory feature (shipped in `src/memory/`
> + the three hooks in `src/commands/hook.ts`) actually earns its keep. Companion to
> `docs/memory-improvements.md` (the roadmap) — this doc justifies *which* roadmap
> items matter and why, and states the decision.
> **Bias note:** written by the same author who built it; the goal here is to attack
> it, not defend it.

---

## 1. The one-sentence verdict

The feature **adds context (tokens) on every turn** in exchange for savings that only
materialize **when a stored memory is both retrieved and actually used** — and because
nothing measures that, "it reduces token consumption" is currently a *bet*, not a
demonstrated fact. It is plausibly net-positive for gotcha-heavy, long-lived projects
with disciplined capture, and plausibly net-negative for short sessions or a sparse /
noisy store.

## 2. Token economics — the honest math

Every mechanism has a **guaranteed cost** and a **conditional benefit**:

| Mechanism | Cost (guaranteed) | Benefit (conditional) |
|---|---|---|
| SessionStart digest | ~200–400 tok **per session**, unconditional (recent-5, relevance-blind) | Re-orients a fresh session without re-reading everything — *if* the recent-5 happen to matter |
| UserPromptSubmit injection | ~0–300 tok **per prompt**, on any lexical match | Surfaces a relevant memory before work — *if* the match is precise and the agent uses it |
| `kodi memory query` (agent-invoked) | tool call + result tokens | Pulls the exact knowledge on demand |
| Capture hooks (PostToolUse) | ~0 to the session (out-of-band write) | Builds the store so future retrieval can hit |

**Break-even.** A single avoided re-investigation (re-grep + re-read 3–5 files +
re-derive) is easily **1,000–5,000 tokens**. One good hit pays for *many* sessions of
digest overhead. So the feature wins **iff**:

```
   (hit_rate × fraction_actually_used × avg_rework_saved)   >   (per_session_digest + Σ per_prompt_injection)
```

Every term on the left is currently **unknown and unmeasured**. Every term on the
right is **paid unconditionally**. That asymmetry is the central risk.

## 3. Does it add context? Yes — and that's the cost, not the win

- SessionStart digest is injected into **every** session regardless of task.
- UserPromptSubmit injects on **every** prompt that lexically matches *anything*, with
  **no relevance threshold** — a weak match is injected the same as a strong one.
- The injections are **title-only**. They advertise knowledge; they don't deliver it.
  To act on an injected line the agent must then run `kodi memory query --json` — an
  **extra tool round-trip** (more tokens), partly defeating the "pre-load the context"
  purpose.

So the honest framing: the feature reliably **adds** context every turn. Whether that
context **replaces** more expensive work is the open question.

## 4. Does it reduce reprocessing? Only under conditions it doesn't yet guarantee

The savings are real **per hit** but gated by three weak links:

1. **Capture is the true bottleneck (garbage-in).** Auto-capture is deterministic but
   narrow — security findings on `kodi pr create` and ticket hand-offs. The
   *high-value* knowledge (decisions, gotchas, architecture) depends on the agent
   **voluntarily** calling `kodi memory store` via the `/remember` rule. Agents
   under-comply with "remember to save." A sparse store → low hit rate → ~no savings,
   while the digest/injection costs are still paid. **Retrieval polish is worthless
   without capture volume.**
2. **Lexical retrieval caps hit rate.** FTS5/BM25 misses paraphrases: if the prompt's
   wording doesn't lexically overlap the stored finding, no hit. Natural-language
   prompts overlap stored text only moderately. Hit rate *is* the ROI, and lexical is
   its ceiling.
3. **No precision gate.** Broad OR-of-tokens + prefix matching favors recall over
   precision, so low-value matches get injected → tokens spent, no rework avoided.

## 5. Active harms (not just missed savings)

- **Stale memories mislead.** A memory that has since become false (code changed, ADR
  reversed) is injected *as fact*. Acting on wrong context costs **more** tokens than
  having no memory (the agent does the wrong thing, then unwinds it). There is
  `amend`/`rm` but **no decay, no verification, no confidence signal**.
- **Context dilution.** Even correct-but-irrelevant injections push the useful signal
  down and consume the context budget.
- **Overlap / duplication.** `CLAUDE.md` already persists durable project instructions;
  `docs/adr` + `docs/prd` already record decisions. Some of what agents might `store`
  belongs there instead. Unmanaged, memory becomes a fourth, lossy copy.

## 6. Steelman — where it genuinely earns its place

- **Cross-session continuity.** After `/clear`, a compaction, or days away, a new
  session starts blind. The digest + `query` give it a running start without
  re-reading the world. This is the clearest real win.
- **Gotchas have outsized ROI.** Recalling one "never call billing without an
  idempotency key" trap prevents both a bug *and* the whole re-derivation — a single
  such hit dwarfs weeks of digest overhead.
- **Low friction / no lock-in.** Zero deps, offline, one SQLite file, per-project
  scoped, CLI-driven. It can't hurt availability and is trivial to disable.
- **Scope isolation works** (verified): projects never leak into each other, so the
  store can't cross-contaminate context.

## 7. Recommendations, ranked (with rationale + rough effort)

1. **Measure it — instrumentation first (S).** Log every injection: what was surfaced,
   at what score, and whether the agent then queried/opened/used it. Add lightweight
   token accounting. *Until this exists, every other tuning is guesswork.* This is the
   single highest-value change: it converts the bet into data and tells us if the rest
   is even needed.
2. **Precision over recall at injection (S–M).** Add a BM25 relevance threshold; skip
   trivial prompts (already partly done); and when there is one high-confidence hit,
   inject its **full content** (not a title) so no follow-up `query` is needed. Fewer,
   better, self-contained injections.
3. **Fix the capture bottleneck (M).** Importance/quality scoring to keep the store
   signal-dense, plus a cheap **Stop-hook nudge** for the agent to store what it
   learned (no ambient LLM — a structured reminder). Recall is capped by capture; this
   raises the cap.
4. **Recency/importance ranking + staleness handling (M).** Blend recency into ranking
   (partly done), add a confidence/last-verified signal, and decay or flag stale
   entries so wrong context stops being injected as fact.
5. **Semantic layer — sqlite-vec + local embeddings (L).** The real ceiling on hit rate
   and therefore on savings. Biggest lever, biggest cost. **Do this only after (1)
   shows lexical hit rate is the binding constraint** — otherwise it's premature.
6. **De-duplicate against CLAUDE.md / docs (S, policy).** Decide what belongs in memory
   vs. CLAUDE.md vs. ADRs, and say so in the `/remember` rule, so memory doesn't become
   a lossy fourth copy.

## 8. Decision

- **Keep the feature** — it is cheap, isolated, off-by-nothing, and has a clear win
  condition (cross-session gotcha/decision recall).
- **Do not invest further in retrieval sophistication (semantic, rerank) yet.**
- **Next step is (1): ship injection/usage instrumentation**, run it on real sessions,
  and let the measured hit-rate and used-rate decide whether (2)–(5) are worth it.
  Everything else in `docs/memory-improvements.md` is gated behind that data.

The feature's worth is **empirical, not architectural** — and right now we haven't
measured it. That measurement is the work that matters.
