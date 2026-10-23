# Reviewer Benchmark Pilot Corpus

## Status

Partly materialized. The Reviewer-only smoke runner has nine admitted discovery cases in five packages. The remaining
35 scenarios are drafts. Human review of each Plan, diff, proof, and oracle comes before paid execution.

| State              | Scenarios                                                | Source                                                          |
| ------------------ | -------------------------------------------------------- | --------------------------------------------------------------- |
| Materialized smoke | RV-D04 A/B, RV-D05 A/B, RV-D12 A/B, RV-D13 A/B, RV-M01 A | [Fixtures and run instructions](../../evals/reviewer/README.md) |
| Draft pairs        | RV-D01–D03, RV-D06–D11, RV-D14–D16 (A/B)                 | Catalog below                                                   |
| Draft multi-defect | RV-M02–M06                                               | Catalog below                                                   |
| Draft repair-state | RV-R01–R06                                               | Catalog below                                                   |

The current runner measures the baseline only, one trial per smoke case. The
[2026-10-23 baseline](reviewer-benchmark-results/2026-10-baseline-smoke.md) completed all nine rounds. The owner
accepted its 13 blocking
findings, including findings on two oracle-clean twins. Four packages are now revision 2 after repairs; these revisions
have no paid measurements. The other 35 scenarios, candidate
comparison, repetitions, and repair-state execution remain target.

The catalog contains 44 scenarios:

- 16 paired discovery families with defective and clean variants: 32 scenarios;
- 6 multi-defect discovery scenarios;
- 6 repair-state verification scenarios.

The cases favor failure modes that have mattered in RunWield: ownership, stale evidence, recovery, cancellation,
publication, state isolation, destructive operations, and test seams. The materialized projects should be small enough
to audit but large enough that the defect requires repository context rather than single-line trivia.

## Paired Discovery Families

Each row becomes two scenarios over the same Approved Plan and similar diff: `A` is defective and `B` is the clean twin.
The Reviewer never sees the variant label.

