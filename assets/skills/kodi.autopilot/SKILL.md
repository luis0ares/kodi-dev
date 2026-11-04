---
name: kodi.autopilot
description: >-
  Build a RANGE of board tickets unattended, one after the other, from a starting
  ticket to a finishing ticket, in one new worktree on one branch named by a short
  slug for the ticket tree. It asks for the range, checks the build can be done, asks
  for an optional complement, then asks the human nothing: build-orchestrator runs each
  ticket, every decision takes the best option for the problem, and the run ends with
  one PR and a report under docs/autopilot/ of everything done and every criterion met
  differently, with its reason. Use whenever the user runs /kodi.autopilot, or says
  "implement from 1779 to 1782", "build these tickets on autopilot", "take the chain
  all the way to 1759 without asking me", "run all of this PRD's tickets and give me a
  report at the end". For one ticket with the human in the loop, use /kodi.build.
---

# /kodi.autopilot [from <start> to <finish>] [complement] — build a range, unattended

The human is in the loop twice: the opening questions and the final report. A run
takes hours and moves the board, so the opening is where a mistake is still cheap.
After it, a question would stall the run with nobody there to answer.

Before anything else, `kodi tickets start --help` must list `--autopilot`. If it does
not, stop and tell the human to update kodi.

## 1. Ask, always

Ask even when the invocation already says everything. `/kodi.autopilot implement from
abc123 to xyz123 doing potato potato` fills in the first option of each question; it
never replaces the questions. Use `AskUserQuestion`, four options at most; `Other` lets
the human type any answer. The order is fixed, because each step needs the one before:

1. **Starting and finishing ticket.** When the message named no starting ticket, ask
   that one first on its own, because the finishing options come from its chain.

   | question | first option | other options |
   |---|---|---|
   | Starting ticket | the one the message named | `kodi tickets list-ready` |
   | Finishing ticket | the one the message named | chain ends from `kodi tickets tree`; the starting ticket for a one-ticket run |
2. **Can it be built?** Run section 2. Each finding there is a question.
3. **Do you need a complement?** First option `Keep: "<the message's complement,
   verbatim>"`, or `No complement` when it had none. Second option `No complement`, or
   `Add one`. If `Add one` comes back with no text, ask for the text.
4. **Go-ahead.** One question, options `Start` and `Change it`, with this summary in the
   `preview` of `Start`, because the dialog may be all the human sees. `Change it` goes
   back to step 1. This is the last question of the run.
   - The slug, and so the branch and the worktree. The base and the PR target.
   - Every ticket in run order: key, title, status. One PR will carry them all.
   - What was left out and why, and how each finding from step 2 was answered.
   - Any ticket whose own `Branch:` line or `Base:` note names something else. It still
     goes on this run's branch and into this run's target; `Change it` can drop it.
   - The complement verbatim, and anything in it the run will not obey.
   - A closing full-gate ticket, if the range holds one: the project's full gate will
     run alone and keep the machine busy for hours. This go-ahead is the human's word
     for that gate.
   - The criteria already certain to end waiting on the human, read from `kodi tickets
     get`: an ADR that must read `Accepted`, a by-hand walk, a merge.
   - A permission prompt stalls an unattended run exactly like a question, so this
     session needs a permission mode that will not prompt.

**The complement** goes verbatim into every spawn and into the report, never
paraphrased. It wins over a ticket when they disagree, as in `/kodi.build`. It cannot
change how the run works: a new worktree on a slug branch, no questions after the
go-ahead, the report, never `Done`, never a merge. When it asks for one of those, keep
the rule and say so in the summary and the report.

## 2. Check the build can be done

