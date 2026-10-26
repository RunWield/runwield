---
planId: "21e30b85-ac1f-4afa-a201-fa23273a7bc7"
classification: "PROJECT"
type: "sequence"
complexity: "HIGH"
affectedPaths:
    - "evals/reviewer/"
    - "scripts/run-reviewer-benchmark.ts"
    - "scripts/reviewer-benchmark/"
    - "docs/evaluation/reviewer-benchmark-scorecard.md"
    - "docs/evaluation/reviewer-benchmark-fixtures.md"
    - "docs/evaluation/reviewer-benchmark-pilot-corpus.md"
    - "docs/evaluation/reviewer-benchmark-results/"
    - "docs/prd/agent-behavior-evaluation-prd.md"
createdAt: "2026-10-24"
origin: "internal"
userVerifiedAt: null
epicCompletionMode: "done_enough"
epicDoneEnoughAt: "2026-10-26T02:45:55.258Z"
epicDoneEnoughSummary: "All 3 child plans are completed after reviewer-benchmark-discovery-pairs/03-context-fixtures-and-full-discovery-run."
workRecord:
    status: "generated"
    recordId: "645f73cc-7766-434f-9efc-86c4622d3fbe"
    path: "docs/work-records/2026-10-26-full-discovery-corpus-and-case-level-benchmark-adjudication.md"
    lastAttemptAt: "2026-10-26T02:46:09.027Z"
status: "verified"
---

# Reviewer Benchmark: All Discovery Pairs

## Context

**Three implementation Plans, reviewed together and executed in order.** The owner asked to expand the Reviewer
benchmark from the nine-case smoke set to every paired discovery scenario in the pilot corpus.

Today the corpus has five packages and nine cases (RV-D04, D05, D12, D13 A/B and RV-M01 A). The remaining **12 pairs,
24 cases**, are drafts in `docs/evaluation/reviewer-benchmark-pilot-corpus.md`: RV-D01–D03, D06–D11, and D14–D16.

The owner decided on 2026-10-24:

- **Build the discovery pairs only.** Multi-defect RV-M02–M06, repair-state RV-R01–R06, repeated trials, and candidate
  comparison stay target.
- **No fixture review before the run.** The Engineer designs the planted defects, clean twins, and proofs. Mechanical
  admission still proves each proof. The owner reviews each fixture **together with** the Reviewer's judgment after
  the run.
- **A bad fixture leaves the scores; it does not freeze the run.** The owner gives each case an oracle verdict. A case
  marked `fixture_needs_repair`, or with a `novel_valid` finding, drops out of every score and appears in a "fixtures
  needing repair" list. The other cases still score.
- **The last Plan runs the benchmark.** One trial of all 33 discovery cases, with a committed report marked pending
  adjudication.

This work changes these capabilities in `docs/prd/agent-behavior-evaluation-prd.md`:

