# `kodi memory` — veracity score (design, grilled)

> Status: design / awaiting sign-off · 2026-07-12
> Outcome of a full grilling session. Adds a self-correcting **trust loop** to the
> memory feature so stored findings are verified against reality over time instead of
> being trusted blindly. Directly targets the "stale memories mislead" harm named in
> `docs/memory-critique.md`, informed by the prior art in
> `docs/chatidev-memory-investigation.md`.
>
> **This is a v2 of the memory model — it changes several shipped decisions.** Build
> only after sign-off.

## The idea in one paragraph

Every memory is linked to ≥1 source file and carries an integer **score 0–5**. A fresh
memory starts at **3** (trustworthy but unverified). When a linked file changes, the
memory is cheaply flagged `needs-reverify`; the in-session agent then re-judges the
finding against the current file(s) and either **confirms it (score +1)** or **refutes
it (tombstone)**. So the score measures *how many real changes a finding has survived*
— robustness, not popularity. Injection is score-gated, so only battle-tested findings
are force-fed into context.

## Resolved decisions (the grill)

| # | Decision |
|---|---|
| Q1 | **Who verifies:** the in-session agent (already Claude, already has the files) does the *judgment*, **gated by a per-file SHA-256** — unchanged files are never re-judged. No new process, no new dep. |
| Q2 | **File-edit trigger:** a PostToolUse **Write/Edit** hook is deterministic + cheap — on a matching path it flags every memory referencing that file `needs-reverify`, caps its score at 2, and re-stamps the file hash. No LLM in the hook; re-judgment is deferred to the agent. (Reverses the earlier "no Write-matcher" call — now justified.) |
| Q3 | **Initial score:** a fresh store starts at **3** (trust the agent's claim; `calibration=unverified`). Its first change-triggered verify moves it to 4/5 or tombstones it. |
| Q4 | **Editability:** keep `kodi memory amend`, but **any amend resets the score to 3 + `needs-reverify` + re-stamps hashes** — edited content is a new claim the old verifications no longer vouch for. |
| Q5 | **Files required:** `kodi memory store` **rejects a memory with no `--file`.** Every memory is scorable/verifiable. |
| Q6 | **Refutation:** `verify --fail` **tombstones** (status + reason + timestamp, out of query/inject) and registers a **re-learn guard** (echo-check on future stores) so a disproven claim can't be silently re-learned. Not a hard delete. |
| Q7 | **Multi-file:** store a SHA-256 **per file**; **any** file changing flips `needs-reverify`; verify judges the finding against **all** its files and, on pass, re-stamps every hash. |
| Q8 | **Score semantics:** score rises **only** when a linked file changed and the memory still held (**+1 per survived change**, cap 5). Score = "survived N edits to its files." A stable memory rests at 3 (still usable); only change-tested findings reach 4–5. |

## Injection bands (score-gated)

- **4–5** — auto-inject (SessionStart digest + UserPromptSubmit), as trusted fact.
- **3** — inject only on strong relevance (BM25 threshold), otherwise on-demand.
- **1–2** — query-only; never auto-injected (includes `needs-reverify` demotions).
- **0 / tombstoned** — never surfaced (kept for the re-learn guard).

## Schema additions (`memories`)

- `score INTEGER NOT NULL DEFAULT 3` (0–5)
- `status TEXT NOT NULL DEFAULT 'active'` (`active` | `tombstoned`)
- `needs_reverify INTEGER NOT NULL DEFAULT 0`
- `file_hashes TEXT` — JSON `{ "<repo-rel path>": "<sha256>" }` for every linked file
- `verified_at TEXT` · `tombstone_reason TEXT`
- Files become **NOT NULL / non-empty** at the template layer (`MemoryDraftSchema`).
- Existing rows are legacy: grandfathered as `score=NULL` (exempt) — the loop applies
  to new file-linked memories only. (Migration note below.)

## CLI changes

- `kodi memory store` — now **requires ≥1 `--file`**; sets `score=3`, hashes each file.
- `kodi memory verify <id> --pass | --fail [--reason <text>]` — the agent's hook back
  in: `--pass` → +1 (cap 5), clear `needs-reverify`, re-stamp hashes, `verified_at`;
  `--fail` → tombstone + reason + re-learn-guard entry.
- `kodi memory list|query` — show `score`/`status`; exclude tombstoned by default;
  gate results by band where relevant.
- `kodi memory amend` — kept, but resets score to 3 + `needs-reverify` + re-hash.

## Hooks

- **PostToolUse (matcher `Write|Edit|Bash`)** — extend the existing capture hook:
  on a Write/Edit whose path matches a memory's `file_hashes`, flag `needs-reverify`,
  cap score at 2, re-stamp that file's hash. (Bash branch keeps today's deterministic
  capture.) Cheap, deterministic, no LLM.
- **SessionStart / UserPromptSubmit** — band-gated injection (above); at SessionStart
  also run the cheap **out-of-band hash check** (catch a `git pull`/branch switch the
  Write hook didn't see) and demote changed memories to `needs-reverify`.
- **The verify protocol lives in the `memory` rule:** when a `needs-reverify` memory is
  surfaced (or the agent edits a file that has memories), the rule instructs the agent
  to read the file(s), judge if the finding still holds, and run `kodi memory verify`.

## Open implementation notes (not blockers, but decisions during build)

1. **Auto-capture vs files-required.** Security-finding capture already carries a report
   path (`docs/security/…`) — attach it as the file. Ticket **hand-off** capture has no
   natural file → drop it (it was low-value anyway) or attach the ticket's touched
   files if known.
2. **Deleted file.** A linked file that no longer exists → can't verify → tombstone with
   reason `file-removed`.
3. **Migration.** Legacy no-file / unscored memories stay as-is (`score=NULL`, exempt);
   optionally a one-shot `kodi memory backfill` to hash + score those that do have files.
4. **Cost honesty (per the critique).** This adds real machinery and per-edit hook work.
   Its worth is still empirical — the instrumentation recommendation from
   `docs/memory-critique.md` (log injected-vs-used, verify pass/fail rates) should ship
   alongside so we can tell if the trust loop actually improves outcomes.

## Net

This converts the store from "trust every memory equally forever" into a self-correcting
set where trust is *earned by surviving change* and *lost by being refuted* — with no new
runtime dependency and no LLM in any hook (all judgment stays in the agent's own turn).
