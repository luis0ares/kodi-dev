# kodi

**kodi.dev** — a Claude Code-native agent orchestrator. It installs a thin harness
into any project — a `SessionStart` bootstrap, phase skills, and a neutral team of
sub-agents — plus a deterministic CLI that proxies your ticket board and pull
requests. It runs **inside** a Claude Code session (host-driven); there is no
separate engine and no `claude -p` process fleet.

> Status: harness complete (F1–F5). End-to-end validation on a consumer project
> (F6) and npm publish (F7) are pending. See `KODI-DESIGN.md` for the full design.

## Install

```bash
npm install -g kodi        # or: npx kodi <cmd>
cd your-project
kodi init                  # writes the SessionStart hook, phase skills, agents, and docs/ scaffold
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

Provider (`local` / `github` / `azure`) is read from `.claude/kodi/board.yaml`;
auth is inherited from your logged-in `gh`/`az`.

## Develop

```bash
pnpm install
pnpm test          # vitest
pnpm build         # tsup → dist/index.js
pnpm typecheck
```

## License

MIT — see `LICENSE`.
