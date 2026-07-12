# Rule: project memory (kodi)

kodi keeps a **cross-session memory** for this project — a lexical knowledge store the
whole team of agents reads and writes through the `kodi memory` CLI. Its point is that
what you learn about this repo should outlive the session, so the next agent doesn't
re-derive it. The SessionStart hook already surfaces a short digest of recent
memories; these rules cover when to add to it and when to consult it.

**Query before you work.** Before diving into a subsystem, a bug, or a decision,
run `kodi memory query "<topic>" --json` (optionally `--type` / `--ticket` / `--file`)
to see what was already learned. It is cheap and often saves a full re-investigation.

**Store a finding as soon as it is worth remembering** — a non-obvious decision and
its rationale, a gotcha / bug root-cause, a convention, how a subsystem works, a
useful reference, or context tied to the ticket in flight:

```
kodi memory store --type <decision|gotcha|convention|architecture|reference|task-note> \
  --content "<the finding, with enough context to be useful months later>" \
  [--ticket <KEY>] [--file <repo-relative-path> ...]
```

Guidance that keeps the store valuable rather than noisy:

- **Store the durable, not the ephemeral.** Capture what a future agent would want to
  know; skip transient state, TODOs already on the board, or things obvious from the
  code.
- **Write self-contained content.** The `--content` is the searchable body — include
  the *why*, not just the *what*, so it stands on its own out of context.
- **Attribute it.** Pass `--ticket` when a task is in flight and `--file` for each
  repo-relative path the finding concerns (0..N).
- **It is idempotent.** Storing the same finding twice is a no-op (deduped by content),
  so err toward storing.
- **Fix stale knowledge** with `kodi memory amend <id>` or `kodi memory rm <id>` when a
  memory becomes wrong or outdated — don't let the store rot.

The store is machine-global (under `$KODI_HOME`, default `~/.kodi`) and partitioned per
project, so memories never leak between repos and never live inside the project tree.
