# Reviewer Benchmark Scorecard

## Purpose

Measure whether RunWield's Semantic Reviewer finds real defects without manufacturing objections, and whether its
verification rounds track repairs accurately. The benchmark compares the current discovery prompt with candidate Review
Reconnaissance behavior through the normal isolated Reviewer Session, tools, and structured completion path.

The current interim runner is Reviewer-only: `bun scripts/run-reviewer-benchmark.ts`. It runs the production
Reviewer through `runReviewerRound`, not a generic model request. It does not replace Workflow Validation or add
passive product telemetry. The shared End-to-End Benchmark Harness remains target.

## Current Smoke Scope

Five packages under `evals/reviewer/` provide nine discovery cases: RV-D04 A/B, RV-D05 A/B, RV-D12 A/B, RV-D13 A/B,
and RV-M01 A. The smoke run uses one trial per case and the effective configured Reviewer model. It does not author
or compare a reconnaissance candidate.

The runner scores decision accuracy and clean approval mechanically. Evidence-path matches are suggestions only.
Defect recall, blocking-finding precision, and severe-defect recall require human labels in `adjudications.json`.
Missing or partial labels keep semantic scores pending; `novel_valid` freezes them until oracle correction. Failures
and missing cases stay in denominators. Reports split decisions and semantic measures by coverage group.

Results retain actual model/provider identity, prompt hashes, fixture hashes, checkout revision and dirtiness,
findings, advisories, usage, elapsed time, tool calls, and nudges. Missing measurements say `unavailable`. Model-turn
counts, inspection breadth, repair-state scoring, repetitions, and paired comparison remain target.

The [2026-10-23 baseline](reviewer-benchmark-results/2026-10-baseline-smoke.md) completed all nine rounds: mechanical
decision accuracy 7/9, defective rejections 5/5, and clean approval 2/4. The owner accepted all 13 blocking findings.
Six match the original oracle; seven require oracle corrections, including
an independent RV-D12 concern formerly bundled under one id. Semantic scoring remains frozen against the historical
oracle. Four packages are now revision 2, with no new paid measurements. The clean rejections were not automatically
false positives.

