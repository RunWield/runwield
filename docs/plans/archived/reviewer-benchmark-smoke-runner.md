---
planId: "9b31bb6d-caba-4f4c-9756-84c06b071667"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "scripts/run-reviewer-benchmark.ts"
    - "scripts/reviewer-benchmark/"
    - "evals/reviewer/"
    - "scripts/bun-test-files.json"
    - "scripts/run-tests.js"
    - "src/shared/workflow/validation-semantic.ts"
    - "docs/evaluation/reviewer-benchmark-scorecard.md"
    - "docs/evaluation/reviewer-benchmark-fixtures.md"
    - "docs/evaluation/reviewer-benchmark-pilot-corpus.md"
    - "docs/prd/agent-behavior-evaluation-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-19"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "e355c7fb490e30872339c5043114167dc7c9f382"
workRecord:
    status: "generated"
    recordId: "e301c9e7-8eb4-495a-819d-bd85374ad38b"
    path: "docs/work-records/2026-10-24-production-reviewer-benchmark-and-baseline.md"
    lastAttemptAt: "2026-10-24T03:59:46.788Z"
status: "verified"
archivedAt: "2026-10-26T02:43:51.801Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/reviewer-benchmark-smoke-runner.md"
---

# Reviewer Benchmark Smoke Runner

## Context

We have no measurement of the Semantic Reviewer's judgment. The Reviewer decides what every Engineer change must
satisfy, so a weak prompt affects all work. The owner decided (2026-10-19):

- Reviewer quality is measured by the **Reviewer benchmark**, plus field metrics from the future SaaS Workspace.
- RunWield Core gets no per-finding user verdicts.
- Build a **small Reviewer-only runner now**. Do not wait for the shared End-to-End Benchmark Harness.
- The code review decision metric already landed as a Quick Fix. It is not part of this Plan.

The benchmark design already exists as proposed documents:

- `docs/evaluation/reviewer-benchmark-scorecard.md` — measures, adjudication states, repetition rules.
- `docs/evaluation/reviewer-benchmark-fixtures.md` — fixture package shape, hidden oracle, admission rules.
- `docs/evaluation/reviewer-benchmark-pilot-corpus.md` — 44 proposed scenarios, none materialized.

This Plan affects these PRD capabilities in `docs/prd/agent-behavior-evaluation-prd.md`, all **Target** today:

