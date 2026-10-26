---
planId: "6d2ade8f-a262-4b14-a9a3-88ff3f7dbb6e"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "scripts/run-reviewer-benchmark.ts"
    - "scripts/reviewer-benchmark/run.ts"
    - "scripts/reviewer-benchmark/records.ts"
    - "scripts/reviewer-benchmark/fixtures.ts"
    - "scripts/reviewer-benchmark/score.ts"
    - "scripts/reviewer-benchmark/test-fixtures.ts"
    - "scripts/reviewer-benchmark/admission.test.ts"
    - "scripts/reviewer-benchmark/materialize.test.ts"
    - "scripts/reviewer-benchmark/score.test.ts"
    - "evals/reviewer/"
    - "docs/evaluation/reviewer-benchmark-scorecard.md"
    - "docs/evaluation/reviewer-benchmark-fixtures.md"
    - "docs/evaluation/reviewer-benchmark-pilot-corpus.md"
    - "docs/prd/agent-behavior-evaluation-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-24"
origin: "internal"
parentPlan: "reviewer-benchmark-discovery-pairs"
order: 1
dependencies: []
userVerifiedAt: null
targetBranch: "main"
validatedCommit: "e02b77ab57cf2d25f271326e0ab6dc4b3c282d04"
status: "verified"
archivedAt: "2026-10-26T13:44:32.657Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/reviewer-benchmark-discovery-pairs/01-corpus-selection-oracle-verdicts-and-edge-case-fixtures.md"
---

# Corpus Selection, Oracle Verdicts, and Edge-Case Fixtures

## Context

First of three Plans in [Reviewer Benchmark: All Discovery Pairs](../reviewer-benchmark-discovery-pairs.md). Read the
container for the owner's decisions.

This Plan removes the smoke-only limits from the runner, changes scoring so that a bad fixture leaves the scores
instead of freezing the run, and adds the first four new fixture packages: RV-D01, RV-D02, RV-D03, and RV-D06.

