---
name: security
description: >-
  Hunt for security vulnerabilities in a scope the HUMAN names — the current diff, a
  file or directory, a feature/endpoint, or the whole project — then rank the findings
  and write one report per confirmed breach under docs/security/. Use whenever the user
  runs /security, or says things like "check this for vulnerabilities", "security-review
  this endpoint", "is this auth safe", "audit tenancy/PII handling", "any injection risk
  here", "scan the dependencies for CVEs", "look for leaked secrets". It reviews,
  confirms and reports; it does not implement the fixes unless the human asks for them.
---

# /security [scope] — Hunt for vulnerabilities in a named scope

A **human-invoked audit**, not a build step. Nothing in `/ticket-start` runs it; you run
it when you want a surface checked.

- **The scope is the human's call.** If the invocation names one (a path, a feature, an
  endpoint, "the diff", "everything"), use exactly that. If it names none, ask —
  offering the sensible defaults below — and do not go hunting on your own.
- **Report only what you confirmed.** A finding you cannot trace to real, reachable code
  is not a finding. No speculation, no "consider maybe".
- **Never downgrade a real finding** to make a scope look clean, and never widen a scope
  to pad a report.

## Step 1 — Resolve the scope

Offer these when the human did not say:

| Scope | What it means |
|---|---|
| `diff` (default) | the current branch's changes vs. its base — fastest, sharpest signal |
| a path | one file, module or directory, read end to end |
| a feature/endpoint | the code reachable from one route or flow, traced through the layers |
| `all` | the whole project — expensive; confirm before starting |

State the resolved scope in one line before you start, plus the base branch if the scope
is the diff.

## Step 2 — Sweep the scope

Check what the scope actually exposes — skip the classes it cannot reach, and say which
you skipped:

- **Input handling** — injection (SQL/NoSQL/command/template), unsafe deserialization,
  path traversal, SSRF, unvalidated redirects, missing/incorrect input validation.
- **AuthN / AuthZ / tenancy** — missing or bypassable checks, IDOR, cross-tenant reads
  and writes, privilege escalation, session/token handling and expiry.
- **Data protection** — PII/PHI in logs or errors, missing encryption at rest/in
  transit, over-broad responses that leak fields the caller must not see.
- **Secrets** — credentials, tokens or keys committed to the repo, in config, in
  fixtures, or printed in output.
- **Dependencies** — known CVEs and dangerously outdated packages in the manifests the
  scope touches (use the project's own audit command when it has one).
- **Config & images** — insecure defaults, exposed debug/admin surfaces, permissive
  CORS, base images with known issues, over-broad IAM/permissions.

Read narrowly and quote precisely: a finding needs the file, the line, and the path an
attacker takes. Keep command output small (`2>&1 | tail -n 40`).

## Step 3 — Rank

Rank every confirmed finding **Critical / High / Medium / Low** by real impact and
exploitability in *this* system — not by the generic severity of the class. Say what
makes it reachable; if it is only reachable under a condition, name the condition.

## Step 4 — Report the confirmed breaches

Return the ranked list inline. Then, **for confirmed breaches worth acting on only**,
persist a report under `docs/security/`:

- **One file per vulnerability** — never a combined report. Each file is the seed of its
  own remediation ticket, so it must stand on its own.
- **Name it `<ticket-id>-<slug>.md`** when the code traces to a ticket (e.g.
  `docs/security/KODI-014-sqli-login.md`), otherwise `<area>-<slug>.md`.
- **Give it ticket-grade context**: what the breach is and its severity, where it lives
  (files/lines/endpoint), how it is exploited, the impact, and a concrete remediation
  direction.
- **Cross-reference** the drivers it touches (ADR/PRD, other `docs/security/` reports)
  and every related ticket — open, in progress or done — that introduced, depends on, or
  is affected by this code.
- **Commit the reports on their own**, separate from any feature commit, prefixed
  `security(<area>):` — e.g. `security(backend): report SQLi in KODI-014 login`.

**Write nothing when nothing was confirmed.** A clean pass lives in your answer, not on
disk — that keeps `docs/security/` a signal of real, actionable issues.

## Step 5 — Hand the human the next move

Close with the options, and do only what they pick:

- **Fix now** — you implement the remediation (a normal edit, gated by the project's
  usual checks).
- **Ticket it** — `kodi tickets create` a remediation ticket per report, tracing to the
  report file and the affected code.
- **Nothing yet** — the reports stand on their own for later.