See [run and adjudication instructions](../../evals/reviewer/README.md#run-and-score).

## Evaluated Configurations

The smoke run measures the baseline only. The planned paired experiment compares two configurations:

1. **Baseline** — the current Semantic Reviewer discovery and verification prompts.
2. **Candidate** — the same Reviewer with a first-discovery reconnaissance pass that:
    - explains the changed behavior and its input, environment, state, and surrounding-code assumptions;
    - searches adversarially for failure modes;
    - carries only confirmed defects and still-plausible risks into the verdict;
    - suppresses every risk it rules out.

Keep the model, provider, tools, Plan, repository revision, Runtime settings, and sampling settings equal. Randomize
configuration order within each fixture repetition so provider drift or warm-cache order does not consistently favor one
prompt.

## Benchmark Unit

One scored unit is one Reviewer round over:

- an Approved Plan;
- a baseline tree and candidate implementation tree;
- the production `review_diff` surface;
- normal read-only repository tools;
- a hidden oracle that the evaluated Reviewer cannot access.

Discovery fixtures run from an empty Review Issue Ledger. Repair fixtures begin with a supplied ledger, repair report,
and repair-scoped diff. They exercise the production verification prompt instead of asking a generic model to describe
whether a patch looks fixed.

## Output Policy

- A blocking finding must describe a concrete defect and cite repository evidence.
- A plausible risk may become a non-blocking test suggestion or advisory when evidence is incomplete.
- A ruled-out risk is omitted completely. It is not stored, displayed, scored, or counted as diligence.
- Approval prose and stylistic similarity to a reference answer are not quality measures.
- One defect reported several ways earns one match; the extra findings are duplicate noise.

## Primary Measures

### Defect recall

The fraction of distinct oracle defects matched by at least one supported finding:

`matched oracle defects / all oracle defects`

Report recall by defect family and severity. Critical and high-severity misses remain visible even when aggregate recall
is good.

### Blocking-finding precision

The fraction of blocking findings that match a real oracle defect or are adjudicated as a novel valid defect:

`supported unique findings / all blocking findings`

Unsupported findings and duplicate restatements reduce precision. A Reviewer cannot improve by producing a large list
around one correct observation.

### Clean approval rate

The fraction of clean twins approved without a blocking finding:

`approved clean variants / all clean variants`

This is the primary check against an adversarial prompt that rejects any code containing a suspicious-looking branch,
fallback, retry, cache, or concurrent operation.

### Severe-defect recall

Report critical and high-severity defect recall as its own release measure. Do not let several easy low-severity matches
offset a missed destructive, authorization, data-isolation, or lifecycle-authority defect.

### Repair-state accuracy

For every prior ledger item, score whether the Reviewer correctly classifies it as resolved or still open. Score new
regressions introduced by a repair as discovery recall and precision in the same round.

## Secondary Measures

- **Evidence accuracy** — the finding cites the changed file or behavioral boundary that contains the cause.
- **Causal accuracy** — the finding explains the trigger and wrong result, not only a downstream symptom.
- **Multi-defect completeness** — all independent defects are found before the Reviewer completes the round.
- **Advisory precision** — advisories are supported, relevant, and non-duplicative.
- **Protocol reliability** — the Reviewer inspects the diff and calls `review_complete` with valid, complete arguments.
- **Inspection breadth** — files and hunks inspected, retained only as a diagnostic rather than a quality target.
- **Cost** — input/output tokens, elapsed time, model turns, tool calls, and corrective nudges.
- **Stability** — per-fixture agreement across repetitions, including defects found in every trial rather than only
  once.

Inspection breadth is not rewarded by itself. Reading more files is valuable only when it improves supported findings.

## Finding Adjudication

Each emitted blocking finding receives one state:

- `matched` — describes an oracle defect's trigger and wrong behavior;
- `duplicate` — repeats a defect already matched in the same round;
- `unsupported` — no concrete defect can be established from the fixture;
- `novel_valid` — establishes a real defect that the oracle omitted.

Mechanical matching may use expected paths, spans, structured lifecycle decisions, and verifier outcomes. Semantic
equivalence requires a blinded human decision or a separately reported model-judge annotation. A model judge never
overrides deterministic proof.

When a finding appears novel and valid, freeze scoring for that fixture. A human updates the oracle first, then both
baseline and candidate outputs are rescored against the same corrected truth. Do not amend the oracle only for the
configuration that found the defect.

## Repetitions and Comparison

- For the full paired pilot, run at least three independent trials per fixture and configuration. The current
  one-trial smoke run establishes neither stability nor a candidate improvement.
- Keep every timeout, interruption, invalid tool result, and infrastructure failure in the report denominator.
- Compare paired per-fixture deltas before aggregate averages.
- Report confidence intervals or paired bootstrap intervals once the corpus is large enough; do not imply precision from
  a small pilot.
- Record model/provider version, Agent Definition hash, candidate prompt hash, fixture revision, and harness revision.

Report both average trial behavior and strict stability, such as a defect found in all three trials. Do not use a
best-of-three score as the release result.

## Candidate Decision

The pilot does not set universal numeric thresholds before a baseline exists. It answers whether the candidate moves the
Reviewer in the intended direction.

The reconnaissance candidate is acceptable for broader evaluation only when:

- blocking-finding precision and clean approval do not materially regress;
- recall improves on assumption, boundary, integration, concurrency, or error-path defects;
- severe misses do not increase;
- verification-round defect-state accuracy does not regress;
- additional latency and token cost are proportionate to the improvement;
- no new protocol-completion failure appears.

Keep each release measure separate. A weighted total or F-score may be shown as a convenience, but it cannot waive a
precision collapse, a severe miss, or a clean-approval regression.

## Pilot Size

The reviewable pilot catalog contains:

- 16 discovery families, each with a defective and clean twin: 32 scenarios;
- 6 multi-defect discovery scenarios;
- 6 repair-state verification scenarios.

That produces 44 scenarios. Two prompt configurations with three trials each require 264 Reviewer rounds. Start with a
one-trial smoke pass before spending the full model budget.

## External Methodology References

- [SWR-Bench](https://arxiv.org/abs/2509.01494) uses Pull Request-level full-project context and evaluates coverage of
  independently verified review issues instead of prose overlap.
- [CR-Bench](https://arxiv.org/abs/2603.11078) emphasizes the trade-off between issue resolution and spurious findings,
  which is why this scorecard keeps recall and precision separate.
- [MCR-Bench](https://arxiv.org/abs/2608.27442) evaluates defect state across multi-round review, which informs the
  separate repair-state track.

External corpora can later become adapters. The WLD-native pilot remains necessary because public benchmarks do not
cover Approved Plan adherence, Review Issue Ledger identity, RunWield lifecycle authority, or focused repair behavior.
