---
planId: "dc86b005-4b84-4002-bb5c-270e8500cff2"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "evals/reviewer/RV-D07/"
    - "evals/reviewer/RV-D08/"
    - "evals/reviewer/RV-D09/"
    - "evals/reviewer/RV-D10/"
    - "evals/reviewer/README.md"
    - "scripts/reviewer-benchmark/admission.test.ts"
    - "docs/evaluation/reviewer-benchmark-pilot-corpus.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-24"
status: "ready_for_work"
origin: "internal"
parentPlan: "reviewer-benchmark-discovery-pairs"
order: 2
dependencies:
    - "01-corpus-selection-oracle-verdicts-and-edge-case-fixtures"
userVerifiedAt: null
userVerificationNote: null
---

# Lifecycle, Process, and Publication Fixtures

## Context

Second of three Plans in [Reviewer Benchmark: All Discovery Pairs](../reviewer-benchmark-discovery-pairs.md). Plan 1
made the corpus directory the authority, so this Plan adds packages only. No runner code changes.

These four pairs are the hardest to build. Each defect depends on timing, process, file, or Git state, and each proof
must still be deterministic.

## Objective

Packages RV-D07, RV-D08, RV-D09, and RV-D10 pass admission, so `--scenarios all` selects 25 cases.

## Approach

Each proof makes the dangerous ordering happen on purpose. No proof relies on sleep timing or a lucky race.

| Package | Group                   | Defective A                                                                               | Clean B                                                                                     | How the proof forces the case                                                                                                                                   | Severity of A |
| ------- | ----------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RV-D07  | correctness-beyond-plan | Cancel kills only the direct child; a grandchild writes after cancel returns              | Cancel kills the process group and waits for it to settle                                   | The grandchild writes a "ready" file, then waits for a "go" file that the proof creates only after cancel returns. A sentinel write after "go" fails the proof. | medium        |
| RV-D08  | correctness-beyond-plan | Both the completion listener and the validation owner consume a repair completion         | One owner consumes it; restart recovery reads evidence                                      | The proof delivers one completion through the public API and counts transitions and consumers.                                                                  | medium        |
| RV-D09  | correctness-beyond-plan | Rollback restores the whole-file snapshot and erases a concurrent body edit               | Rollback reapplies only owned front matter to the current body                              | A failing transition step edits the body before it throws; the proof checks the body after rollback.                                                            | high          |
| RV-D10  | correctness-beyond-plan | Retry pushes the old repair commit with force-with-lease; the target's new commit is lost | Retry fetches and integrates the current target, then proves ancestry before the lease push | The proof uses a temporary bare repository, advances the target between attempts, and checks ancestry with `git merge-base --is-ancestor`.                      | high          |

RV-D09 and RV-D10 are high severity because the corpus lists their clean twins as high-severity restraint checks.

> [!WARNING]
> **Platform requirements**
>
> RV-D07 uses POSIX process groups (`process.kill(-pid)`), as RV-D04 already uses `mkfifo`. RV-D10 runs `git` and sets
> its own author and committer identity through environment variables, so it does not depend on global Git settings.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent
— the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows,
or the Verification Plan no longer proves the objective.

- `evals/reviewer/RV-D07` … `RV-D10` — new packages.
- `scripts/reviewer-benchmark/admission.test.ts` — expected check counts for the new packages.
- `evals/reviewer/README.md` — package table and platform requirements.
- `docs/evaluation/reviewer-benchmark-pilot-corpus.md` — status table.

If a fixture cannot run through `admitFixtures` as written (for example, the proof needs a second package script), stop
and report. Do not add a fixture-specific branch to runner code.

## Reuse Opportunities

- `evals/reviewer/RV-D04/` — real filesystem coordination in a proof (`mkfifo`), the closest model for RV-D07.
- `evals/reviewer/RV-D12/` — a fixture whose `AGENTS.md` carries a project ownership rule, useful for RV-D08 and RV-D09.
- `scripts/reviewer-benchmark/materialize.ts` — how fixtures get neutral Git history; RV-D10 must not leak into it.

## Implementation Steps

1. Packages `RV-D07`, `RV-D08`, `RV-D09`, and `RV-D10` exist under `evals/reviewer/` with `source/`, `variants/`
   (`defective.patch`, `clean.patch`), `evaluation/` (`oracle.yaml`, `proofs.ts`), and `scenario.yaml`
   (`fixtureRevision: 1`, group `correctness-beyond-plan`).
    - Each `source/` is a Bun 1.4.3 TypeScript project with three to eight production modules, `tests/public.ts`,
      `AGENTS.md`, `README.md`, and an approved Plan that does not name the defect or the fix.
    - The public suite passes for A and B.
    - The clean twin has the same structure as A and fixes only the planted defect.
    - Each A defect has a stable `defectId`, the severity in the Approach table, category, trigger, expected and wrong
      behavior, evidence paths, acceptable concepts, near misses, and one proof with an `RV-…` assertion marker.
2. Each proof forces its ordering as the Approach table describes, and leaves no process, temporary directory, or Git
   repository behind after it ends, whether it passes or fails.
3. `admission.test.ts` has expected check counts for the four packages, and admission passes for all 13 packages.
4. The leak test passes for the four packages. RV-D10's materialized project has only the neutral `main` and `change`
   history; any repositories the public tests or proofs create live in temporary directories outside the project.
5. `evals/reviewer/README.md` lists the four packages and the POSIX and `git` requirements.
   `docs/evaluation/reviewer-benchmark-pilot-corpus.md` shows RV-D07–D10 as materialized.

## Verification Plan

Automated (no model calls):

- `bun scripts/run-tests.js scripts/reviewer-benchmark/admission.test.ts scripts/reviewer-benchmark/materialize.test.ts`
  — admission passes for RV-D07–D10: each A proof fails with its exact `AssertionError` marker and each B proof passes.
  Leak checks pass.
- `bun scripts/run-tests.js scripts/reviewer-benchmark/run.test.ts` — `selectCases("all")` returns 25 cases.
  `git diff` for this Plan shows no change to `scripts/reviewer-benchmark/run.ts`, `fixtures.ts`, or `records.ts`.
- Run `bun scripts/run-tests.js scripts/reviewer-benchmark/admission.test.ts` three times in a row. All three pass,
  which shows the forced orderings do not depend on timing.
- After the admission tests, `ps` shows no process left from RV-D07, and the temporary directory has no new
  `project-*` directory. The existing admission test already asserts the second check.

Manual:

- Read each Plan. None names the planted defect or its fix.

Behavior that must still be protected: admission of the nine earlier packages, and production Semantic Review
unchanged.

## Edge Cases & Considerations

- **Flaky proofs.** A proof that passes on A by timing would make admission flaky. The "ready" and "go" files in RV-D07
  remove the timing dependency; the three-run check above catches a remaining one.
- **Leftover processes.** An RV-D07 A proof leaves a grandchild by design. The proof must kill it in `finally` after
  it checks the sentinel.
- **Git in Git.** RV-D10 creates repositories during tests. They must stay outside the materialized project so the
  Reviewer's project history stays neutral.
- **Unreviewed design.** The owner judges these fixtures after the run in Plan 3. A fixture judged wrong leaves the
  scores, and its repair is follow-up work.
