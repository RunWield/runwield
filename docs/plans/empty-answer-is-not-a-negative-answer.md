---
planId: "06e22551-74b2-437c-a3a4-e8ec7e7ea511"
classification: "PLANNED_CHANGE"
workKind: "DOCUMENTATION"
complexity: "LOW"
affectedPaths:
    - "docs/prd/runwield-core-prd.md"
    - "src/agent-definitions/shared-practice/engineering-practice.md"
    - "src/agent-definitions/shared-practice/review-practice.md"
    - "src/agent-definitions/shared-practice/working-tree-safety.md"
    - "src/skills/write-tests/SKILL.md"
    - "src/shared/session/agents-shared-practice.test.ts"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-16"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "plan/empty-answer-is-not-a-negative-answer"
validatedCommit: "4aa0f8aa46249b9f54f1b319b068d2f9814d0bed"
workRecord:
    status: "generated"
    recordId: "3b2cb09c-9dd8-4ef9-824a-2ebd2bfa22a3"
    path: "docs/work-records/2026-10-16-treat-unknown-check-results-as-inconclusive.md"
    lastAttemptAt: "2026-10-16T17:06:23.354Z"
status: "verified"
---

# An Empty Answer Is Not a Negative Answer

## Context

The rule comes from two incidents in the AI software factory incident log
(<https://github.com/coleam00/ai-software-factory>, `docs/incidents.md`):

- **"The empty answer that was read as a negative answer"** — a run-list query returned no usable data. The code read
  "no data" as "no run holds this lock" and released the lock.
- **"The staleness check that called an unanswered question current"** — a fetch failed, and the code reported
  "checkout is current".

In both cases a check had three possible results, and the code handled only two. A check that uses a subprocess, a
network call, a file read, or a parse can answer **yes**, **no**, or **could not tell**. "Could not tell" includes an
unreadable, empty, timed-out, or truncated result, and an unknown status. It must take the safe path. It never counts as
"dead", "finished", "clean", or "passed". Only a positive answer releases, deletes, takes over, or reports success.

RunWield already has the nearest requirement. Core PRD
[Workflow completion and automatic recovery](../prd/runwield-core-prd.md#workflow-completion-and-automatic-recovery)
says: "RunWield repairs its own machinery automatically" and "It confirms the outcome of an uncertain external action
before it repeats that action." That sentence covers actions RunWield took. It does not cover an empty or failed query
about the state of an item. This Plan adds that requirement and the matching agent guidance.

This Plan changes documents and agent prompts only. It does not audit or change runtime code. A later, separate Plan can
audit lock release, worktree registry repair, and Session writer locks against this rule.

## Objective

The rule exists in four places, and each place states the part that its reader acts on:

| Reader                                       | Document                  | What it says                                                 |
| -------------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| Product owner, Planner                       | Core PRD                  | Recovery keeps an item when it cannot get a positive answer  |
| Engineer, Plan Engineer, Frontend Engineer   | `engineering-practice.md` | Write three branches; match an answer by a shared identifier |
| AI review (Reviewer, Integration Reviewer)   | `review-practice.md`      | Find code that turns "did not run" into "passed"             |
| Every persona that runs git or deletes files | `working-tree-safety.md`  | A failed or empty status check does not prove a clean tree   |
| Anyone who writes tests                      | `write-tests` skill       | Each check has a test for the "could not tell" case          |

## Approach

Add one short section or bullet to each document. Each one states the rule in the terms of its reader and does not copy
the full text of the others.

> [!TIP]
> **One statement per reader, no copies**
>
> The Engineer, Plan Engineer, and Frontend Engineer already compose both `engineering-practice` and
> `working-tree-safety`. So the full coding rule goes in `engineering-practice.md` only, and `working-tree-safety.md`
> gets one sentence about its own subject: deciding that a tree is clean before it deletes.

The shape of the coding rule, for reference in the Engineering Practice text:

```text
result = check()
if result is a positive "yes"   -> act (release, delete, take over, report success)
if result is a positive "no"    -> the other definite path
otherwise (empty, unreadable, timed out, truncated, unknown status, threw)
                                -> could not tell: keep the item, report the check as not run
```

**`plan-execution.md` does not change.** Every persona that composes it also composes `engineering-practice.md`, so a
copy there adds a second place to maintain and no new reader. This is a reviewable assumption.

**No domain-language change.** "Could not tell" is a coding and review rule, not a product term. It does not name a new
state that users see. `docs/domain-language.md` stays as it is. This is a reviewable assumption.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent —
the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or
the Verification Plan no longer proves the objective.

- `docs/prd/runwield-core-prd.md` — add the named requirement and two acceptance scenarios under _Workflow completion
  and automatic recovery_. This capability owns automatic repair, so the rule has one owner. The file has other pending
  edits near lines 401–450; they are in a different capability and must stay intact.
- `src/agent-definitions/shared-practice/engineering-practice.md` — add the coding rule as a new section.
- `src/agent-definitions/shared-practice/review-practice.md` — add what the reviewer looks for.
- `src/agent-definitions/shared-practice/working-tree-safety.md` — add one sentence: a check that cannot tell does not
  permit a destructive command.
- `src/skills/write-tests/SKILL.md` — add the "could not tell" test obligation to _Faking an external boundary, and what
  you still owe_.
- `src/shared/session/agents-shared-practice.test.ts` — add one assertion that the composed engineering prompts contain
  the new rule. The reviewer prompts are already covered: the existing test asserts that the full `review-practice.md`
  body is in the Reviewer, verify-mode Reviewer, and Integration Reviewer prompts.

Not changed: runtime code under `src/shared/`, `plan-execution.md`, other skills (`tdd`, `diagnose`), and
`docs/domain-language.md`.

## Reuse Opportunities

- `src/shared/session/agents-shared-practice.test.ts` — the existing test "managed engineering assigns full validation to
  RunWield…" loads `engineer`, `plan-engineer`, and `frontend-engineer` with `loadAgentDef` and checks normalized prompt
  text. Use the same pattern for the new assertion.
- The existing review-practice composition check in the same file (`assertStringIncludes(reviewer.systemPrompt,
reviewPractice)`) proves the new review text reaches reviewers with no new code.

## Implementation Steps

All new text is in ASD-STE100 Simplified Technical English style: short sentences, active voice, one instruction per
sentence.

1. `docs/prd/runwield-core-prd.md`, under `#### Workflow completion and automatic recovery`, has a new requirement after
   "RunWield repairs its own machinery automatically", with the bold title **"Requirement: Treat an unknown state as
   live."** It says that:
    - automatic repair keeps a lock, run, worktree, Session, or publication attempt when it cannot get a positive answer
      about that item;
    - an empty, unreadable, timed-out, truncated, or unknown result is "could not tell", not "dead", "finished",
      "clean", or "passed";
    - RunWield never releases, reaps, takes over, or retries an item, and never reports success, because a query was
      empty or failed.
2. The same subsection's **Acceptance scenarios** list has two new scenarios:
    - Given a lock whose run status query returns an empty or unreadable result, recovery keeps the lock and the work
      continues.
    - Given a freshness or status check whose fetch fails or times out, RunWield does not report the checkout as current
      and does not act on that result.
      No other text in the PRD changes. The existing pending edits in the file are unchanged.
3. `src/agent-definitions/shared-practice/engineering-practice.md` has a new section, placed after _Keep the Design
   Simple_, titled `## An Empty Answer Is Not a Negative Answer`. It says that:
    - a check that uses a subprocess, network call, file read, or parse has three results: yes, no, and could not tell;
    - the code writes three branches, not two;
    - "could not tell" (unreadable, empty, timed out, truncated, unknown status, or an exception) takes the safe path and
      never counts as dead, finished, clean, or passed;
    - only a positive answer releases, deletes, takes over, or reports success;
    - an answer is matched to its question with an identifier that both sides share, such as a run id, not with a name
      that one side invents.
4. `src/agent-definitions/shared-practice/review-practice.md` has a new subsection under `## Review Practice`, placed
   before `### Out of Scope`, titled `### A Check That Did Not Run Did Not Pass`. It tells the reviewer to look for:
    - an `if`/`else` or a `catch` that turns "the check did not run" into "the check passed" or "the item is gone";
    - an empty collection that gives a negative or passing result, for example `any()` or `some()` over an empty list
      read as "no item holds this", or `every()` over an empty list read as "all passed";
    - an answer matched to its question by a name that one side invents instead of a shared identifier.
      It states that such code is a concrete correctness defect (a Review Issue) when the result releases, deletes, takes
      over, or reports success.
5. `src/agent-definitions/shared-practice/working-tree-safety.md` has one new sentence or short paragraph: when a status
   check fails, times out, or returns nothing usable, the tree is not proven clean, so do not run a destructive command
   on that result.
6. `src/skills/write-tests/SKILL.md`, in _Faking an external boundary, and what you still owe_, says that a test for a
   check covers three cases: a positive yes, a positive no, and could not tell (empty, unreadable, timed out, truncated,
   or unknown output). The "could not tell" test asserts that the code takes the safe path: it keeps the item and does
   not report success. The text stays language- and framework-agnostic.
7. `src/shared/session/agents-shared-practice.test.ts` has an assertion that the composed system prompts of `engineer`,
   `plan-engineer`, and `frontend-engineer` contain the heading "An Empty Answer Is Not a Negative Answer" and the
   phrase "could not tell". The assertion fails if the section is removed from `engineering-practice.md`.

## Approval Confirmation

This Plan supersedes no Work Record.

## Verification Plan

- Automated:
    - `bun scripts/run-tests.js src/shared/session/agents-shared-practice.test.ts src/shared/session/agent-contracts.test.ts`
      passes. The new assertion from step 7 passes, and the existing review-practice composition check passes with the new
      review subsection included.
    - Mutation check for step 7: remove the new section from `engineering-practice.md`, run the same test file, and
      confirm the new assertion fails. Then restore the section.
    - `bun run fmt:check docs/prd/runwield-core-prd.md src/agent-definitions/shared-practice/engineering-practice.md src/agent-definitions/shared-practice/review-practice.md src/agent-definitions/shared-practice/working-tree-safety.md src/skills/write-tests/SKILL.md src/shared/session/agents-shared-practice.test.ts`
      passes.
- Manual inspection:
    - The Core PRD requirement and both scenarios sit under _Workflow completion and automatic recovery_. No other PRD
      capability duplicates them. The existing requirement "It confirms the outcome of an uncertain external action
      before it repeats that action" stays.
    - `git diff docs/prd/runwield-core-prd.md` shows the pending edits near lines 401–450 unchanged.
    - Each fragment states the rule for its reader and does not copy the full text of another fragment.
    - The PRD text describes a requirement, not delivered behavior. It does not claim that current recovery code already
      meets the rule. The section's existing _Scope and maturity_ note ("they do not certify that every current path
      already meets them") covers this, so no new note is needed.
- Behavior that must still be protected: all existing assertions in `agents-shared-practice.test.ts` and
  `agent-contracts.test.ts` stay and pass. No existing test is removed or rewritten.

## Edge Cases & Considerations

- **The PRD rule is a target, not a claim.** Current recovery code may not meet it yet. The later audit Plan checks
  that. Mitigation: the section's _Scope and maturity_ note already says requirements are targets for every failure
  path.
- **Overlap with the existing "uncertain external action" sentence.** That sentence covers repeating an action that
  RunWield took. The new requirement covers reading the state of an item. Keep both; the new text must not reword the
  old one.
- **The engineering rule can read as "never act".** A positive "no" is still a definite answer and can take its own
  definite path. The text must say that only "could not tell" takes the safe path.
- **Assumption:** `plan-execution.md` and `docs/domain-language.md` do not change (see Approach).
- **Assumption:** only `write-tests` among the skills changes. `tdd` defers test design to its own loop and `diagnose`
  is about finding a cause, so neither is where a test author looks for this rule.
