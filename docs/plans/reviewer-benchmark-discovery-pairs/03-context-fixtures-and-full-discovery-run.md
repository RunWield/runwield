---
planId: "74e94a1c-31a6-4888-a9cf-8430fa4bf295"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "evals/reviewer/RV-D11/"
    - "evals/reviewer/RV-D14/"
    - "evals/reviewer/RV-D15/"
    - "evals/reviewer/RV-D16/"
    - "evals/reviewer/README.md"
    - "scripts/reviewer-benchmark/admission.test.ts"
    - "scripts/reviewer-benchmark/fixtures.test.ts"
    - "docs/evaluation/reviewer-benchmark-results/2026-10-discovery-pairs.md"
    - "docs/evaluation/reviewer-benchmark-scorecard.md"
    - "docs/evaluation/reviewer-benchmark-pilot-corpus.md"
    - "docs/prd/agent-behavior-evaluation-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-24"
origin: "internal"
parentPlan: "reviewer-benchmark-discovery-pairs"
order: 3
dependencies:
    - "02-lifecycle-process-and-publication-fixtures"
userVerifiedAt: null
targetBranch: "main"
validatedCommit: "ba7f47a74d9f6ed43ea9e5d9c7e63514a47b855e"
status: "verified"
---

# Context Fixtures and the Full Discovery Run

## Context

Last of three Plans in [Reviewer Benchmark: All Discovery Pairs](../reviewer-benchmark-discovery-pairs.md). It adds the
last four discovery pairs, runs the production Reviewer on all 33 discovery cases, and commits a report for the owner to
adjudicate.

These four pairs test context, not edge cases. RV-D14 tests whether the Reviewer follows an Approved Plan Deviation.
RV-D15 and RV-D16 put the defect in code that the diff does not touch.

## Objective

- Packages RV-D11, RV-D14, RV-D15, and RV-D16 pass admission; `--scenarios all` selects 33 cases from 17 packages.
- One run of all 33 cases is complete, scored, and reported in
  `docs/evaluation/reviewer-benchmark-results/2026-10-discovery-pairs.md`, marked pending adjudication.

## Approach

### Fixtures

| Package | Group                   | Defective A                                                                         | Clean B                                                       | Severity of A |
| ------- | ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------- |
| RV-D11  | correctness-beyond-plan | Project directory captured in a module-level constant                               | Directory resolved per operation                              | medium        |
| RV-D14  | plan-adherence          | Keeps the newest 10 records (superseded text)                                       | Deletes records older than 30 days (the deviation)            | medium        |
| RV-D15  | cross-file-context      | Stored default label `My Workspace` fails an untouched identifier validator         | Only the display label changes; the stored ID stays `default` | high          |
| RV-D16  | cross-file-context      | Shared date helper changes timezone handling; an untouched caller is off by one day | Same helper file edited, but only an optional export is added | medium        |

**RV-D14 uses the production deviation path.** Its Plan carries `planDeviations` front matter with one entry. The
Reviewer sees it because `projectEngineerPlanBody` renders it as `## Approved Plan Deviations`. B must not be rejected
for differing from the superseded text.

**RV-D15 and RV-D16 hide the defect outside the diff.** At least one evidence path of the A defect is a file that the A
patch does not change. RV-D16 B also edits a file the Plan does not name, to test scope restraint.

**RV-D11 runs two operations in different project roots.** The proof uses `process.chdir` between them in its own
process, never in the Reviewer's project.

RV-D15 is high severity because every first-run setup fails. This is an assumption the owner can change during
adjudication.

### The run

```text
bun scripts/run-reviewer-benchmark.ts run --scenarios all
  admission of all 17 packages        # before any model call
  33 Reviewer rounds, one trial each  # effective configured Reviewer model
bun scripts/run-reviewer-benchmark.ts score <run-dir>
  summary.md: worksheet per case, status pending adjudication
```

If cases fail for setup reasons, `--resume` with the same `--out` retries only unfinished cases. If the model cannot be
reached, the report is not written and the execution report names the setup failure.

### Adjudication after the run

The owner reads the report in code review and judges each case: is the planted defect real, is the clean twin really
clean, and is each blocking finding `matched`, `duplicate`, `unsupported`, or `novel_valid`. The Engineer writes those
answers to `adjudications.json` in the run directory, scores again, and updates the report.

Fixtures judged `fixture_needs_repair` stay as they are in this Plan. Their repair is follow-up work.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent
— the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows,
or the Verification Plan no longer proves the objective.

- `evals/reviewer/RV-D11`, `RV-D14`, `RV-D15`, `RV-D16` — new packages.
- `scripts/reviewer-benchmark/admission.test.ts` — expected check counts.
- `scripts/reviewer-benchmark/fixtures.test.ts` (or a new test file registered in `scripts/bun-test-files.json`) —
  the RV-D14 deviation and cross-file evidence checks.
- `docs/evaluation/reviewer-benchmark-results/2026-10-discovery-pairs.md` — the new report.
- `evals/reviewer/README.md`, `docs/evaluation/reviewer-benchmark-scorecard.md`,
  `docs/evaluation/reviewer-benchmark-pilot-corpus.md`, `docs/prd/agent-behavior-evaluation-prd.md` — current state.

## Reuse Opportunities

- `src/shared/workflow/engineer-plan-projection.ts` `projectEngineerPlanBody` — renders the RV-D14 deviation; use it in
  the test, do not copy its format.
