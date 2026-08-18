---
name: retickets
description: >-
  Revise or recreate one or more EXISTING board tickets from a change description —
  impact-analysis first, then apply through the kodi tickets CLI. Use this whenever
  the user runs /retickets, or says things like "change/rework/rewrite ticket
  KODI-014", "the requirements changed, update the tickets", "this ticket is wrong /
  the scope is off", "recreate these tickets", "modify the acceptance criteria", or
  "reconcile the board after replanning a phase that already has tickets (some
  already built)". This is the board-level sibling of /oreplan. It is NOT /tickets
  (generate fresh tickets from the plan), NOT /ticket-start (build a ticket), and NOT
  /oreplan (re-plan a phase in docs/plan) — though /oreplan hands its phase delta TO
  this skill when the phase already has tickets.
---

# /retickets [keys] [change] — Revise existing tickets, impact-first

Revise EXISTING tickets on the active board from a change description. Analyze the
blast radius before you touch anything, apply through the CLI with sign-off, and
never pretend already-built work can be edited away.

- Manage tickets ONLY through the CLI: `kodi tickets get`, `list`, `deps`, `amend`,
  `create`, `delete`, `list-ready`, `set-status`. The CLI validates the template
  and proxies the provider.
- **Plan is law.** If the change contradicts an approved PRD/ADR/security driver,
  STOP and surface it — that needs `/oreplan`, not a ticket edit.
- **Implemented work is immutable history.** You cannot un-build a `Done` ticket by
  editing its text; carry the change in a new follow-up ticket.
- Remote board mutations are dry-run unless `--yes`.

## Flow (analysis first, apply last)

1. **Resolve targets + change.** Identify the ticket key(s) and the change. If none
   given, help locate them from `kodi tickets list`.

2. **Read current state — including status.** `kodi tickets get <key>` for each
   target (note its status: `Pending | In progress | To review | Done`); `kodi
   tickets list --json` for the whole board (dependency graph + every affected
   ticket's status); read the plan drivers in `docs/plan` (PRD / ADR / security) the
   targets trace to.

3. **Impact analysis — the centerpiece.** Produce a report with these five sections:
   - **Blast radius** — upstream deps the target relies on and downstream tickets
     that depend on it (`kodi tickets deps` / the graph), plus tickets sharing the
     same drivers or acceptance surface that would go inconsistent.
   - **Status reconciliation** — partition every affected ticket by status; a
     ticket's text is not the source of truth once code exists:
     - `Pending` — safe to amend / re-wire / delete.
     - `In progress` / `To review` — live on a branch/PR. Do NOT silently rewrite;
       the change may force rework of an active slice. Surface it to the human (it
       re-enters via `/ticket-start`).
     - `Done` — already shipped. The change becomes a **new follow-up ticket**
       (modify / revert / extend), never an edit or delete of the closed ticket,
       which stays as the record of what was built.
   - **Plan alignment** — does the change agree with the PRD/ADR/security drivers? If
     it contradicts an approved ADR or PRD scope, STOP and surface — likely `/oreplan`.
   - **Tradeoffs** — gains vs. costs: scope, sequencing/dependency order,
     test/coverage impact, non-goals crossed, security.
   - **New tickets required?** — net-new work that doesn't fit existing tickets,
     including follow-up tickets for any change landing on `Done`/in-flight work.

4. **Size gate → recommend `/oreplan` when the change is big.** If the change
   invalidates a phase's foundation (ADR/PRD/scope) OR would cascade across many
   tickets, recommend the user run `/oreplan` for the phase instead of hand-revising
   many tickets — replanning regenerates a coherent phase, which is safer than N
   manual edits. Apply directly only when the change is localized to the target(s).

   **The `/oreplan` round-trip.** When coming *from* `/oreplan` (a phase that already
   has tickets was replanned), this skill is the reconciler: diff the new phase plan
   against the board, then apply the delta through step 3's status reconciliation —
   adjust `Pending` tickets to match, flag `In progress`/`To review` tickets whose
   basis changed, emit follow-up tickets for `Done` work the new plan would have done
   differently. Never rewrite implemented tickets to make the board "look like" the
   new plan; only new/pending tickets carry the delta.

5. **Show the delta, get sign-off.** Tickets are human-approved artifacts — present
   the before→after diff and the impact report and get explicit sign-off before
   mutating. Mutations stay dry-run unless `--yes`.

6. **Apply through the CLI — gated by status.** `kodi tickets amend` (summary / ac /
   deps / notes) and `delete` for `Pending` tickets only; `kodi tickets deps --add`
   to re-wire dependencies; `kodi tickets create` for approved net-new and follow-up
   tickets (the vehicle for anything touching `Done`/in-flight work). Keep each
   ticket tracing to its drivers. Then re-check `kodi tickets list-ready` so the
   order reflects the new reality.