| ID     | Feature and Plan intent                                                                                                                                         | Defective variant                                                                                                                                                                               | Clean twin                                                                                                                                       | Hidden proof and expected review behavior                                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RV-D01 | Add an optional project selection to a batch operation. Omission means all projects; an explicit empty selection means none.                                    | Uses a truthiness/length fallback that converts `[]` into all projects.                                                                                                                         | Distinguishes omitted selection from an explicit empty list while retaining the all-project default.                                             | The hidden test calls with `[]`; A touches every project and must be rejected, B touches none and must be approved.                                                                                             |
| RV-D02 | Add a boolean setting whose default is enabled and whose explicit `false` value disables the feature.                                                           | Uses `configured \|\| true`, so `false` cannot survive normalization.                                                                                                                           | Uses absence-aware defaulting and preserves `false`.                                                                                             | The hidden test loads `{ enabled: false }`; A enables the feature, B disables it.                                                                                                                               |
| RV-D03 | Fetch every page from a cursor API, including APIs that can return an empty page with a continuation cursor.                                                    | Treats an empty item array as end-of-pagination and drops later results.                                                                                                                        | Continues until the cursor is absent and protects against a repeated cursor.                                                                     | The verifier returns empty page 2 with a page-3 cursor; A loses page 3, B returns it. Reject only A.                                                                                                            |
| RV-D04 | Cache a Plan summary while keeping projects and owners isolated.                                                                                                | Keys the cache by Plan name, allowing equal names in different projects to share data.                                                                                                          | Keys by stable project and Plan identity and retains the same cache behavior.                                                                    | The verifier reads equal Plan names from two projects; A returns the first project's content to the second, B does not.                                                                                         |
| RV-D05 | Delete an archived artifact only when the resolved target is beneath the archive root.                                                                          | Uses raw string-prefix containment, so a sibling such as `archive-old` passes a check for `archive`.                                                                                            | Uses resolved relative-path containment and refuses the root, parents, and prefix siblings.                                                      | The hidden proof targets a prefix sibling; A deletes outside the root and is high severity, B refuses it.                                                                                                       |
| RV-D06 | Give reviewer links read-only access and maintainer links mutation access.                                                                                      | Trusts a caller-controlled role/query value after link parsing instead of the validated capability.                                                                                             | Derives authority only from the verified capability and ignores display-role claims.                                                             | The verifier combines reviewer capability with `role=maintainer`; A mutates, B returns forbidden.                                                                                                               |
| RV-D07 | Cancel an active validation command and settle before reporting cancellation.                                                                                   | Terminates only the direct child process; a grandchild continues and writes after cancellation returns.                                                                                         | Cancels the process group/tree, waits for settlement, and reports the same user-facing outcome.                                                  | A hidden descendant writes a sentinel after cancellation; it appears only for A.                                                                                                                                |
| RV-D08 | Resume validation exactly once after an isolated repair completes.                                                                                              | Both the root task-completion path and validation owner consume the completion, causing a stale lifecycle write or duplicate checks.                                                            | Gives the live result one validation owner and keeps restart recovery evidence-based.                                                            | The verifier races completion delivery; A records two consumers or a stale transition, B advances once.                                                                                                         |
| RV-D09 | Roll back a failed lifecycle transition without overwriting a concurrently edited Plan body.                                                                    | Restores a whole-file snapshot after failure and erases the user's new body text.                                                                                                               | Reapplies only owned Front Matter to the current body.                                                                                           | The verifier edits the body between mutation and rollback; A loses it, B preserves it.                                                                                                                          |
| RV-D10 | Retry saved publication after the target branch moves, preserving both the validated candidate and latest target history.                                       | Reuses the old repair commit and force-with-lease pushes it when the lease matches, even though it does not contain the new target head.                                                        | Fetches and integrates the current target before the lease-protected push, then proves ancestry.                                                 | The target advances before retry; A drops that commit from target history, B preserves both histories.                                                                                                          |
| RV-D11 | Resolve the active project directory at operation time so one process can serve sequential projects safely.                                                     | Captures the working directory in a module-level constant and keeps using the first project after the process changes directory.                                                                | Calls the project-directory resolver for each operation and retains no ambient project cache.                                                    | Two operations run in different project roots; A writes the second result into the first, B isolates them.                                                                                                      |
| RV-D12 | Add tests around registry persistence without making product-owned registry writes replaceable.                                                                 | Adds an optional dependency bag/fallback that lets tests or callers substitute registry mutation and lock behavior.                                                                             | Exercises the real registry through a temporary project and real lock/transaction fixtures; only genuine external boundaries remain ports.       | The seam checker and behavioral mutation proof fail for A. B keeps production ownership closed and must not be rejected for using real fixtures.                                                                |
| RV-D13 | Add an archive command in three Plan steps: move the Plan to the archive, record the archive time, and list archived Plans with an archived-only filter.        | Implements the first two steps. The filter option is parsed but ignored, so the list still shows active Plans. Public tests cover only the first two steps and pass.                            | Implements all three steps with the same structure and naming.                                                                                   | The verifier lists with the archived-only filter; A returns active Plans, B returns only archived Plans. Reject A for the unmet Plan step.                                                                      |
| RV-D14 | Retain old Work Records. The original Plan text keeps the newest 10 records per project. A later Approved Plan Deviation replaces this with a 30-day age limit. | Implements the superseded count limit of 10 and ignores the confirmed deviation.                                                                                                                | Implements the 30-day age limit from the deviation. It does not keep a count limit.                                                              | The verifier seeds 12 recent records and 3 records older than 30 days; A deletes recent records, B deletes only the old ones. Reject A. B must not be rejected for differing from the superseded original text. |
| RV-D15 | Change the default workspace label from `default` to the friendlier `My Workspace` in the setup copy and the default configuration.                             | Changes the stored default value. A validator in a module that the diff does not touch derives an identifier from the label and rejects spaces and uppercase letters, so first-run setup fails. | Changes only the display label and keeps the stored identifier `default`.                                                                        | The verifier runs first-run setup with the default configuration; A fails validation, B succeeds. The defect is visible only when the Reviewer reads code outside the diff.                                     |
| RV-D16 | Add a summary export that needs a date helper. The Plan names only the export module.                                                                           | Edits the shared date helper outside the Plan and changes its timezone handling. An existing caller that the diff does not touch now formats dates one day off.                                 | Edits the same shared helper outside the Plan, but only adds an optional export that the new code uses. Existing callers keep the same behavior. | The verifier runs the existing caller across a timezone boundary; A shifts the date, B does not. Reject A for the regression. B must not be rejected only because it edits a file that the Plan does not name.  |

### Pair coverage

- **Plan adherence:** RV-D13 (missing Plan step), RV-D14 (Approved Plan Deviation is the effective requirement).
- **Plan-named edge cases:** RV-D01, RV-D02, RV-D03, RV-D05, RV-D06.
- **Concrete correctness beyond an explicitly named edge:** RV-D04, RV-D07, RV-D08, RV-D09, RV-D10, RV-D11.
- **Cross-file context (the defect is outside the diff):** RV-D15, RV-D16.
- **Architecture regression:** RV-D12.
- **High-severity clean-restraint checks:** RV-D05-B, RV-D06-B, RV-D09-B, RV-D10-B, RV-D12-B.
- **Scope-restraint checks:** RV-D14-B (follows the deviation, not the superseded text), RV-D16-B (edits a file that
  the Plan does not name).

This split must remain visible in reports. A Reviewer that only restates Plan edge cases has not demonstrated
independent correctness review.

## Multi-defect Discovery Scenarios

