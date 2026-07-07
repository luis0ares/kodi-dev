# kodi

**kodi.dev** — a Claude Code-native agent orchestrator. It installs a thin harness
into any project — a `SessionStart` bootstrap, phase skills, and a neutral team of
sub-agents — plus a deterministic CLI that proxies your ticket board and pull
requests. It runs **inside** a Claude Code session (host-driven).

## Install

No global install needed — run it straight through `npx`:

```bash
cd your-project
npx kodi-dev init     # writes the SessionStart hook, phase skills, agents, and docs/ scaffold
npx kodi-dev tickets list
```

Prefer a global binary?

```bash
npm install -g kodi-dev
kodi init
```

Or build & install from a local clone (no npm registry) — see the `Makefile`:

```bash
make install     # build + install the kodi binary globally from source
```

`kodi init` is idempotent — it merges into an existing `.claude/settings.json`
without clobbering other hooks.

## How it works

- **Bootstrap.** `kodi init` wires a `SessionStart` hook (matchers
  `startup|resume|clear|compact`) to `kodi hook session-start`, which injects the
  orchestrator persona + the two laws (ask-never-assume, ADR-is-law) into every
  session.
- **Three orchestrators, driven by explicit skills** (no auto-advancing pipeline):

  | Phase | Skill | Orchestrator | Output |
  |---|---|---|---|
  | Briefing | `/discover` | main-loop | `briefing.md` + thin `CLAUDE.md` |
  | Planning | `/oplan`, `/oreplan` | main-loop (hub-and-spoke) | phased plan in `docs/plan` |
  | Ticketing | `/tickets` | main-loop | tickets on the board |
  | Build | `/ticket-start` | `build-orchestrator` (sub-agent) | slice → gates → PR |

- **Neutral agents.** Engineers know their *role*, not the stack. The stack lives
  in the thin `CLAUDE.md` and installable **skill-packs** (`kodi add`).

## CLI

All board/PR mutations proxy `gh`/`az` and are **dry-run unless `--yes`**.

```bash
kodi tickets create -t "Title" -s "Summary" --ac "criterion" --dep KODI-001
kodi tickets list-ready              # dependency-aware readiness
kodi tickets set-status KODI-001 Done
kodi pr create --source feat/x --target main -t "Title" -s "Summary" --yes
kodi add ./packs/fastapi-backend     # install a skill-pack
```

Provider (`local` / `github` / `azure`) is read from `.claude/kodi-dev.yaml`;
auth is inherited from your logged-in `gh`/`az`.

## GitHub Projects setup

The `github` provider stores tickets as **repo issues** and drives their status
through a **Projects v2** board's single-select **Status** field (issues are added
to the board as items). `kodi init` discovers the board and columns for you.

**Prerequisites — do these once:**

```bash
gh auth login                                     # authenticate the gh CLI
gh auth refresh -s project --hostname github.com  # grant the Projects scope (NOT in default auth)
```

The board must be a **Projects v2** with a single-select **Status** field (every
built-in board template has one).

**What you supply; what kodi discovers:**

| You provide | kodi discovers |
| --- | --- |
| whether the board is owned by an **org** or a **user** | the project **number** (pick from a list) |
| the **owner login** (user-owned defaults to your login) | the Status field's **columns** (you map To Do / In Progress / To Review / Done) |
| — | the **repository** (pick from the owner's repos; the current repo is offered first) |

> GitHub's built-in board has only `Todo` / `In Progress` / `Done` — no "To Review".
> You can map To Review onto another option, or add an "In Review" column to the board.

**Interactive:** `kodi init --provider github` and answer the prompts.

**Non-interactive:**

```bash
kodi init --provider github \
  --owner-type org --project-owner acme --project-number 5 \
  --repository acme/app \
  --todo-column "Todo" --in-progress-column "In Progress" \
  --to-review-column "In Review" --done-column "Done"
```

## Develop

```bash
pnpm install
pnpm test          # vitest
pnpm build         # tsup → dist/index.js
pnpm typecheck
```

## License

MIT — see `LICENSE`.
