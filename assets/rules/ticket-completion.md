# Rule: ticket completion on remote boards

**Applies when** the `provider` attribute in `.claude/kodi-dev.yaml` is `github` or
`azure` (a remote board). If `provider` is `local`, this rule does not apply.

Board column names are **not** hardcoded — read them from the `columns` map in
`.claude/kodi-dev.yaml` (`columns.toReview`, `columns.done`, …). Refer to the config
attribute, never to a literal column name (a board might call them "Backlog",
"In review", "Shipped", etc.).

When a task/ticket is finished (the vertical slice meets its close condition):

1. **Do NOT move the ticket to the `columns.done` column.** Move it to the
   `columns.toReview` column instead — run `kodi tickets hand-off <key>`, which sets
   the ticket to the `To review` status (kodi maps that status to `columns.toReview`
   for you).
2. **The hand-off MUST be immediately followed by opening the pull request** —
   `kodi pr create …` for the slice branch. A ticket only reaches `columns.toReview`
   *together with* its PR; In review without a PR is incomplete.
3. **`columns.done` is reserved for the human.** Only move a ticket to the `Done`
   status (`kodi tickets set-status <key> Done`, which lands it in `columns.done`) on
   the user's **explicit** order. Never do it automatically — not when every gate is
   green, not when the PR is opened, not even after the PR is merged. Wait for the
   user to say so.

**Rationale:** on a remote board, `columns.done` is the human's sign-off on merge.
Agents take work as far as `columns.toReview` + PR and stop there; the transition to
`columns.done` is a deliberate human decision, never an automated one.
