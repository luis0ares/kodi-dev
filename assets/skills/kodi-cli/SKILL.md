---
name: kodi-cli
description: >-
  How to drive the kodi CLI to create and manage board tickets and pull requests
  across the active provider (local / GitHub / Azure DevOps). Use this whenever you
  need to create, list, update, or transition a ticket/issue/work item, or to open,
  edit, list, or abandon a pull request — anytime the task involves the board or a
  PR. kodi is the ONLY sanctioned path: raw `gh pr`, `gh issue`, `gh project`,
  `az repos pr`, and `az boards` are denied, so route every board/PR action through
  `kodi`.
---

# kodi CLI — tickets & pull requests

`kodi` proxies the board provider (local / GitHub / Azure DevOps) behind a
**validated template**. The provider is read from `.claude/kodi-dev.yaml` (written
by `kodi init`); you rarely pass it explicitly.

## Golden rules

- **Always go through `kodi`.** The raw `gh pr` / `gh issue` / `gh project` /
  `az repos pr` / `az boards` commands are denied by the project permissions. Use
  the `kodi` equivalents below.
- **Remote mutations are dry-run by default.** Every create/update/delete prints the
  exact provider command and does nothing until you add `--yes`. Preview first, then
  re-run with `--yes` to execute.
- **Templates are enforced by the CLI (Zod).** A draft that misses a required
  section is rejected with a section-by-section error — fix it and retry; never try
  to bypass the template.
- **`--json`** is available on most read/mutation commands for machine-readable output.

---

## Tickets — `kodi tickets`

The ticket template requires a **title** (≥3 chars), a **summary**, and **at least
one acceptance criterion**. Statuses: `Pending` | `In progress` | `To review` | `Done`.

### Create

```bash
kodi tickets create \
  -t "Add CSV dataset import" \
  -s "Users can import a dataset from a CSV file." \
  --ac "CSV upload works" \
  --ac "Rows are validated" \
  --non-goal "No XLSX support" \
  --dep KODI-001 \
  --prd docs/prd/0001 \
  --adr docs/adr/0002 \
  --security docs/security/KODI-014-sqli-login.md \
  --yes
```

- `--ac` / `--non-goal` / `--dep` / `--adr` are **repeatable**.
- Drivers: `--prd`, `--adr` (repeatable), `--security` — trace each ticket to what
  drives it.
- Alternatively pass a full JSON draft with `-f/--file <path>` (validated the same way).
- `--iteration <name>` assigns it to an iteration/sprint (azure/github only — see
  *Iterations / sprints* below). Skipped in a dry-run preview (nothing to assign yet).

### Inspect & order

```bash
kodi tickets list                 # all tickets
kodi tickets list-ready           # tickets with no unmet dependency (+ the blocked set)
kodi tickets tree                 # dependency tree of every not-done ticket, with status
kodi tickets get KODI-003         # show one ticket
kodi tickets next-id              # compute the next ticket key
kodi tickets deps KODI-003        # read dependencies
kodi tickets deps KODI-003 --add KODI-001 --add KODI-002 --yes   # declare deps
```

### Transition & edit

```bash
kodi tickets set-status KODI-003 "In progress" --yes
kodi tickets start KODI-003 --yes             # → In progress, assigns you, cuts slice/kodi-KODI-003
kodi tickets start KODI-003 --worktree --yes  # …or an isolated worktree instead
kodi tickets start KODI-004 --no-branch --yes # bundling onto a branch another `start` already cut
kodi tickets amend KODI-003 -s "New summary" --ac "New AC" --notes "…" --yes
kodi tickets link-pr KODI-003 <pr-url-or-id> --yes
kodi tickets hand-off KODI-003 --pr <pr-url-or-id> --yes     # → To review, links the PR
kodi tickets delete KODI-003 --yes
```

- `start` always cuts (or reuses) a `slice/kodi-<id>` branch — pass that name to
  `kodi pr create --source`. New branches base off the current active branch,
  unless `sourceBranch` is set in `kodi-dev.yaml`, in which case they always
  base off that ref instead. With `--worktree` it creates the branch as an
  isolated worktree instead, at `.claude/worktrees/slice-kodi-<id>` (the `/` is
  flattened to `-` in the directory name only, so worktrees don't all nest under
  one shared `slice/` folder; override the directory with `worktreesDir` in
  `kodi-dev.yaml`), leaving the current checkout untouched. `--no-branch` skips
  branch/worktree creation entirely — use it when
  bundling several tickets onto one branch: only the first `start` in the batch
  omits it. `--worktree` and `--no-branch` are mutually exclusive (rejected).

