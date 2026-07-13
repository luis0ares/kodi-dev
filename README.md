# kodi

**kodi.dev** — a Claude Code-native agent orchestrator. It installs a thin harness into
any project — a `SessionStart` bootstrap, phase skills, and a neutral team of sub-agents —
plus a deterministic CLI that proxies your **ticket board** and **pull requests**. It runs
**inside** a Claude Code session: you drive the phases, the agents do the work, and the CLI
is the only thing that touches your board or opens a PR.

> [!NOTE]
> New in **1.2.0** — a per-project **memory knowledge database**. See
> [Memory (1.2.0)](#memory-120).

---

## Quick start

No global install needed — run it through `npx`:

```bash
cd your-project
npx kodi-dev init          # required once per project (see below)
npx kodi-dev tickets list
```

Prefer a global binary?

```bash
npm install -g kodi-dev
kodi init
```

Or build & install from a local clone (no npm registry) — see the `Makefile`:

```bash
make install               # build + install the kodi binary globally from source
```

---

## `kodi init` — required in every project

`kodi init` is the one command you must run before anything else. It:

- wires a **`SessionStart` hook** (matchers `startup | resume | clear | compact`) to
  `kodi hook session-start`, which injects the orchestrator persona + the two laws
  (ask-never-assume, ADR-is-law) into every session;
- installs the **phase skills** (`/discover`, `/oplan`, `/tickets`, `/ticket-start`, …),
  the **sub-agents**, and a `docs/` scaffold;
- configures your **board provider** and writes `.claude/kodi-dev.yaml`.

It is **idempotent** — it merges into an existing `.claude/settings.json` without
clobbering other hooks, so it is safe to re-run.

### Choose a board provider

kodi tracks work on a board and drives ticket status through it. Pick one at init:

| Provider     | Where tickets live                                   | Status is driven by                                  |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| **`local`**  | one file per ticket under **`docs/tickets/`**        | a local status index — no external service           |
| **`github`** | repo **issues**, added to a **Projects v2** board    | the board's single-select **Status** field           |
| **`azure`**  | Azure DevOps **work items** on a **basic board**     | the board columns                                     |

Auth is inherited from your already-logged-in `gh` / `az` CLIs — kodi never stores
credentials.

#### Local

Nothing to authenticate. Tickets are plain files under `docs/tickets/`, so the whole
backlog is visible in your repo and versioned with your code. Browse it visually with the
**read-only board app** (see [The local board](#the-local-board)).

#### GitHub Projects

The `github` provider stores tickets as repo issues and drives their status through a
**Projects v2** board's single-select **Status** field. Do this once:

```bash
gh auth login                                     # authenticate the gh CLI
gh auth refresh -s project --hostname github.com  # grant the Projects scope (NOT in default auth)
```

`kodi init` discovers the rest for you:

| You provide                                             | kodi discovers                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| whether the board is owned by an **org** or a **user**  | the project **number** (pick from a list)                              |
| the **owner login** (user-owned defaults to your login) | the Status field's **columns** (map To Do / In Progress / To Review / Done) |
| —                                                       | the **repository** (the current repo is offered first)                 |

> [!NOTE]
> GitHub's built-in board has only `Todo` / `In Progress` / `Done` — no "To Review". Map
> To Review onto another option, or add an "In Review" column to the board.

Interactive: `kodi init --provider github` and answer the prompts. Non-interactive:

```bash
kodi init --provider github \
  --owner-type org --project-owner acme --project-number 5 \
  --repository acme/app \
  --todo-column "Todo" --in-progress-column "In Progress" \
  --to-review-column "In Review" --done-column "Done"
```

#### Azure DevOps

The `azure` provider stores tickets as work items on a **basic board**. `kodi init` lists
the real board columns and maps them to kodi's states; auth is inherited from `az login`.

---

## How it works

kodi runs three explicit phases — **no auto-advancing pipeline** — each triggered by a
skill and coordinated by an orchestrator. Every hand-off is a durable artifact, so a phase
can be re-run or resumed after a `/clear` or `/compact`.

| Phase       | Skill(s)             | Orchestrator                     | Output                             |
| ----------- | -------------------- | -------------------------------- | ---------------------------------- |
| Briefing    | `/discover`          | main-loop                        | `briefing.md` + thin `CLAUDE.md`   |
| Planning    | `/oplan`, `/oreplan` | main-loop (hub-and-spoke)        | phased plan in `docs/plan`         |
| Ticketing   | `/tickets`, `/retickets` | main-loop → CLI              | tickets on the board               |
| Build       | `/ticket-start`      | `build-orchestrator` (sub-agent) | vertical slice → gates → PR        |

Engineers know their **role**, not your stack — the stack lives in the thin `CLAUDE.md`
and in installable **skill-packs** (`kodi add`).

> [!TIP]
> For the full agent roster, per-phase diagrams, and how the agents communicate, see
> **[docs/agents.md](docs/agents.md)**.

---

## CLI reference

All board/PR mutations proxy `gh` / `az` and are **dry-run unless you pass `--yes`**. The
provider is read from `.claude/kodi-dev.yaml`.

### Tickets

```bash
kodi tickets create -t "Title" -s "Summary" --ac "criterion" --dep KODI-001
kodi tickets list                    # all tickets
kodi tickets list-ready              # dependency-aware readiness (+ the blocked set)
kodi tickets get KODI-001
kodi tickets deps KODI-001 --add KODI-002   # read or declare dependencies
kodi tickets set-status KODI-001 Done
kodi tickets amend KODI-001 --file patch.yaml
kodi tickets hand-off KODI-001 --pr <url>   # end of slice: → To Review, link the PR
```

Every ticket is validated against a strict template before it is written or sent to the
provider.

### The local board

With the `local` provider, tickets are separate files under `docs/tickets/`. Browse them
in a **read-only board application** built for navigating tickets and their dependencies:

```bash
kodi tickets serve      # launch the board UI in your browser
kodi tickets open       # alias of serve
kodi tickets serve --port 4000
```

It is intentionally read-only — a fast way to *see* the backlog and its dependency graph,
not to edit it. Mutations always go through the CLI.

### Pull requests

Every PR follows a **strict template validated in code** (title, summary, included
changes, features/fixes/improvements, surfaced vulnerabilities, related issues,
reviewers). Bodies are portable and capped so no provider truncates them.

```bash
kodi pr create --source feat/x --target main -t "Title" -s "Summary" --yes
kodi pr list
kodi pr abandon <id>
```

### Skill-packs

```bash
kodi add ./packs/fastapi-backend    # install a skill-pack (skills + CLAUDE.md fragment)
```

### Memory (1.2.0)

`kodi init` gives every project a **cross-session memory knowledge database** — a lexical
(BM25 full-text) store the whole team of agents reads and writes, so learnings about the
repo outlive the session instead of being re-derived. It lives outside your tree
(`$KODI_HOME`, default `~/.kodi`), partitioned per project, so memories never leak between
repos.

Each memory is linked to source **file(s)** and carries a **veracity score (0–5)**: trust
is *earned by surviving changes* to those files and *lost by being refuted*. When a linked
file changes, its memories are auto-flagged `⚠reverify`; the next agent to rely on one
reads the file, then records the outcome — a self-correcting trust loop.

```bash
kodi memory store --type decision --content "why X, not Y" --file src/foo.ts --ticket KODI-014
kodi memory query "auth flow" --json          # search, scoped to this project
kodi memory list                              # browse recent memories
kodi memory verify <id> --pass                # still true → raise the score
kodi memory verify <id> --fail --reason "…"   # refuted → tombstone it
kodi memory export --type decision            # / import <path>
```

From inside a session, the **`/remember`** skill wraps the same store — "remember this",
"what do we already know about X".

---

## Everyday flow

```bash
kodi init                    # once per project — wires the harness + board
# in a Claude Code session:
/discover                    # → briefing.md + thin CLAUDE.md
/oplan                       # → phased plan in docs/plan
/tickets                     # → tickets on the board
/ticket-start KODI-001       # → build one slice, gates, PR to To Review
```