- [Semantic Reviewer scorecard](../prd/agent-behavior-evaluation-prd.md#semantic-reviewer) — this Plan delivers a
  one-trial baseline smoke run for a subset of the measures.
- [Repeatable scenario runs](../prd/agent-behavior-evaluation-prd.md#repeatable-scenario-runs) — this Plan delivers
  isolation, oracle hiding, prerequisite checks, and resume for the Reviewer only.
- [Reports and comparison](../prd/agent-behavior-evaluation-prd.md#reports-and-comparison) — this Plan delivers a
  local report for one configuration. Paired comparison stays target.

The shared End-to-End Benchmark Harness stays target. This runner is an interim, Reviewer-only owner that the shared
harness can absorb later.

> [!NOTE]
> **The owner reviews the corpus before execution**
>
> The owner reviews the pilot corpus on 2026-10-19. If that review changes a smoke scenario, update the scenario list
> in this Plan before execution starts.

## Objective

Run the real Semantic Reviewer, with its production prompt, tools, and `review_complete` path, against nine fixture
projects with known answers. Produce a scored baseline report.

The smoke set (owner-approved):

| Scenario     | Tests                                                     |
| ------------ | --------------------------------------------------------- |
| RV-D04 A / B | Correctness that the Plan does not name (cache isolation) |
| RV-D05 A / B | High-severity defect; clean twin tests restraint          |
| RV-D12 A / B | RunWield architecture rule (injection seam)               |
| RV-D13 A / B | Plan adherence (a missing Plan step)                      |
| RV-M01       | Two independent defects in one change                     |

Each scenario runs one trial. Repair-state scenarios (RV-R\*) are out of scope, so the runner does not need to seed a
Review Issue Ledger yet.

## Approach

The runner calls the exported production function `runReviewerRound` in `src/shared/workflow/validation-semantic.ts`.
That function owns the Reviewer session, the `review_diff` inspection gate, nudges, and `review_complete`. It writes
no Plan and no Delivery Evidence. Those writes happen only in `runSemanticReviewPhase`, which the runner does not call.

```text
run-reviewer-benchmark.ts run --scenarios <set>
  check prerequisites (fixtures admitted, model reachable)   # before any model call
  for each scenario
    materialize project in a temp dir                        # source + selected variant only
      commit baseline on `main` (neutral message)
      branch `change`, apply variant patch
    diff = getWorktreeReviewDiff(projectDir, "main")         # same diff as production
    runReviewerRound(args, context, round 1 state, "discovery", diff)
      -> real Reviewer subagent, review_diff, review_complete
    save result record (outside the project), then delete the project
run-reviewer-benchmark.ts score <run-dir>
  read results + optional adjudications.json -> summary.md
```

**Configuration identity is the RunWield checkout.** Agent definitions load from the source tree that runs the
script. To compare a candidate prompt later, run the same command from a second checkout. The report records the
RunWield revision, a dirty flag, and hashes of `reviewer-prompt.md` and `shared-practice/review-practice.md`.

**Scoring stays honest about judgment.** The runner scores the decision (reject the defective variant, approve the
clean twin) mechanically. It marks a finding as a _suggested_ match when its evidence cites an oracle evidence path.
Recall, precision, and severe-defect recall count only findings that a human adjudicated in `adjudications.json`, using
the scorecard states `matched`, `duplicate`, `unsupported`, and `novel_valid`. A model judge is out of scope.

Option set aside: a generic "send the diff to a model" script. It is cheaper to build, but it would not measure the
product Reviewer, its inspection gate, or its completion protocol.

> [!WARNING]
> **The oracle must stay out of the Reviewer's reach**
>
> The Reviewer has `read`, `grep`, and `find`. The materialized project must contain no `evaluation/` content, no
> variant name, no hidden proof test, and no revealing Git history. The temp project lives outside the RunWield
> checkout, and nothing in it points back to `evals/`. A Reviewer that guesses an absolute path into the RunWield
> checkout could still read it. We accept that residual risk for the smoke run.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent
— the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows,
or the Verification Plan no longer proves the objective.

```text
evals/reviewer/
├── RV-D04/ RV-D05/ RV-D12/ RV-D13/ RV-M01/
│   ├── source/        # Bun TypeScript project + Approved Plan, copied into the temp project
│   ├── variants/      # defective.patch, clean.patch (M01: defective only)
│   ├── evaluation/    # oracle.yaml, hidden proof tests — never copied
│   └── scenario.yaml  # non-secret manifest
scripts/
├── run-reviewer-benchmark.ts        # CLI: run, score
└── reviewer-benchmark/              # materialize, run round, score, report modules + tests
```

- `evals/reviewer/` — new fixture corpus. The location is an assumption; the fixture contract names only
  `reviewer/<scenario-id>/`.
- `scripts/run-reviewer-benchmark.ts` and `scripts/reviewer-benchmark/` — the runner. This follows the Router golden-set
  runner convention of evaluation code under `scripts/`.
- `scripts/run-tests.js`, lint, type-check, and seam-check discovery — the fixture projects contain intentionally
  defective code and their own `*.test.ts` files. RunWield CI must not run or lint them as RunWield source.
- `scripts/bun-test-files.json` — registers the new runner tests.
- `src/shared/workflow/validation-semantic.ts` — touched only if `runReviewerRound` cannot run without a product
  change. Any change must keep production behavior and must not add an injection seam.
- `docs/evaluation/*.md` and `docs/prd/agent-behavior-evaluation-prd.md` — record the delivered interim runner, the Bun
  fixture shape, and the materialized smoke scenarios.

No glossary change: this Plan does not make the proposed terms "Agent Behavior Evaluation" or "End-to-End Benchmark
Harness" true.

## Reuse Opportunities

- `src/shared/workflow/validation-semantic.ts` — `runReviewerRound`, `buildSemanticReviewAttempt`.
- `src/shared/workflow/validation-session-adapter.ts` — `createValidationSessionPort` with a real `HostedSession`.
- `src/shared/git-snapshot.ts` — `getWorktreeReviewDiff` produces the production review diff.
- `src/shared/workflow/execution-metrics.ts` — `model_usage`, tool-call, and `execution_finished` events give tokens,
  tool calls, and elapsed time. Enable `workflowMetrics` in the temp project's settings so the journal is keyed to that
  project root, then read it.
- `scripts/run-router-golden-set.js` — checkpoint-after-each-row and resume pattern. Do **not** copy its optional
  `runAgentSession ? fake : real` branch.
- `scripts/run-router-golden-set-settings.test.ts` — `withRuntimeCommandFixture` with the faux provider for runner
  tests.
- `src/ui/tui/golden-scenarios/` and `scenario-runner.js` `registerFauxProvider` — scripted model tool calls that still
  run the real `review_diff` and `review_complete` code.
- `src/shared/git-test-fixture.ts` — `defineGitFixture` for real Git repositories in tests.

## Implementation Steps

1. Each smoke scenario (RV-D04 A/B, RV-D05 A/B, RV-D12 A/B, RV-D13 A/B, RV-M01) exists under `evals/reviewer/<id>/`
   as `source/`, `variants/`, `evaluation/`, and `scenario.yaml`, following `docs/evaluation/reviewer-benchmark-fixtures.md`
   and the corpus rows in `docs/evaluation/reviewer-benchmark-pilot-corpus.md`.
    - Each `source/` is a small Bun TypeScript project with three to eight production modules, public tests, and an
      Approved Plan that reads like a real request and does not name the seeded defect or fix.
    - Each `evaluation/oracle.yaml` has, for every defect: a stable `defectId`, `severity`, category, trigger,
      expected and wrong behavior, evidence paths, acceptable concepts, and a proof command. Clean twins have
      `expectedDecision: approve` and an empty `defects` list.
    - RV-D12 B uses real fixtures and only genuine external ports. RV-M01 contains the RV-D02 and RV-D03 defects as two
      independent oracle defects.
2. A fixture admission check proves every smoke fixture: for each oracle defect, its hidden proof fails on the
   defective variant for the stated reason and passes on the clean twin; for RV-M01 each of the two proofs fails on its
   own. A fixture that fails admission makes `run` stop before any model call.
3. Materialization produces a temp project outside the RunWield checkout whose files are only `source/` plus the
   selected variant, with a `main` baseline commit and the variant change on branch `change`. Commit messages, branch
   names, and file names contain no variant label, defect identity, or oracle text. The project's `.wld/` settings do
   not appear in the review diff.
4. `bun scripts/run-reviewer-benchmark.ts run` runs `runReviewerRound` in discovery mode, round 1, with an empty
   ledger, using a real `HostedSession` and `createValidationSessionPort`. It does not reimplement the Reviewer prompt,
   the review tools, or the completion protocol.
    - Options: `--scenarios` (ids or `smoke`), `--model` (default: the effective configured Reviewer model),
      `--timeout-ms`, `--out <dir>`, `--resume`.
    - A missing model, missing credentials, or a failed admission is reported before any model call.
5. Each run writes `results.jsonl` under `~/.wld/reviewer-eval/<run-id>/` (or `--out`) after each scenario, so
   `--resume` keeps completed scenarios. Each record holds:
    - scenario, variant, fixture revision, and trial number;
    - expected and observed decision, and the protocol outcome: `complete`, `paused`, `failed`, or `timeout`;
    - findings and advisories exactly as `review_complete` returned them, and the number of nudge attempts;
    - model and provider as actually used by the run, tokens, tool-call count, and elapsed time — `unavailable`
      when the source has no value, never an estimate;
    - RunWield revision, dirty flag, and hashes of `reviewer-prompt.md` and `shared-practice/review-practice.md`.
6. A timeout, pause, provider error, or harness error settles that scenario, stays in the report denominator with its
   cause, and the next scenario starts from a fresh temp project.
7. `bun scripts/run-reviewer-benchmark.ts score <run-dir>` writes `summary.md` and `summary.json` with:
    - decision accuracy for each variant and the clean approval rate;
    - suggested finding matches by evidence path, labeled as suggestions;
    - when `adjudications.json` exists: defect recall, blocking-finding precision, and severe-defect recall from
      adjudicated findings only; otherwise those measures show `pending adjudication`;
    - the split by group from the corpus (Plan adherence, correctness not named by the Plan, architecture, multiple
      defects), with every failed or timed-out scenario shown.
8. RunWield's own `bun run test`, `bun run ci`, lint, type check, format check, and `seams:check` do not run or analyze
   the code inside `evals/reviewer/*/source`, `variants`, or `evaluation`. The runner code under `scripts/` is checked
   normally.
9. Runner tests under `scripts/reviewer-benchmark/` are registered in `scripts/bun-test-files.json` and cover the
   behavior in the Verification Plan. They use the faux provider; they make no real model call.
10. The baseline smoke run is complete: one trial of the nine scenarios with the effective configured Reviewer model.
    `docs/evaluation/reviewer-benchmark-results/2026-10-baseline-smoke.md` holds the scored summary, the model and
    provider, the RunWield revision, and the prompt hashes. Suggested matches are listed for the owner to adjudicate in
    code review. If the model cannot be reached, the file is not written; the execution report names the setup
    failure.
11. The documents match the delivered state:
    - `docs/evaluation/reviewer-benchmark-scorecard.md` and `reviewer-benchmark-fixtures.md` name the Reviewer-only
      runner as the current interim runner, and keep the shared harness as target.
    - `docs/evaluation/reviewer-benchmark-pilot-corpus.md` marks the nine smoke scenarios as materialized and the rest
      as draft.
    - `docs/prd/agent-behavior-evaluation-prd.md` Semantic Reviewer section states the one-trial baseline smoke run
      as current, and keeps paired comparison, repetitions, repair-state scenarios, and the shared harness as target.

## Verification Plan

Automated (focused):

- `bun scripts/run-tests.js scripts/reviewer-benchmark` — runner tests:
    - **Production path.** A faux-provider Reviewer that calls `review_complete` before reading the diff is refused by
      the real inspection gate, and the record shows a nudge. A faux Reviewer that reads the diff and rejects with one
      finding produces a record with that exact finding. This fails if the runner bypasses `runReviewerRound` or fakes
      `review_complete`.
    - **No leak.** A materialized project for every smoke scenario has no `evaluation/` file, no file or text from
      `oracle.yaml`, and no variant label in file names, branch names, or `git log`. Its review diff equals the
      selected variant patch.
    - **Admission.** For every smoke fixture, the hidden proof fails on the defective variant and passes on the clean
      twin. A deliberately broken test fixture (proof passes on both) makes `run` stop before any model call.
    - **Failure containment and resume.** A faux Reviewer that never completes times out; the next scenario still
      runs from a fresh project; `--resume` skips completed scenarios and reruns the unfinished one.
    - **Scoring.** For fixed result and adjudication inputs, `score` computes the exact recall, precision, clean
      approval, and severe-defect recall values. A defect that is only path-matched does not count as recall.
- `bun run seams:check` passes with no baseline change.
- `bun run test` still passes and does not discover any `*.test.ts` under `evals/reviewer/`.

Manual:

- The owner inspects each smoke fixture's Plan, diff, and oracle before the smoke run, as admission step 6 of the
  fixture contract requires.
- The owner reads `docs/evaluation/reviewer-benchmark-results/2026-10-baseline-smoke.md` and adjudicates suggested
  matches in code review.

Expected results:

- Every smoke scenario has a record, including failed or timed-out ones.
- Each defective variant has an expected decision of reject; each clean twin an expected decision of approve. The
  smoke run reports how the baseline Reviewer actually did. No threshold applies: the scorecard sets none before a
  baseline exists.

Behavior that must still be protected: production Semantic Review is unchanged. Existing validation tests for
`runReviewerRound` and `review_complete` (`src/shared/workflow/validation-loop-review.test.js`,
`src/shared/workflow/review-contract.test.ts`) keep passing without edits that weaken them.

## Edge Cases & Considerations

- **Cost.** One trial of nine rounds is small. Do not run three trials or the full corpus in this Plan.
- **Model drift.** One trial cannot show stability. The report says so and does not claim a rate with precision.
- **Credentials.** The run uses the real user home for model credentials. Tests use a disposable home and the faux
  provider.
- **Fixture realism.** A defect that is obvious without repository context makes recall look high. Follow the
  corpus rule of three to eight modules, so that a cross-file contract carries the defect.
- **Clean twins.** A clean twin must keep the tempting shape (fallback, cache, port), or clean approval proves nothing.
- **`novel_valid` findings.** If the Reviewer finds a real defect that the oracle missed, the owner updates the oracle
  before scoring that scenario, as the scorecard requires.
- **Assumption:** the corpus lives at `evals/reviewer/`. Moving it is a cheap rename.
- **Assumption:** results go to `~/.wld/reviewer-eval/`, like the Router runner's `~/.wld/router-eval/`. Only the
  scored summary of synthetic fixtures is committed.

### Candidate comparison

> **Question (candidate-scope):** Does this Plan run only the current Reviewer (baseline), or also write the Review Reconnaissance candidate prompt and compare both?
>
> **Answer:** Baseline only. The runner can compare a second checkout later; the candidate prompt is a follow-up Plan. (answered in review)

My recommendation is baseline only. The first run proves that the fixtures and runner work. If the baseline already
catches every smoke defect and approves every clean twin, the smoke set cannot show a candidate improvement, and the
next step is harder fixtures, not a new prompt.