| ID     | Change                                                                | Independent oracle defects                                                                                                                                  | Expected behavior                                                                                                                     |
| ------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| RV-M01 | Add configurable filtered pagination for a project list.              | Explicit `false` is overwritten by a default; an empty page incorrectly ends cursor traversal.                                                              | Reject with two distinct findings. One generic “edge cases” comment matches neither unless it states both triggers and wrong results. |
| RV-M02 | Add cached remote Plan summaries behind capability links.             | Cache omits project/capability scope; reviewer capability can be promoted by a role parameter.                                                              | Reject with an isolation finding and an authorization finding.                                                                        |
| RV-M03 | Add cancellation while a validation repair can complete concurrently. | Descendant process survives cancellation; completion has two consumers and can advance twice.                                                               | Reject with both lifecycle and process-settlement defects.                                                                            |
| RV-M04 | Add external Plan adoption and transactional lifecycle rollback.      | Passive listing stamps metadata into a plain external Plan; rollback restores whole-file bytes and erases a concurrent body edit.                           | Reject with separate passive-write and body-ownership findings.                                                                       |
| RV-M05 | Retry publication and clean up the saved repair workspace.            | Repair does not contain the latest target head; failed publication still deletes the repair worktree containing recoverable work.                           | Reject with ancestry-loss and destructive-cleanup findings, both high severity.                                                       |
| RV-M06 | Make registry persistence easier to test and add unit coverage.       | Optional internal collaborator creates an injection seam; the new tests assert fake call choreography and still pass when real registry behavior is broken. | Reject with the architecture regression and misleading-test defect. Do not merge them into one style advisory.                        |

## Repair-state Verification Scenarios

Each repair scenario begins with one existing Review Issue identity and a repair report. It runs the production
verification prompt against the repair-scoped diff.

| ID     | Prior finding and repair                                                                                                                      | Hidden state                                                                                       | Expected Reviewer result                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| RV-R01 | RV-D01 empty-selection finding; repair changes absence handling and adds a focused test.                                                      | Complete fix; verifier passes and no regression is introduced.                                     | Mark the existing identity resolved and approve.                                                        |
| RV-R02 | RV-D05 path-containment finding; repair normalizes `..` segments but still accepts a prefix sibling such as `archive-old`.                    | Partial fix; the original trigger family remains reachable.                                        | Keep the existing identity open. Do not create a duplicate identity.                                    |
| RV-R03 | RV-D08 duplicate-completion finding; report says ownership was centralized, but the repair diff is empty.                                     | No implementation change; verifier still records two consumers.                                    | Keep the existing identity open despite the confident report.                                           |
| RV-R04 | RV-D10 publication-ancestry finding; repair increases retry count and refreshes the lease but never integrates the latest target.             | Symptom-only workaround; ancestry is still wrong.                                                  | Keep the existing identity open and cite the missing ancestry step.                                     |
| RV-R05 | RV-D04 cache-isolation finding; repair adds project identity to the key but removes capability scope from the lookup path.                    | Original isolation defect is resolved; a new authorization/data-exposure regression is introduced. | Mark the old identity resolved, append one new finding, and reject.                                     |
| RV-R06 | RV-D11 dynamic-directory finding; repair resolves the directory per operation and also performs harmless local renames in the touched module. | Complete fix plus unrelated but behavior-preserving churn.                                         | Resolve and approve. The churn may be an advisory only if it is concrete and useful; it must not block. |

## Materialization Notes

### Project shape

Use small Bun TypeScript projects with normal source, public tests, configuration, and an Approved Plan. Pin the Bun
version to the RunWield toolchain version so that runs are reproducible. Prefer three
to eight production modules per fixture so the Reviewer must inspect contracts across files. Avoid one-function puzzles
whose defect is obvious without repository context.

The public test suite may pass on the defective variant when the scenario represents a gap that semantic review should
catch. Hidden oracle tests remain outside the project. RV-D12 and RV-M06 intentionally include misleading touched tests
so the Reviewer must assess whether the test proves real behavior.

### Provenance

The cases are synthetic reductions, not copies of private or historical source. Their behavior is informed by existing
RunWield rules and regressions, including:

- Plan body ownership in
  [Core Plan authoring and external adoption](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption) and the
  [Plan lifecycle reference](../plan-lifecycle.md#plan-body-ownership-and-external-adoption);
- validation completion and recovery in [Validation authority](../validation-authority.md);
- worktree isolation in
  [Concurrent worktrees execution isolation](../plans/archived/concurrent-worktrees-execution-isolation.md);
- cancellation settlement in
  [Validation and process-tree cancellation](../work-records/2026-08-24-objective-failing-checks-removed.md);
- destructive retention boundaries in
  [Archived Plan retention and prune](../work-records/2026-08-16-archived-plan-retention-and-prune.md);
- injection-seam and fake-test prevention in [Engineering Quality Principles](../engineering-quality-principles.md).

Do not include these provenance documents in a materialized fixture. They would reveal what the Reviewer is expected to
find.

## Human Review Questions

Before materializing more cases, review this catalog for:

1. Are any pairs too easy because the Plan gives away the exact defect?
2. Are any clean twins still arguably defective?
3. Is an important Reviewer failure family missing?
4. Are the multi-defect changes believable features rather than glued-together traps?
5. Do the six repair states cover the ways the current ledger loop has failed in practice?
6. Is 44 scenarios the right pilot budget before expanding to historical or external corpora?
7. Do RV-D13 and RV-D14 cover the Plan-adherence failures that matter most, such as a missing step, a
   half-done step, and a superseded requirement?