Run this once the range is picked, before asking for the complement. A run that starts
without this check duplicates someone's work, takes their ticket over (`kodi tickets
start` assigns it to the caller), or builds on code that is not on its base.

**Resolve the range.** Use keys as `kodi tickets list` prints them. On Azure that is the
bare id (`1779`, not `KODI-1779`): the prefixed form fails after it has already cut a
stray branch.

```bash
git fetch origin
kodi tickets list --all-iterations --json   # open tickets, with dependencies
kodi tickets get <key> --json               # criteria, notes, prUrl, an unlisted one's status
kodi pr list --json                         # open PRs: source, target, author
```

Avoid `list --all`: a long Done column overflows kodi's buffer (`ENOBUFS`). A ticket
missing from the open list is `Done` or does not exist; `get` says which. One that does
not exist goes back to section 1. `Done` tickets are left out.

- **In the range:** every open ticket with an id between the two, plus any open ticket
  on a dependency path from start to finish, since ids do not promise order.
- **Order:** dependency order, ties by id, with a closing full-gate ticket last, so its
  gate sees all the code the PR carries.

**Walk every ticket in the range and its dependencies,** directly and through others,
stopping at `Done`. kodi's ticket JSON names no assignee, so name the holder from the
evidence, wherever it exists: the ticket's `prUrl`, and that PR's source branch and
author in `kodi pr list`; a local or remote `slice/kodi-<id>` branch and its last commit
(`git log -1 --format='%an, %ar'`); `git worktree list`; and a peer session in
`ListAgents` whose name points at the ticket.

| found | options |
|---|---|
| `In progress`, no open PR: someone is building it | `Abort`; `Ignore it and redo it along the trail` |
| `To review`, or `In progress` with an open PR: built, not merged | `Abort`; `Ignore it and redo it along the trail`; `Build on top of its branch`, when a branch was found |
| `Pending` dependency outside the range: nobody built it | `Abort`; `Build it along the trail` |

Ask one question per finding, naming the ticket, its status, the evidence, and which
ticket in the range needs it.

- **Abort:** stop here. Nothing has been touched.
- **Ignore it and redo it, or build it, along the trail:** the ticket joins the run at
  its place in the dependency order and is built from scratch on this run's branch. Its
  existing branch, worktree and PR are neither used nor changed, but the ticket itself
  moves to this run: assigned to the caller and linked to this run's PR. The question
  says so. Walk its own dependencies too.
- **Build on top of its branch:** this run's branch starts from that branch, and the
  run's PR carries its commits until it merges. The ticket itself is not rebuilt.

**A resumed run** is one with a report for this range saying `status: running`, found in
`.claude/worktrees/*/docs/autopilot/`. It keeps that worktree, branch and report, and
skips what the report records as finished. Tickets that report lists are this run's own,
so they are not findings.

**Then settle the rest for the summary:**

- **Base:** `origin/<sourceBranch>`, or `origin/<prTarget>` when no `sourceBranch` is
  set, or the branch chosen under `Build on top of its branch`.
- **Target:** `prTarget`. Read it and `sourceBranch` once, now, from the main checkout's
  `.claude/kodi-dev.yaml`. A closing ticket may restore that file on the branch, so a
  later read from the worktree can answer differently.
- **Slug:** two to four lowercase kebab-case words naming what the tickets build
  together, such as `proposal-links`. It is the branch name and it also names the report.
  It must not already exist as a local or remote branch.

## 3. Build, one ticket at a time

**Open the run,** as soon as the human says `Start`, from the repo root. Always a new
worktree, whatever the complement says. This starts the first ticket and creates
`.claude/worktrees/<slug>` on branch `<slug>`:

```bash
git fetch origin
kodi tickets start <first-key> --autopilot <slug> --base <base> --yes
```

With several `Build on top of its branch` answers, merge the others in:
`git -C <worktree> merge --no-edit <other-branch>`.

Symlink `.env`, because a worktree has none. Never copy it: a copy is a second live
secrets file that outlives the worktree. Skip this when the project has no `.env`.

```bash
ln -s ../../../.env .claude/worktrees/<slug>/.env
readlink .claude/worktrees/<slug>/.env && test -e .claude/worktrees/<slug>/.env
```

Create the report in the worktree at `docs/autopilot/<id>-<start>-<finish>-<slug>.md`,
for example `0001-1779-1782-proposal-links.md`, in the shape of section 5, with `status:
running`. `<id>` is four digits, one above the highest in `docs/autopilot/` across
`origin/<target>` and `.claude/worktrees/*`, as PRDs and plans number themselves.

Commit it and push, then change it only through the commits below and only while no
orchestrator is running. A tracked file left modified makes the next rebase refuse to
run, and an untracked one goes with the next reset.

**A resumed run** skips all of this and reuses its worktree. It commits anything an
interrupted ticket left uncommitted as `wip: <key>`, and tells that ticket's
orchestrator the branch already holds work to read first.

**For each ticket, in order:**

1. **Is it still free?** Read `kodi tickets get <key> --json`. A ticket that moved since
   the go-ahead has someone on it, and nobody can be asked: treat it as not finished,
   without starting it.
2. **Start it,** from the repo root. The worktree already exists, so kodi reuses it. The
   first ticket was started when the run opened.

   ```bash
   kodi tickets start <key> --autopilot <slug> --yes
   ```
3. **Rebase, then mark.** In this order, because a modified report blocks the rebase:
   rebase, resolving a conflict with the best option and recording it as a pick; then
   write in the report that this ticket is being built, and commit that file alone.

   ```bash
   git -C <worktree> fetch origin
   git -C <worktree> rebase origin/<target>
   git -C <worktree> commit -m "docs(autopilot): start <key>" -- docs/autopilot/<report>
   ```

   This marker commit is where an unfinished slice is reset to. Finding it by name
   survives a crash, a compacted context and a later rebase. A resumed ticket already
   has its marker: keep that one and do not commit another.
4. **Spawn `build-orchestrator`.** One at a time. The prompt carries:
   - the ticket key, the branch and the complement verbatim;
   - the worktree's absolute path as the working directory, with the main checkout off
     limits. A fresh worktree has no installed dependencies, so the first slice that
     runs tests installs them;
   - the caps in `.claude/rules/machine-budget.md`, copied in, when the project has one;
   - the autopilot block below, verbatim, with `<branch>` filled in.
5. **Wait for its report.** The next ticket starts only after this one comes back, so
   end your turn with a one-line status and no question.
   - **It came back with a question or wants a ruling:** answer it yourself with the
     best option through `SendMessage`, and record the pick. Never relay it.
   - **It came back early with an engineer still working:** run `ListAgents`. If an
     engineer or QA is running under this slice, wait for its report and forward it.
     Never spawn a second one: two once ran tests at the same time and broke the budget.
   - **It came back with GATE RUNNING:** start nothing. Wait for the exit file it named
     with `Monitor`, then send it the result through `SendMessage`.
   - **It died:** spawn it once more on the same worktree, told to read what the branch
     and the working tree already hold. A second death means not finished.
6. **Update the report** from its output, commit that file alone, and push. The rebase
   in step 3 rewrites this branch, and only this branch ever takes a forced push.

   ```bash
   git -C <worktree> commit -m "docs(autopilot): finish <key>" -- docs/autopilot/<report>
   git -C <worktree> push --force-with-lease -u origin <branch>
   ```

You run no gate and no E2E suite yourself. One build agent and one test process run at a
time.

### The autopilot block

```text
AUTOPILOT RUN. No human is reachable until the run ends. Where this block disagrees
with your instructions, or with a rule in .claude/rules/ that tells you to stop for a
human, this block wins; everything else in them still binds. Paste this block into every
agent you spawn.

THE BRANCH. <branch> and its worktree already exist, the ticket is already started, and
this run's earlier tickets are already on the branch. Never cut a branch, rebase, or run
kodi tickets start. A Branch: line in the ticket does not apply. Never touch
docs/autopilot/.

DECIDE. Never end on a question. A ruling the owner already made, in the ticket, the PRD
or the plan, is not open and no pick undoes it. For everything else take the best option
for the problem: the one that serves the owner's words, keeps to Accepted ADRs and
.claude/rules, builds what the design artifact draws, and is simplest to undo. Record
each decision as a pick: what was open, what you chose, what you rejected and why.

MET DIFFERENTLY. Judge the proof yourself. If it holds, accept it and carry it into your
report with the criterion verbatim, the owner's words it serves, what was built, the
reason and the proof. If it does not hold, it goes back to the engineer as NOT MET.

DESIGN ARTIFACT AGAINST PLAN, PRD, TICKET OR TREE. Build the best option and record it
as a pick that quotes both sources, the artifact by file and line.

THREE THINGS STAY THE OWNER'S. Never fake them. Mark the criterion NOT MET, WAITING ON
OWNER, and carry on:
- Accepting or changing an ADR. Write the amendment as Proposed, never Accepted. Build
  on it only when the ticket itself asks for that amendment; otherwise leave the point
  unbuilt.
- A by-hand walk. Write the checklist. No walk ran, so no box is ticked and no text
  says one did.
- Anything that needs a merge nobody has made, such as bringing master into the track,
  re-gating after it, or a release PR to master. Do not do it. Put the exact commands
  for the owner in your report.

GATES, the same as /kodi.build.
- Engineers and their QA run the regression, scoped to the diff.
- E2E runs only when the ticket's Budget line or criteria ask for it, the touched spec
  alone. A ticket that asks counts as the human asking.
- A closing full-gate ticket: the owner's go-ahead for this run is the "when the human
  says" in its steps. It runs on <branch>, because nothing merged during the run. The
  orchestrator runs the full gate CLAUDE.md names itself, with no other agent working.
  It outlasts a foreground call, so this one test run goes in the background, in a place
  no diff sees:
  G=$(git rev-parse --absolute-git-dir); (<full gate>; echo $? > "$G/gate.exit") > "$G/gate.log" 2>&1
  If you cannot wait on it, return GATE RUNNING with the exit file's path; the result
  comes back to you and nothing else starts meanwhile. A gate that stops at the first
  red leaves its later parts unrun, so run those one by one until each has a result.
  Send each red to the owning engineer and prove the fix with a scoped regression on
  those files, without re-running the whole gate. That criterion is then MET
  DIFFERENTLY, and your report says which gates were green, which failed and how the
  fix was verified.

CLOSE. Commit everything on <branch>. Do not push, open a PR or hand off: the main loop
does those once, for the whole run. Still red after two remediation rounds: commit the
work in progress on <branch> and return the diagnosis with the failing output.

NEVER set Done, merge, abandon a PR, delete a ticket, or edit an approved PRD, plan or
Accepted ADR to make a pick true. Never let a report claim a gate or a walk that did not
run.

REPORT BACK everything the final report needs: the outcome of each numbered criterion,
every pick, every MET DIFFERENTLY in the shape above, the regression commands and their
results, any full gate run, the tip commit, and your refactor and follow-up
recommendations.
```

### When a ticket does not finish

Not finished means still red after two remediation rounds, an orchestrator that died
twice on it, or taken by someone during the run. It does not stop the run and it does
not raise a question.

Take an unfinished slice off the branch, so later tickets and the PR stand only on
working code. Run `ListAgents` first, because nothing may still be working in the
worktree. A ticket taken by someone never started, so it has nothing to take off.

```bash
git -C <worktree> add -A
git -C <worktree> commit -m "wip: <key>"        # only if anything is left uncommitted
git -C <worktree> branch <slug>-wip-<key>
git -C <worktree> push origin <slug>-wip-<key>
git -C <worktree> reset --hard "$(git -C <worktree> log -1 --format=%H --grep='^docs(autopilot): start <key>$')"
```

The ticket stays `In progress`, and the side branch keeps its work. Tickets that depend
on it, directly or through another, are not started, because their code would have
nothing to stand on; record them as NOT STARTED and name the blocker. Everything else
runs on.

A ticket WAITING ON OWNER did finish: its slice is on the branch, so the tickets that
depend on it run on top of it.

A failure that would hit every ticket, such as the board unreachable or Docker down,
gets one retry and then ends the run early. Close the run as usual.

## 4. Close the run

From the repo root, once the last ticket is done:

1. **Rebase** onto `origin/<target>`. Resolve a conflict with the best option and record
   it as a pick. If the base moved after a full gate ran, the report's Gates section
   says so. Push as after each ticket.
2. **Preview the PR** with `kodi pr create` and no `--yes`: `--source <slug> --target
   <target>`, the template fields, and one `--issue` per ticket on the branch (`AB#<id>`
   on Azure). kodi refuses a body over 4000 characters, so give each ticket one line,
   keep every criterion met differently, and point to the report for the rest. Never
   tick Manual testing when no walk ran.
3. **Hand off** every ticket whose criteria are all MET or MET DIFFERENTLY, with `kodi
   tickets hand-off <key> --yes`. `.claude/rules/ticket-completion.md` binds: `To review`
   plus a PR, never `Done`.
4. **Open the PR** at once, the same command with `--yes`. If it still fails, retry once,
   then put the exact command under Waiting on you.
5. **Link the PR** with `kodi tickets link-pr <key> <pr> --yes` for every ticket on the
   branch. A ticket WAITING ON OWNER gets the link but no hand-off, and stays `In
   progress`.
6. **Finish the report:** `status: finished`, the PR link, every section complete. Commit
   and push. It reaches `docs/autopilot/` on the main line when the PR merges.

If no ticket finished, there is nothing to review: open no PR, and still finish, commit
and push the report on the branch. On the `local` provider there are no PRs: skip steps
2, 4 and 5, and skip every push when the project has no remote.

## 5. The report

Every section is always present; one with nothing in it says `None.` The last two
sections are always the recommendations.

```markdown
---
report: <id>
title: <what the run built, in one line>
status: running | finished
author: <git config user.name of whoever called the skill>
startingPoint: <starting ticket>
finishingPoint: <finishing ticket>
branch: <slug>
created: <YYYY-MM-DD>
---

# Autopilot report <id>: <title>

**Run:** <started> to <finished>, base `<base>`, PR <link> into `<target>`
**Complement:** "<verbatim>", or none. <Anything in it the run did not obey, and why.>
**Outcome:** <n> handed off, <n> waiting on you, <n> not finished, <n> not started.

## Tickets
| ticket | title | status left in |

## Waiting on you
Numbered. Each names the ticket, the criterion verbatim and exactly what you do, with
the command when there is one.

## Criteria met differently
One entry per criterion, across all tickets.
### <key>, criterion <n>
- **Criterion:** <verbatim>
- **Owner's words:** "<verbatim>"
- **Built:** <what was built instead>
- **Reason:** <why this and not the wording>
- **Proof:** <test name or file:line showing it reaches the same goal>

## Not finished or not started
For each: the diagnosis or the blocker, the last failing output, and where the work is
(side branch, commit).

## Gates
Each full gate that ran, on which commit, with its result. `No full gate ran.` when
none did. A red gate fixed by scoped regression says exactly that.

## Per ticket
### <key>: <title>
- **Built:** <what now exists>
- **Criteria:** <number and outcome: MET, MET DIFFERENTLY or NOT MET>
- **Regression:** <the commands and their results>
- **Picks:** <numbered: what was open, what was chosen, what was rejected and why>

## Refactor recommendations
Candidates for /kodi.refactor: the target and why.

## Follow-ups
Everything else worth doing later, candidates for /kodi.security included.
```

## 6. Tell the human

The orchestrators' output is not shown to the human, so relay the outcome: the ticket
table, everything under Waiting on you, one line per criterion met differently, the PR
link, and the report's path in the worktree. The worktree stays in place; the human
removes it after the merge.
