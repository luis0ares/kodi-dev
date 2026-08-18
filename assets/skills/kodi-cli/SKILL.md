---
name: kodi-cli
description: >-
  How to drive the kodi CLI to create and manage board tickets, pull requests, and
  documentation artifacts (PRDs, ADRs, security reports, plans, diagrams) across the
  active provider (local / GitHub / Azure DevOps) and docs backend (local / Azure
  DevOps Wiki). Use this whenever you need to create, list, update, or transition a
  ticket/issue/work item; open, edit, list, or abandon a pull request; or read/write
  ANY doc artifact under docs/ — anytime the task touches the board, a PR, or a doc.
  kodi is the ONLY sanctioned path: raw `gh pr`, `gh issue`, `gh project`,
  `az repos pr`, `az boards`, and hand-written files under `docs/` are all denied —
  route every board/PR/doc action through `kodi`.
---

# kodi CLI — tickets, pull requests & docs

`kodi` proxies the board provider (local / GitHub / Azure DevOps) and the docs
backend (local / Azure DevOps Wiki) behind **validated templates**. Both are read
from `.claude/kodi-dev.yaml` (written by `kodi init`); you rarely pass them
explicitly.

## Golden rules

- **Always go through `kodi`.** The raw `gh pr` / `gh issue` / `gh project` /
  `az repos pr` / `az boards` commands are denied by the project permissions. A doc
  artifact (PRD/ADR/security/plan/diagrams/…) is **never** written or read with the
  `Write`/`Edit`/`Read` tools directly — always `kodi docs`. This is not optional:
  the docs backend can be an Azure DevOps Wiki, which a filesystem tool cannot see
  at all, so a direct file write would silently vanish and a direct file read would
  silently miss real content.
- **Remote mutations are dry-run by default.** Every create/update/delete prints the
  exact provider command and does nothing until you add `--yes`. Preview first, then
  re-run with `--yes` to execute. (The local docs/local board providers write
  immediately — they're safe, reversible plain files — but the CLI surface and
  `--yes` flag stay identical across providers so you never need to know which one
  is active.)
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
  --prd PRD-0001 \
  --adr ADR-0002 \
  --security SECURITY-0014 \
  --yes
```

- `--ac` / `--non-goal` / `--dep` / `--adr` are **repeatable**.
- Drivers: `--prd`, `--adr` (repeatable), `--security` — trace each ticket to what
  drives it. Pass the doc's **id** (`PRD-0001`, not a file path) — ids are stable
  across whichever docs backend is active (see below), paths are not.
- Alternatively pass a full JSON draft with `-f/--file <path>` (validated the same way).

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

## Docs — `kodi docs`

Every documentation artifact — PRD, ADR, security report, plan, diagrams, or any
other type the project has registered — lives behind `kodi docs`, on whichever
backend `kodi-dev.yaml` has configured (`local` docs/ folder, or an **Azure DevOps
Wiki**). **Never `Write`/`Edit`/`Read` a file under `docs/<type>/` directly** — on
an azure-wiki project there is no such file to touch, and even on a local project a
direct write skips the id assignment and the auto-regenerated index.

Every doc carries required frontmatter — `name`, `description`, `type` — plus
whatever extra fields are useful for that type (a PRD's `status`, a security
report's `ticket`/`severity`, …), passed as repeatable `--meta key=value`. Types are
**project-defined**, not hardcoded — `kodi docs types list` shows what's registered
for this project (typically `prd`, `adr`, `security`, `plan`, `diagrams`).

### Create

```bash
kodi docs create prd \
  --name "CSV dataset import" \
  --description "Users can import a dataset from a CSV file." \
  --file draft.md \
  --meta status=Proposed \
  --yes
# -> PRD-0001 (auto-numbered per type: PRD-0001, PRD-0002, …)
```

- `-f/--file <path>` (the body as a markdown file) or `--content <text>` (inline) —
  one is required. For anything longer than a couple of lines, use `--file`: write
  the draft to a temp path with a `Bash` heredoc (`cat > /tmp/draft.md <<'EOF' ...
  EOF`), no `Write` tool needed, then pass that path — cleaner than escaping a long
  multi-paragraph string into `--content`.
- `--meta key=value` is **repeatable** — every extra frontmatter field beyond the
  three required ones.
- The id (`PRD-0001`, `ADR-0003`, `SECURITY-0014`, …) is what you cite elsewhere
  (ticket drivers, cross-references between docs) — never a file path, which only
  makes sense for the local backend.

### Read

```bash
kodi docs types list              # the project's registered doc types
kodi docs list                    # every doc, every type
kodi docs list adr                # one type only
kodi docs get PRD-0001            # full doc: frontmatter + body
kodi docs get PRD-0001 --json     # machine-readable
```

### Update / delete / reindex

```bash
kodi docs update ADR-0003 --file revised.md --meta status=Accepted --yes
kodi docs delete SECURITY-0014 --yes
kodi docs reindex --yes           # regenerate the book-style index/table of contents
```

- **`update` revises a doc in place, at its EXISTING id** — the right command for
  "the PRD changed" / "an ADR moved from Proposed to Accepted" / "fix this doc".
  Every flag is optional and only overwrites what you pass — `--name`/
  `--description`/`--file`/`--content` default to the doc's current value, and
  `--meta` fields not named are kept as-is (so `--meta status=Accepted` alone
  changes just that one field). **`create` always mints a NEW id — never use it to
  revise an existing doc**, or you'll end up with duplicate near-identical docs.
- `reindex` runs automatically after `create`/`update`/`delete`; run it by hand only
  after an out-of-band change.

### Registering a new type

```bash
kodi docs types add mockup
kodi docs types remove mockup
```

Only needed when a doc doesn't fit any of the project's existing types — check
`kodi docs types list` first.

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