Affected PRD capability:
[Semantic Reviewer](../../prd/agent-behavior-evaluation-prd.md#semantic-reviewer). The current requirement and the
`novel_valid` acceptance scenario change. Paired comparison, repeated trials, and repair-state scenarios stay target.

## Objective

After this Plan:

- `bun scripts/run-reviewer-benchmark.ts run --scenarios all` selects every package in `evals/reviewer/`.
- A new fixture package needs no runner code change, only its own directory.
- The owner can give each case an oracle verdict. Bad cases leave the scores; the rest score.
- `summary.md` shows each case's planted defect next to the Reviewer's findings, so the owner judges both together.

## Approach

### Corpus membership comes from the package directory

Today three modules know which scenarios exist. After this Plan, the package directory is the only authority, and the
coverage group moves into the package's own `scenario.yaml`.

```diff
 scenario.yaml
   scenarioId: RV-D05
   track: discovery
+  group: plan-named-edge-case
```

```diff
 selectCases(selection)
-  "smoke" → keys of SMOKE_GROUPS; any other ID must be in SMOKE_GROUPS
+  "smoke" → SMOKE_SCENARIOS = RV-D04, RV-D05, RV-D12, RV-D13, RV-M01
+  "all"   → every evals/reviewer/<id>/ that contains scenario.yaml, sorted by ID
+  IDs     → each must name a corpus package directory
```

The allowed groups are one list in `fixtures.ts`, matching the corpus "Pair coverage" split:
`plan-adherence`, `plan-named-edge-case`, `correctness-beyond-plan`, `cross-file-context`, `architecture`,
`multiple-defects`. `readRun` checks a saved case's group against this list instead of `SMOKE_GROUPS`, so saved runs,
including the October baseline, still load.

The set-aside option was a central registry in `records.ts` that maps every ID to its group. It works, but each new
fixture would need an edit in runner code as well as its package.

### Oracle verdicts exclude a case

`adjudications.json` gains an optional `oracleVerdicts` list. The existing finding labels stay as they are.

```json
{
    "schemaVersion": 1,
    "runId": "…",
    "oracleVerdicts": [
        { "caseId": "RV-D07/A", "verdict": "confirmed" },
        {
            "caseId": "RV-D07/B",
            "verdict": "fixture_needs_repair",
            "note": "Clean twin leaks the child on timeout too."
        }
    ],
    "adjudications": [
        { "caseId": "RV-D07/A", "attempt": 1, "findingIndex": 0, "state": "matched", "defectId": "RV-D07-A" }
    ]
}
```

```text
for each case
  excluded ← verdict is fixture_needs_repair, or any finding is labeled novel_valid
  invalid labels ← verdict is confirmed and a finding is novel_valid
counted cases ← cases not excluded
decision accuracy, clean approval, recall, precision, severe recall, group splits ← counted cases only
semantic status
  pending adjudication  if a counted case has no verdict, or a finding in a counted case has no label
  scored                otherwise
```

Failed, timed-out, and missing cases still count unless the owner excludes them. The status
`oracle correction required` is removed.

### The summary is an adjudication worksheet

Each case section in `summary.md` starts with readable Markdown, before the existing JSON block:

- the fixture package path, `evals/reviewer/<id>/`, and the variant patch path;
- each oracle defect: ID, severity, trigger, expected behavior, wrong behavior, proof command;
- for a clean twin: "Oracle: no defect";
- each blocking finding with its `findingIndex`, title, and suggested path matches;
- the oracle verdict and finding labels when present.

A new section "Fixtures needing repair" lists each excluded case with its reason: the owner's note, or the indexes of
its `novel_valid` findings.

### Four new fixtures

Each package follows `docs/evaluation/reviewer-benchmark-fixtures.md` and the corpus row. The owner does not review
them before the run.

| Package | Group                | Defective A                                        | Clean B                                              | Severity of A |
| ------- | -------------------- | -------------------------------------------------- | ---------------------------------------------------- | ------------- |
| RV-D01  | plan-named-edge-case | Explicit empty selection `[]` becomes all projects | Omitted means all; `[]` means none                   | medium        |
| RV-D02  | plan-named-edge-case | `configured \|\| true` loses explicit `false`      | Absence-aware default keeps `false`                  | medium        |
| RV-D03  | plan-named-edge-case | Empty page ends pagination early                   | Continues until no cursor; refuses a repeated cursor | medium        |
| RV-D06  | plan-named-edge-case | Caller-supplied `role=maintainer` grants mutation  | Authority comes only from the verified capability    | high          |

RV-M01 already contains RV-D02- and RV-D03-style defects. RV-D02 and RV-D03 are separate projects with their own
domain and Plan, not copies of RV-M01's source.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent
— the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows,
or the Verification Plan no longer proves the objective.

- `scripts/reviewer-benchmark/fixtures.ts` — general scenario ID rule, directory-name check, `group` field, the allowed
  group list.
- `scripts/reviewer-benchmark/records.ts` — removes `SMOKE_GROUPS`; `readRun` validates group membership in the list.
- `scripts/reviewer-benchmark/run.ts` — `smoke`, `all`, and ID selection; error text no longer says "smoke case".
- `scripts/run-reviewer-benchmark.ts` — usage text names `all`; the title no longer says smoke only.
- `scripts/reviewer-benchmark/score.ts` — oracle verdicts, per-case exclusion, worksheet, removal of the run-wide
  freeze.
- `scripts/reviewer-benchmark/test-fixtures.ts` — corpus IDs read from the directory instead of `smokeIds`.
- `scripts/reviewer-benchmark/*.test.ts` — admission, leak, selection, and scoring coverage for the whole corpus.
- `evals/reviewer/RV-D04|D05|D12|D13|M01/scenario.yaml` — `group` field only. Fixture revisions do not change.
- `evals/reviewer/RV-D01`, `RV-D02`, `RV-D03`, `RV-D06` — new packages.
- `evals/reviewer/README.md` and `docs/evaluation/*.md`, `docs/prd/agent-behavior-evaluation-prd.md` — same-change
  documentation.

## Reuse Opportunities

- `evals/reviewer/RV-D05/` — closest model for a single-defect pair: Plan, `AGENTS.md`, public tests, proof style.
- `scripts/reviewer-benchmark/admission.ts` `admitFixtures` — unchanged; it already proves any pair.
- `scripts/reviewer-benchmark/score.ts` `applyAdjudications` — extend its validation style for `oracleVerdicts`.
- `scripts/reviewer-benchmark/test-fixtures.ts` `withFixtureCopy` — broken-fixture tests on a copy.

## Implementation Steps

1. `fixtures.ts` exports the allowed coverage groups. `loadFixture` accepts a scenario ID that matches
   `^RV-(?:D|M)\d{2}$` and equals the package directory name. It requires `group` in `scenario.yaml` to be one of the
   allowed groups. The hard-coded five-ID pattern no longer exists.
2. Each existing `scenario.yaml` declares the group that `SMOKE_GROUPS` gave it: RV-D04 `correctness-beyond-plan`,
   RV-D05 `plan-named-edge-case`, RV-D12 `architecture`, RV-D13 `plan-adherence`, RV-M01 `multiple-defects`. No other
   fixture file changes, and no `fixtureRevision` changes.
3. `SMOKE_GROUPS` no longer exists. `runBenchmark` takes each case's group from the fixture manifest. `readRun`
   accepts a saved case whose group is in the allowed list and whose ID matches the scenario ID rule.
4. `selectCases("smoke")` returns the nine original cases. `selectCases("all")` returns every case of every package
   directory under `evals/reviewer/` that has a `scenario.yaml`, ordered by scenario ID then variant. An ID or
   `ID/variant` that names no package fails with an "Unknown case" error before admission.
5. `adjudications.json` accepts an optional `oracleVerdicts` list of `{ caseId, verdict, note? }`, where `verdict` is
   `confirmed` or `fixture_needs_repair`. Scoring stops with an invalid-label error for an unknown case, a duplicate
   verdict for one case, an unknown verdict value, or a `confirmed` verdict on a case that has a `novel_valid` finding.
6. A case is excluded when its verdict is `fixture_needs_repair` or any of its findings is labeled `novel_valid`.
   Decision accuracy, clean approval, variant and group splits, recall, precision, and severe-defect recall use only
   cases that are not excluded. Semantic status is `pending adjudication` while a counted case has no verdict or a
   finding in a counted case has no label, and `scored` otherwise. `oracle correction required` no longer exists in
   `SemanticScores` or the Markdown.
7. `summary.json` lists excluded cases with their reasons. `summary.md` has a "Fixtures needing repair" section and,
   for each case, the readable worksheet described in Approach before the JSON block.
8. Packages `RV-D01`, `RV-D02`, `RV-D03`, and `RV-D06` exist under `evals/reviewer/` with `source/`, `variants/`
   (`defective.patch`, `clean.patch`), `evaluation/` (`oracle.yaml`, `proofs.ts`), and `scenario.yaml`
   (`fixtureRevision: 1`, the group in the Approach table).
    - Each `source/` is a Bun 1.4.3 TypeScript project with three to eight production modules, `tests/public.ts`,
      `AGENTS.md`, `README.md`, and an approved Plan. The Plan reads like a real request, names the edge case the corpus
      row says it names, and does not name the defect or the fix.
    - The public suite passes for A and B.
    - The clean twin keeps the tempting shape (a default, a fallback, a role parameter) and handles it correctly.
    - Each A defect has a stable `defectId`, severity from the Approach table, category, trigger, expected and wrong
      behavior, evidence paths, acceptable concepts, near misses, and one proof with an `RV-…` assertion marker.
9. `admission.test.ts` has expected check counts for every corpus package, and fails when a package directory under
   `evals/reviewer/` has no entry. Admission passes for all nine packages.
10. The leak test in `materialize.test.ts` runs for every corpus package: no `evaluation/` file, no oracle text, and no
    variant label in file names, branch names, or `git log`; the review diff equals the variant patch.
11. Documents match the delivered behavior:
    - `evals/reviewer/README.md` — title "Reviewer fixtures"; the package table includes the new packages; `--scenarios
all`; the adjudication section explains `oracleVerdicts`, case exclusion, and the worksheet; no "after the owner
      approves the fixtures" precondition.
    - `docs/evaluation/reviewer-benchmark-fixtures.md` — `scenario.yaml` has `group`; admission step 6 says the owner
      judges each fixture together with the Reviewer's result after the run, and an excluded case does not score until
      a revised fixture runs again.
    - `docs/evaluation/reviewer-benchmark-scorecard.md` — the current-scope section covers the whole admitted corpus;
      the adjudication section describes oracle verdicts and per-case exclusion.
    - `docs/evaluation/reviewer-benchmark-pilot-corpus.md` — status table shows RV-D01–D03 and D06 materialized; the
      "human review before paid execution" rule is replaced by post-run oracle verdicts.
    - `docs/prd/agent-behavior-evaluation-prd.md#semantic-reviewer` — the current requirement names every admitted
      package and the `all` selection. The acceptance scenario "Given a `novel_valid` label, semantic scores freeze until
      the oracle is corrected" is replaced by: "Given a `fixture_needs_repair` verdict or a `novel_valid` label on a
      case, that case leaves every score and is listed as needing repair, and the other cases still score." A new
      scenario: "Given a counted case without an oracle verdict, semantic scores stay pending." Target items stay
      target.

## Verification Plan

Automated (focused, no model calls):

- `bun scripts/run-tests.js scripts/reviewer-benchmark`
    - **Selection.** `selectCases("all")` returns 17 cases (nine smoke cases plus four new pairs) in ID order;
      `selectCases("smoke")` returns the same nine cases as before; `selectCases("RV-D99")` fails before admission.
      The test builds its expected `all` list independently from `readdir` of `evals/reviewer/` and each oracle's
      variants. Plans 2 and 3 then add eight packages with no change to `run.ts`, `fixtures.ts`, or `records.ts`, which
      proves selection is not a hard-coded list.
    - **Exclusion scoring.** For fixed results and labels: a case with `fixture_needs_repair`, and another with a
      `novel_valid` finding, are absent from decision accuracy, clean approval, recall, and precision denominators and
      appear under fixtures needing repair; the remaining fully labeled cases reach `scored` with exact ratios. A
      `confirmed` verdict on a `novel_valid` case stops scoring. A counted case without a verdict leaves status
      `pending adjudication`.
    - **Protected scoring.** Path-only matches still earn no recall. Failed and missing cases that are not excluded
      stay in the denominators. Duplicate labels still require a matched primary.
    - **Old runs.** A saved manifest in the October format (groups as recorded then, no `oracleVerdicts`) still loads
      and scores to `pending adjudication`.
    - **Admission and leaks.** Admission passes for all nine packages; a corpus package without an expected-count entry
      fails the test; leak checks pass for all nine packages.
- `bun scripts/run-tests.js scripts/reviewer-benchmark/cli.test.ts` — `--help` names `all`.
- `bun run seams:check` — passes with no baseline change.

Manual:

- Read the four new Plans in `evals/reviewer/RV-D0{1,2,3,6}/source/docs/plans/`. None names the planted defect or its
  fix.
- Score a fixture run directory built by the score tests and read `summary.md`: each case shows the oracle defect next
  to its findings.

Behavior that must still be protected: production Semantic Review is unchanged; `validation-loop-review.test.js` and
`review-contract.test.ts` pass without weakened assertions; resume still refuses a changed fixture, selection, or
timeout. Behavior expected to stop existing: `SMOKE_GROUPS`, the five-ID pattern, and the run-wide
`oracle correction required` status.

## Edge Cases & Considerations

- **Group field changes fixture hashes.** The five existing packages get new hashes, so an old run cannot resume
  against them. Scoring old runs still works. Revisions stay unchanged because no oracle, patch, or source changed.
- **Excluding before verdicts.** A `novel_valid` label excludes its case even before the owner gives verdicts. This is
  intended: the oracle is known to be wrong.
- **Both twins excluded.** A pair can lose one or both cases. Group splits then show smaller denominators; the
  worksheet shows why.
- **CI time.** Report the change in `scripts/reviewer-benchmark` test time in the execution report.
- **Assumption:** `oracleVerdicts` is an optional field in schema version 1, not a schema version bump. An October
  adjudications file stays valid.