- `src/shared/plan-deviations.ts` — the `planDeviations` entry fields: `id`, `supersededRequirement`,
  `replacementRequirement`, optional `reason`, `approvedAt`.
- `docs/evaluation/reviewer-benchmark-results/2026-10-baseline-smoke.md` — report structure: result, configuration and
  method, prompt hashes, fixture identity, decisions, splits.

## Implementation Steps

1. Packages `RV-D11`, `RV-D14`, `RV-D15`, and `RV-D16` exist under `evals/reviewer/` with `source/`, `variants/`
   (`defective.patch`, `clean.patch`), `evaluation/` (`oracle.yaml`, `proofs.ts`), and `scenario.yaml`
   (`fixtureRevision: 1`, the group in the Approach table).
    - Each `source/` is a Bun 1.4.3 TypeScript project with three to eight production modules, `tests/public.ts`,
      `AGENTS.md`, `README.md`, and an approved Plan that does not name the defect or the fix.
    - The public suite passes for A and B.
    - Each A defect has a stable `defectId`, the severity in the Approach table, category, trigger, expected and wrong
      behavior, evidence paths, acceptable concepts, near misses, and one proof with an `RV-…` assertion marker.
2. The RV-D14 Plan has one valid `planDeviations` entry that replaces the count limit of 10 with a 30-day age limit.
   A test passes the materialized RV-D14 Plan through `projectEngineerPlanBody` and finds `## Approved Plan Deviations`
   and the replacement requirement in the result.
3. A test checks that, for every package whose group is `cross-file-context`, at least one evidence path of the A
   defect is a file that the A patch does not change.
4. `admission.test.ts` has expected check counts for the four packages, and admission passes for all 17 packages.
   Leak checks pass for the four packages.
5. One run of `bun scripts/run-reviewer-benchmark.ts run --scenarios all` has a result for each of the 33 cases, and
   `score` has written `summary.md` and `summary.json` for it. No case was re-run to get a better result: resume
   retries only unfinished cases.
6. `docs/evaluation/reviewer-benchmark-results/2026-10-discovery-pairs.md` exists and holds:
    - status **pending adjudication**, the run ID, and the local run directory path;
    - the actual model, provider, thinking level, Bun version, RunWield revision and dirty flag, and prompt SHA-256
      values from the run manifest;
    - fixture revision and hash for each of the 17 packages;
    - mechanical decisions for each case, and splits by variant and group;
    - for each case, the worksheet from `summary.md`: package and patch paths, the oracle defect or "no defect", and
      each blocking finding with its index;
    - a statement that one trial does not show stability, that no threshold applies, and that the nine smoke cases now
      run revision 2 fixtures and cannot be compared with the October baseline as a trend;
    - instructions for the owner's adjudication, with the `oracleVerdicts` and `adjudications` format.
7. Documents match the delivered state:
    - `docs/evaluation/reviewer-benchmark-pilot-corpus.md` — all 16 pairs and RV-M01 materialized; RV-M02–M06 and
      RV-R01–R06 still draft.
    - `evals/reviewer/README.md` — package table complete for the 17 packages.
    - `docs/evaluation/reviewer-benchmark-scorecard.md` — links the new report as the latest run.
    - `docs/prd/agent-behavior-evaluation-prd.md#semantic-reviewer` — the current requirement names the 33-case
      discovery corpus and links the report; candidate comparison, repeated trials, multi-defect RV-M02–M06, and
      repair-state scenarios stay target.

## Verification Plan

Automated (no model calls):

- `bun scripts/run-tests.js scripts/reviewer-benchmark`
    - Admission passes for all 17 packages; each new A proof fails with its exact marker, and each B proof passes.
    - The RV-D14 test fails if the `planDeviations` entry is removed or malformed.
    - The cross-file test fails if an RV-D15 or RV-D16 A patch changes every evidence file.
    - `selectCases("all")` returns 33 cases.

Model run (spends model calls):

- `bun scripts/run-reviewer-benchmark.ts run --scenarios all`, then
  `bun scripts/run-reviewer-benchmark.ts score <run-dir>`. `results.jsonl` has a latest attempt for 33 case IDs.

Manual:

- The owner reads the report in code review and gives oracle verdicts and finding labels. The Engineer records them in
  `adjudications.json`, runs `score` again, and updates the report. The report then lists each excluded case under
  fixtures needing repair, and shows semantic scores as `scored` when every counted case is labeled.

Expected results: every case has a result, including failed or timed-out ones. Each A case expects reject and each B
case expects approve. No pass threshold applies.

Behavior that must still be protected: the October baseline report stays unchanged as a historical document;
production Semantic Review is unchanged.

## Edge Cases & Considerations

- **Dirty checkout.** The run happens before the Plan's changes are committed, so the manifest will record
  `dirty: true`, as the October baseline did. The report says so; fixture hashes identify the evaluated fixtures.
- **Credentials.** The run uses the real user home for model credentials. Tests stay on the faux provider.
- **Cost.** 33 rounds at about 45 seconds each, based on the October run. No repeated trials.
- **Model variance.** A single trial can approve or reject by chance. The report states this and claims no rate
  precision.
- **Assumption:** RV-D15 is high severity and RV-D16 is medium. The owner may change either while adjudicating; a
  changed severity is a fixture revision and follow-up work.
