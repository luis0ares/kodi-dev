# Rule: project memory (kodi)

kodi keeps a **cross-session memory** for this project — a lexical knowledge store the
whole team of agents reads and writes through the `kodi memory` CLI. What you learn
about this repo should outlive the session, so the next agent doesn't re-derive it.
Every memory is linked to source file(s) and carries a **veracity score 0–5**: trust is
*earned by surviving changes* to those files and *lost by being refuted*.

**Query before you work.** Before diving into a subsystem, a bug, or a decision, run
`kodi memory query "<topic>" --json` (optionally `--type` / `--ticket` / `--file`). It's
cheap and often saves a full re-investigation.

**Store a finding as soon as it's worth remembering** — a non-obvious decision + its
rationale, a gotcha / bug root-cause, a convention, how a subsystem works, a reference,
or context tied to the ticket in flight. **At least one `--file` is required** (it's what
the finding is verified against):

```
kodi memory store --type <decision|gotcha|convention|architecture|reference|task-note> \
  --content "<the finding, with enough context to be useful months later>" \
  --file <repo-relative-path> [--file <path> …] [--ticket <KEY>]
```

Keep the store valuable, not noisy:

- **Store the durable, not the ephemeral;** include the *why*, not just the *what*.
- **Every memory needs its file(s)** — the path(s) the finding is about.
- Storing the same finding twice is a **no-op** (deduped); a previously-refuted finding
  is **blocked** (the re-learn guard) — so err toward storing.

## Verify what you rely on (the trust loop)

A memory injected into your context, or one you pull up with `query`, may be marked
`⚠reverify` (its file changed since it was last checked). When you use or encounter such
a memory — and always before trusting a `⚠reverify` one:

1. Read its linked file(s).
2. Decide if the finding **still holds**.
3. Record it:
   - still true → `kodi memory verify <id> --pass` (raises its score)
   - no longer true → `kodi memory verify <id> --fail --reason "<what changed>"`
     (tombstones it so it stops being surfaced and can't be silently re-learned)

Also: when you **edit a file** that memories are linked to, they're auto-flagged
`⚠reverify`; re-verify the ones you can as above. **Memories are effectively immutable**
— to correct one, `verify --fail` it and `store` the corrected finding (or `amend`,
which resets its score to unverified). The store is machine-global (`$KODI_HOME`, default
`~/.kodi`), partitioned per project, so memories never leak between repos.
