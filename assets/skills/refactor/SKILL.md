---
name: refactor
description: >-
  Refactor a SPECIFIC target the HUMAN names — a function, class, file, module or
  directory — behavior-preservingly, in small steps, under a green test suite, with a
  commit at each green state. Use whenever the user runs /refactor, or says things like
  "refactor this function", "clean up <file>", "extract this duplication", "split this
  300-line function", "this module's responsibilities are misplaced". The target is
  always the human's call — if none is named, ask; never pick the scope yourself and
  never widen it. NOT for adding features, fixing bugs, or changing behavior.
---

# /refactor <target> — Behavior-preserving cleanup of a named target

A **human-invoked cleanup**, not a build step. Nothing in `/ticket-start` runs it; you
run it when you want a specific piece of code improved.

## Laws

- **The target is given, never chosen.** You refactor exactly what the human named. You
  do not scan the codebase for things that "could also be improved", and you do not
  spill outside the target — the only exception is a call site that a signature change
  forces you to update, which you name up front.
- **Behavior is preserved.** You change *how* the code reads, never *what* it does. No
  feature added or removed, no bug fixed along the way. If the behavior would change, it
  is not a refactor — stop and surface it.
- **Tests are the precondition.** Without a passing suite covering the target you are
  not refactoring, you are editing. Green tests come first, always.
- **Small steps, committed.** The smallest change that stands on its own, then the
  tests, then a commit. The program is seen working at every step.
- **One thing at a time.** A bug or feature idea that surfaces gets parked as a
  follow-up note — never folded in.
- **ADR is law.** If an improvement would require changing an approved ADR or spec,
  STOP and surface it.

## Flow

1. **Resolve the target.** Take it verbatim from the invocation. If none was given, ask
   what to refactor — do not propose a codebase-wide hunt. If the target is vague
   ("the API layer"), narrow it with the human to concrete files before touching
   anything.

2. **Establish the safety net.** Run the **narrowest** test command that covers the
   target (from `CLAUDE.md`, quiet, no coverage).
   - Red → STOP. Report it; a red suite is a defect to fix first, not a refactor.
   - No tests, or coverage too thin to protect the behavior → STOP and say so. Offer to
     write characterization tests first; the human decides.
   - Green → commit the current state as your baseline.

3. **List the refactorings, inside the target.** Concrete and prioritized: naming,
   duplication, long functions, dead code, misplaced responsibility, unclear structure.
   Show the list before you start. Get sign-off first if any of them changes a public
   signature, moves code between modules, or touches files outside the target.

4. **Apply one micro-step at a time.** Make the single change → run the narrowest test
   command that covers it → green: commit the safe state; red: revert that step and
   rethink. Never batch changes between test runs, and never widen the test command
   beyond what the step could break.

5. **Confirm the whole sequence.** Run the target's full scoped test command once at the
   end. Do NOT run the project's full gate — that belongs to the build slice.

## Output

The transformations you applied (with files), the safe-state commits you made, explicit
confirmation that behavior is unchanged and the tests stayed green throughout, and any
parked follow-up notes. If you could not refactor safely — red suite, thin coverage, or
an ADR in the way — say exactly that and what you need to proceed. **"No refactoring
warranted" is a valid outcome**: if the target already reads well, say so and stop
rather than manufacturing work.