- [Semantic Reviewer](../prd/agent-behavior-evaluation-prd.md#semantic-reviewer) — the current requirement grows from
  the smoke corpus to every admitted discovery package. The `novel_valid` acceptance scenario changes from "freeze
  the run" to "exclude the case".
- [Repeatable scenario runs](../prd/agent-behavior-evaluation-prd.md#repeatable-scenario-runs) and
  [Reports and comparison](../prd/agent-behavior-evaluation-prd.md#reports-and-comparison) — unchanged in kind: one
  configuration, one trial, local report.

## Objective

Run the production Semantic Reviewer on all 16 paired discovery families plus RV-M01, and give the owner one report in
which each case shows the planted defect, its proof, and the Reviewer's decision and findings side by side.

The option set aside was the current rule: one `novel_valid` label freezes semantic scoring for the whole run. With 24
fixtures that nobody reviewed before the run, at least one bad fixture is likely, so the whole run would never score.
The scorecard already says to freeze "that fixture", not the run; the scorer goes beyond that rule today.

## Vertical Slice Findings

The runner already runs the production path. `scripts/reviewer-benchmark/reviewer.ts` calls
`runStandaloneReviewerRound`, which calls `runReviewerRound` in discovery mode, round 1, with an empty ledger. No
product change is needed for any new scenario.

**RV-D14 works on the current path.** The Reviewer receives the Plan through `projectEngineerPlanBody`, which renders
`planDeviations` front matter as `## Approved Plan Deviations`. A fixture Plan with that front matter is enough.

**The smoke corpus is hard-coded in three places.** Each must change before a new package can run:

```text
scripts/reviewer-benchmark/
├── records.ts   # SMOKE_GROUPS: membership + coverage group; readRun rejects other IDs
├── fixtures.ts  # loadFixture: /^RV-(?:D04|D05|D12|D13|M01)$/
└── run.ts       # selectCases / runBenchmark: only SMOKE_GROUPS IDs
```

**Scoring freezes the run.** `semanticScores` in `score.ts` sets status `oracle correction required` when any finding
is `novel_valid`. Labels cover only the Reviewer's findings; there is no way to judge a planted defect or a clean twin.

## Sequence

| Order | Plan                                                                                                                                                                    | Delivers                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | [01-corpus-selection-oracle-verdicts-and-edge-case-fixtures](archived/reviewer-benchmark-discovery-pairs/01-corpus-selection-oracle-verdicts-and-edge-case-fixtures.md) | Corpus-wide selection, coverage group in `scenario.yaml`, oracle verdicts and per-case exclusion, adjudication worksheet; RV-D01, D02, D03, D06 |
| 2     | [02-lifecycle-process-and-publication-fixtures](archived/reviewer-benchmark-discovery-pairs/02-lifecycle-process-and-publication-fixtures.md)                           | RV-D07, D08, D09, D10                                                                                                                           |
| 3     | [03-context-fixtures-and-full-discovery-run](reviewer-benchmark-discovery-pairs/03-context-fixtures-and-full-discovery-run.md)                                          | RV-D11, D14, D15, D16; the paid run of 33 cases; the committed report                                                                           |

## Expected Change Surface

This list is guidance, not an allowlist. Each child Plan verifies the real footprint.

- `evals/reviewer/RV-D01` … `RV-D16` — 12 new fixture packages in the existing package shape.
- `evals/reviewer/*/scenario.yaml` — every package declares its coverage group.
- `scripts/reviewer-benchmark/` and `scripts/run-reviewer-benchmark.ts` — selection, fixture loading, run records,
  scoring, and tests.
- `docs/evaluation/*`, `evals/reviewer/README.md`, `docs/prd/agent-behavior-evaluation-prd.md` — same-change sync.

No product source under `src/` changes. No glossary change: the benchmark terms are not in `docs/domain-language.md`.

## Reuse Opportunities

- The five existing packages under `evals/reviewer/` — package shape, Plan style, proof style, assertion markers.
- `scripts/reviewer-benchmark/admission.ts` — mechanical proof that A fails with its marker and B passes.
- `scripts/reviewer-benchmark/test-fixtures.ts` — `withFixtureCopy`, `publicTree`, faux-provider helpers.

## Verification Plan

Each child Plan carries its own commands. The full gate is `bun run ci`.

### Outcome Evidence

- **Every discovery pair is admitted.** `admitFixtures` passes for 17 packages: proofs fail on A with the declared
  `AssertionError` marker and pass on B. `admission.test.ts` fails when a package under `evals/reviewer/` has no
  expected-count entry.
- **`--scenarios all` selects the whole corpus.** It selects 33 cases from 17 packages without a code edit per
  package.
- **A bad fixture leaves the scores.** For fixed inputs, a case with `fixture_needs_repair` or a `novel_valid` finding
  is absent from decision and semantic denominators and is listed under fixtures needing repair; the remaining cases
  reach status `scored`.
- **The run happened.** `docs/evaluation/reviewer-benchmark-results/2026-10-discovery-pairs.md` records 33 case
  results from one run ID, with configuration identity, fixture hashes, and per-case oracle and findings.
- **PRD scenarios match.** The Semantic Reviewer section in the PRD no longer says `novel_valid` freezes the run; it
  states the per-case rule and the 33-case corpus.

Behavior that must still be protected when all three Plans land:

- Production Semantic Review is unchanged.
- The oracle stays out of the Reviewer's project: no `evaluation/` file, oracle text, or variant label in the tree or
  Git history.
- Failed, timed-out, and missing cases stay in the denominators unless the owner excludes the case.
- Path matches remain suggestions and never earn recall. Resume still refuses a changed fixture or selection.
- `--scenarios smoke` still selects the original nine cases.

Behavior expected to stop existing: the run-wide `oracle correction required` status.

## Edge Cases & Considerations

- **Unreviewed fixtures.** Some fixtures will be wrong. The oracle verdict handles this after the run; repairing a
  flagged fixture is follow-up work, not part of this sequence.
- **Cost.** 33 Reviewer rounds, one trial. The October smoke run took about 7 minutes for 9 rounds.
- **CI time.** Admission tests grow from 5 to 17 packages. Each child Plan reports the added time.
- **Historical baseline.** The October report stays as written. Its saved run can still be scored. Because its
  adjudications have no oracle verdicts, it now scores as `pending adjudication`.
