---
name: remember
description: >-
  Capture a durable finding about THIS project into kodi's cross-session memory via
  `kodi memory store`, and retrieve past findings with `kodi memory query`. Use this
  whenever the user runs /remember, or says things like "remember this", "save this
  finding", "note that for later", "store this decision/gotcha", "what do we already
  know about X", "did we figure out why …", "check the project memory" — anytime a
  learning about the repo should persist across sessions or a past learning should be
  recalled. It is NOT for the user's global preferences (that is Claude's own memory);
  this is project-scoped repository knowledge.
---

# /remember — Persist and recall project knowledge

kodi keeps a lexical, cross-session **memory** for this project (one collection per
repo, stored under `$KODI_HOME`, outside the tree). Turn a learning into a durable
memory, or pull up what was learned before — all through the `kodi memory` CLI.

## Store a finding

Classify it and store it with enough context to be useful months later:

```
kodi memory store --type <type> --content "<finding + why>" [--ticket <KEY>] [--file <path> ...]
```

`--type` is one of:

- `decision` — a choice made and why (a mini-ADR)
- `gotcha` — a trap / bug root-cause to not repeat
- `convention` — a project rule or pattern to follow
- `architecture` — how a subsystem or flow works
- `reference` — a pointer to a doc / URL / resource
- `task-note` — context tied to a specific ticket's implementation

Attribute it: `--ticket` for the task in flight, `--file` for each repo-relative path
it concerns (repeatable, 0..N). Storing the same content twice is a no-op (deduped),
so err toward storing. Prefer the *why* over the *what*, and skip the ephemeral.

## Recall findings

```
kodi memory query "<topic or question>" [--type <t>] [--ticket <KEY>] [--file <path>] [--json]
```

Free-text BM25 search plus filters, scoped to this project; `--json` returns full
records for you to reason over. `kodi memory list` browses newest-first. Query before
working a subsystem — it often saves re-investigating what's already known.

## Curate

Keep the store trustworthy: `kodi memory amend <id> …` to correct a memory,
`kodi memory rm <id>` to drop a stale one. Move knowledge between machines/projects
with `kodi memory export [-f file.yaml] [--type t]` and `kodi memory import <file.yaml>`
(imports dedup into the current project).
