# kodi

**kodi.dev** — a Claude Code-native agent orchestrator. It installs a thin harness into
any project — a `SessionStart` bootstrap, phase skills, and a neutral team of sub-agents —
plus a deterministic CLI that proxies your **ticket board** and **pull requests**. It runs
**inside** a Claude Code session: you drive the phases, the agents do the work, and the CLI
is the only thing that touches your board or opens a PR.

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
- configures your **board provider** and **docs backend**, and writes
  `.claude/kodi-dev.yaml` — every field it can write, and every field it can't, is listed in
  full in [Configuration reference](#configuration-reference-kodi-devyaml) below.

It is **idempotent** — it merges into an existing `.claude/settings.json` without
clobbering other hooks, so it is safe to re-run.

### Choose a board provider

kodi tracks work on a board and drives ticket status through it. Pick one at init:

| Provider     | Where tickets live                                   | Status is driven by                                  |
| ------------ | ----------------------------------------------------- | ----------------------------------------------------- |
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

### Docs backend

Independent of the board provider, `kodi init` also asks where **documentation artifacts**
(PRDs, ADRs, security, plans, diagrams — see [`kodi docs`](#docs)) should live: the local
`docs/` folder, or an **Azure DevOps Wiki**. Choosing the wiki reuses the org/project
already configured for an `azure` board (no re-prompt); otherwise it asks once. `kodi init`
verifies the Wiki feature is enabled for the project and creates the wiki
(`<project>.wiki`) if it doesn't exist yet — it never guesses past a real failure: if the
feature itself is disabled, it tells you to enable it in **Project Settings → Overview →
Features** and stops. Switch backends later (and copy every doc across, preserving ids)
with `kodi docs migrate --to <local|azure-wiki> --yes`.

---

## Configuration reference (`kodi-dev.yaml`)

Everything kodi knows about a project lives in one file, `.claude/kodi-dev.yaml`. Some of
it is written for you by the `kodi init` wizard; the rest is intentionally **not**
prompted for — it exists for cases the common path doesn't need, and you set it by hand
editing the YAML.

### Set by `kodi init`

| Field | Meaning | Set for |
| --- | --- | --- |
| `provider` | Board provider: `local` \| `github` \| `azure` | always |
| `prefix` | Local ticket key prefix (default `KODI`) | `local` |
| `organization` | Azure DevOps org URL | `azure` board, or an `azure-wiki` docs backend when the board isn't `azure` |
| `project` | Azure DevOps project name | `azure` board, or an `azure-wiki` docs backend when the board isn't `azure` |
| `team` | Azure team that owns the board | `azure` |
| `board` | Azure board name (e.g. `Issues`) | `azure` |
| `columnStates` | Chosen column name → work-item state, discovered from the real board | `azure` |
| `repository` | Repo for PRs/issues (Azure: bare name; GitHub: `owner/repo`) | `azure`, `github` |
| `projectOwner` | GitHub Projects v2 owner login (org or user) | `github` |
| `projectNumber` | GitHub Projects v2 board number | `github` |
| `columns` | Status → column map (`todo`/`inProgress`/`toReview`/`done`) | `github`, `azure` |
| `prTarget` | Default target branch for `kodi pr create`, chosen from the remote's real branches | `github`, `azure` |
| `docsProvider` | Docs backend: `local` \| `azure-wiki` | always (a separate prompt from the board provider) |
| `docsWiki` | Azure wiki name (default `<project>.wiki`) | `azure-wiki` docs |
| `docsTypes` | The project's registered doc types | always — seeded with `[prd, adr, security, plan, diagrams]`; edit the list afterward with `kodi docs types add/remove` (not re-prompted by `init`) |

### Additional configuration (not set by `kodi init`)

These exist for cases the wizard deliberately doesn't ask about — there's no sensible
default to prompt for, so they're opt-in, hand-edited fields:

| Field | Meaning | Default when unset |
| --- | --- | --- |
| `worktreesDir` | Where `kodi tickets start --worktree` creates worktrees, relative to the project root | `.claude/worktrees` |
| `sourceBranch` | The branch `kodi tickets start` bases a **new** `slice/kodi-<id>` branch (or worktree) on. Ignored when the slice branch already exists — reusing one keeps its own base. | the current active branch (default git behavior) |

Example — a project on the `azure` board provider, local docs, with both additional fields set:

```yaml
provider: azure
prefix: KODI
organization: https://dev.azure.com/acme
project: MyProject
team: MyProject Team
board: Issues
columns:
  todo: To Do
  inProgress: Doing
  toReview: To Review
  done: Done
columnStates:
  To Do: To Do
  Doing: Doing
  To Review: Doing
  Done: Done
repository: MyProject
prTarget: main
docsProvider: local
docsTypes: [prd, adr, security, plan, diagrams]
worktreesDir: .claude/worktrees   # optional — this is the default anyway
sourceBranch: develop             # optional — every new slice branches from develop
```

---

## How it works

kodi runs three explicit phases — **no auto-advancing pipeline** — each triggered by a
skill and coordinated by an orchestrator. Every hand-off is a durable artifact, so a phase
can be re-run or resumed after a `/clear` or `/compact`.

| Phase       | Skill(s)             | Orchestrator                     | Output                             |
| ----------- | -------------------- | -------------------------------- | ----------------------------------- |
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

Every command also checks — at most once a day, capped at 1.5s, never on the critical
path — whether a newer kodi is published on npm, and installs it directly
(`npm install -g kodi-dev@latest`) rather than just telling you to. Set
`KODI_NO_AUTO_UPDATE=1` to opt out (CI is skipped automatically).

### Tickets

```bash
kodi tickets create -t "Title" -s "Summary" --ac "criterion" --dep KODI-001
kodi tickets list                    # open tickets (Done is not fetched)
kodi tickets list --all              # …including the Done column
kodi tickets list-ready              # dependency-aware readiness (+ the blocked set)
kodi tickets get KODI-001            # any ticket, Done or not
kodi tickets deps KODI-001 --add KODI-002   # read or declare dependencies
kodi tickets set-status KODI-001 Done
kodi tickets amend KODI-001 --file patch.yaml
kodi tickets start KODI-001 --yes             # → In progress, assigns you, cuts slice/kodi-KODI-001
kodi tickets start KODI-001 --worktree --yes  # …or an isolated worktree instead
kodi tickets start KODI-002 --no-branch --yes # bundling onto a branch another `start` already cut
kodi tickets hand-off KODI-001 --pr <url>     # end of slice: → To Review, link the PR
kodi tickets iterations                       # list every iteration/sprint (azure/github only)
kodi tickets list --iteration "Sprint 12"     # one specific iteration instead of the current one
kodi tickets list --all-iterations            # disable iteration filtering — every ticket, every sprint
kodi tickets create ... --iteration "Sprint 12" --yes   # assign to an iteration on create
kodi tickets amend KODI-001 --iteration "Sprint 12" --yes   # …or after the fact
```

`start` always cuts (or reuses) a `slice/kodi-<id>` git branch, based on the current
active branch — or, if `sourceBranch` is set in `kodi-dev.yaml`, on that fixed ref every
time, regardless of what's currently checked out (see [Configuration
reference](#configuration-reference-kodi-devyaml)). With `--worktree` it creates that
branch as a separate worktree instead of switching the current checkout — under
`.claude/worktrees/` by default, overridable per-project via `worktreesDir`.
`--no-branch` skips branch/worktree creation entirely, for bundling several tickets onto
one branch (`--worktree` and `--no-branch` together are rejected).

Every ticket is validated against a strict template before it is written or sent to the
provider.

**Listings stop at the Done column.** Done is the one column that only grows, and nothing
that reads a listing renders it — `tree` drops Done nodes, and a dependency that has left
the listing is treated as satisfied rather than re-fetched to prove it. So `list`, `tree`
and `list-ready` pull open work only: on Azure the Done filter is applied inside the WIQL,
so finished descriptions never cross the wire; on GitHub, Done items are dropped before
their bodies are read, which is where the per-issue API calls (and the narrower rate
limit) bite. Done tickets are fetched on demand with `tickets list --all`, or individually
with `tickets get <key>`, which never filters. The trade-off: a dependency key that
matches nothing now reads as satisfied instead of blocking forever — `create` and `amend`
warn about unknown keys at write time, confirming each one with a targeted lookup so a
dependency on finished work stays silent.

**Iterations/sprints — `azure` and `github` only** (`local` has no such concept and
rejects `--iteration`/`iterations` with a clear error). `list` defaults to the **current**
iteration plus anything not yet scheduled into any sprint; `--iteration <name>` views one
specific (e.g. past) iteration instead, and `--all-iterations` disables the filter
entirely. `kodi tickets iterations` lists every iteration with its dates and marks the
current one. Assigning a ticket to an iteration is a separate, board-native step — via
`--iteration` on `create`/`amend` — never part of the portable ticket record itself, the
same way `status` is always trusted from the board rather than a stored copy.

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

Every PR follows a **strict template validated in code** (summary, type of change,
included changes → features/fixes/improvements, related issues / work items, testing,
and a checklist). Every section is always rendered — only notes is optional — so the
created PR never collapses to a bare summary. Bodies are portable and capped so no
provider truncates them.

```bash
kodi pr create --source feat/x --target main -t "Title" -s "Summary" --yes
kodi pr list
kodi pr abandon <id>
```

### Docs

`kodi docs` manages documentation artifacts — PRDs, ADRs, security docs, plans, diagrams,
or any other type your project registers — either as local files under `docs/` or as pages
on an **Azure DevOps Wiki** (`kodi init` asks which; see [Docs backend](#docs-backend)).
Every doc carries a small YAML frontmatter block (Claude skill/agent-frontmatter style):
`name`, `description` and `type` are required on every doc; anything else is free-form per
type and never validated by kodi. Doc types are **not** hardcoded — they live in
`kodi-dev.yaml`'s `docsTypes` list, editable with `kodi docs types`.

```bash
kodi docs types list                          # the project's registered doc types
kodi docs types add mockup                    # register a new type
kodi docs create prd --name "Document Handling" --description "In-platform viewer" \
  --file draft.md --yes                       # -> PRD-0001 (auto-numbered, per type)
kodi docs list prd                            # or `kodi docs list` for every type
kodi docs get PRD-0001                        # prints the full doc (frontmatter + body)
kodi docs delete PRD-0001 --yes
kodi docs reindex --yes                       # regenerate the index (see below)
kodi docs migrate --to azure-wiki --yes       # copy every doc onto another backend,
                                               #   preserving ids, and switch to it
```

The docs backend also maintains a **book-style index** — a page (the wiki's `/Index`, or
`docs/README.md` locally) grouping every doc by type with a link and its one-line
description, regenerated automatically after `create`/`delete`/`migrate`.

### Skill-packs

```bash
kodi add ./packs/fastapi-backend    # install a skill-pack (skills + CLAUDE.md fragment)
```

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