> Never move a ticket to `Done` yourself — that is the human's call on merge.

### Iterations / sprints — azure/github only

```bash
kodi tickets iterations                     # every iteration, dates, current one marked
kodi tickets list                           # default: current iteration + unscheduled tickets
kodi tickets list --iteration "Sprint 12"   # one specific iteration instead
kodi tickets list --all-iterations          # disable the filter — every ticket, every sprint
kodi tickets amend KODI-003 --iteration "Sprint 12" --yes   # assign after the fact
```

- **`local` has no iteration concept** — `kodi tickets iterations` and any
  `--iteration`/`--all-iterations` flag error clearly (`the local provider does not
  support iterations/sprints`) rather than silently doing nothing.
- The default (unflagged) listing degrades gracefully — no error, no filter — on a
  project that hasn't configured sprints at all (azure: no team, or no current
  iteration; github: no Iteration-type field). Only an EXPLICIT `--iteration <name>`
  or the `iterations` command throws when there's nothing to resolve it against.
- Iteration assignment is board-native, never part of the ticket template/marker —
  the same rule `status` already follows (the board's real value always wins over
  anything embedded in the record). That's why it's a flag on `create`/`amend`, not a
  field in a JSON draft.

---

## Pull requests — `kodi pr`

The PR body follows a **fixed template** rendered from a validated draft. Every
section is always emitted (only **Notes** is optional). Required, enforced by Zod:

- **`-s/--summary`** — non-empty.
- **`--type`** — at least one of `feature|fix|improvement|refactor|documentation`
  (repeatable; these are the "Type of Change" checkboxes).
- **`--issue`** — at least one related issue / work item (repeatable). Pass `"N/A"`
  when there genuinely is none.
- **`--testing`** — at least one of `unit|integration|manual|na` (repeatable; the
  "Testing" checkboxes).

Optional: `--feature` / `--fix` / `--improvement` (repeatable, fill "Included
Changes"), `--notes`, `--reviewer` (repeatable), `-t/--title`. The **Checklist**
section always renders blank for the human to tick after the PR exists.

### Create

```bash
kodi pr create \
  --source feat/csv-import --target main \
  -t "feat: CSV dataset import" \
  -s "Adds CSV import to the dataset flow." \
  --type feature --type improvement \
  --feature "CSV upload modal" \
  --fix "handle empty file" \
  --issue "Closes #1196" \
  --testing unit --testing manual \
  --reviewer octocat \
  --notes "Deploy after the migration." \
  --yes
```

- `--source` (branch) is **required** for `create`. `--target` is optional: it
  defaults to the **`prTarget`** branch chosen during `kodi init`, and overrides it
  when passed. If neither is set, the command errors asking for one.
- **`--draft`** opens the PR in draft / work-in-progress (non-active) mode
  (`gh pr create --draft`, `az repos pr create --draft true`).
- **`--file <path>`** supplies the whole draft as JSON instead of flags — the
  ergonomic way to specify the nested checkbox groups.
- Reference syntax that auto-links on merge: GitHub `Closes #<id>` / `Refs #<id>`,
  Azure DevOps `AB#<id>`.

### Edit / list / abandon

```bash
kodi pr edit 42 \
  -s "Updated summary" \
  --type fix \
  --issue "Closes #1196" \
  --testing unit \
  --yes
kodi pr list
kodi pr abandon 42 --yes
```

- `kodi pr edit <id>` **re-renders the full body/title** from a fresh, fully-validated
  draft — pass the same required flags as `create` (it does not merge with the old
  body). No `--source/--target`.

### Provider / repository overrides (rarely needed)

```bash
--provider github|azure        # override the provider from kodi-dev.yaml
--repository <repo>            # gh: OWNER/REPO ; az: repository name
```

---

## Typical slice flow

```bash
kodi tickets start KODI-003 --yes   # → In progress, cuts slice/kodi-KODI-003 (assigns you)
# … implement on the branch (or inside the worktree, with --worktree) …
kodi pr create --source slice/kodi-KODI-003 --target main \
  -t "feat: CSV import" -s "…" --type feature --feature "…" \
  --issue "Closes #1196" --testing unit --yes
kodi tickets hand-off KODI-003 --pr <pr-url> --yes   # → To review
# human reviews & merges → human moves the ticket to Done
```
