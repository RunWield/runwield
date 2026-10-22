# Reviewer Benchmark Fixture Contract

## Goal

Define review fixtures whose repository context is realistic, whose expected defects are independently provable, and
whose oracle cannot leak into the evaluated Reviewer's tools or prompt.

The fixture contract belongs to the Reviewer evaluator. The common benchmark runner owns isolation, execution, timeouts,
repetition, result capture, and baseline comparison.

## Package Boundary

Each materialized fixture package has three parts:

```text
reviewer/<scenario-id>/
  source/                 files copied into the isolated project
  variants/               patches selected by the runner, never copied as labelled data
  evaluation/             hidden oracle, verifier, and adjudication notes
```

Only the selected `source/` tree plus its selected variant becomes the Reviewer's project. The evaluated Agent must not
be able to read:

- the `evaluation/` directory;
- variant names such as `defective` or `clean`;
- expected findings, defect identities, categories, or severities;
- hidden proof tests or fixing patches;
- corpus prose that describes the intended trap;
- Git history or commit messages that reveal the later fix.

The runner records the internal variant identity outside the project and presents an ordinary baseline-to-candidate diff
through `review_diff`.

## Scenario Manifest

The non-secret scenario manifest records execution facts:

```yaml
scenarioId: RV-D01
track: discovery
fixtureRevision: 1
projectTemplate: optional-project-selection
planPath: docs/plans/add-project-filter.md
baselineRef: baseline
candidateRef: candidate
language: typescript
tags:
    - empty-input
    - defaulting
timeoutMs: 120000
```

The manifest may describe how to build the project, but it must not state whether the selected candidate is correct.
Variant selection and expected truth stay in the harness-side batch definition and oracle.

## Hidden Oracle

The hidden oracle records the minimum truth needed to score the scenario:

```yaml
scenarioId: RV-D01
variantId: empty-selection-defect
expectedDecision: reject
defects:
    - defectId: RV-D01-A
      category: empty-input
      severity: high
      trigger: Caller supplies an explicit empty project selection.
      expectedBehavior: No projects are returned.
      wrongBehavior: All projects are returned.
      evidence:
          - src/project-filter.ts
      proofCommand: bun run test:oracle --test-name-pattern "empty selection means none"
      acceptableConcepts:
          - explicit empty selection
          - fallback selects every project
      nearMisses:
          - omitted selection uses the documented all-project default
advisoryPolicy: supported-only
```

The clean twin uses the same project and Plan with `expectedDecision: approve` and an empty `defects` list. Its oracle
still includes proof commands and tempting near-misses so unsupported findings can be diagnosed consistently.

## Defect Requirements

Every oracle defect must have:

- one stable identity;
- a concrete trigger;
- an observable wrong result;
- an independently runnable proof;
- one severity and defect family;
- expected causal evidence locations;
- enough acceptable concepts to recognize equivalent wording;
- at least one near-miss when a clean twin contains intentionally suspicious but correct code.

The proof should fail for the defective variant and pass for its clean twin. If it does not, the pair is not admitted to
the scored corpus.

## Approved Plan Requirements

The Plan must read like a real implementation request. It can state behavior, constraints, and named edge cases that a
careful implementation should satisfy. It must not:

- announce that the implementation contains a seeded defect;
- copy the oracle explanation;
- name the exact wrong expression or fixing edit;
- instruct the Reviewer to focus on the seeded defect family;
- contain benchmark-only scoring language.

Some fixtures deliberately name the relevant edge case in the Plan. Others test concrete correctness, regression, or
security behavior that a reviewer should catch even when the Plan did not predict the exact failure. Tag these groups
separately so results show Plan-adherence recall and independent correctness recall.

## Clean Twins

A clean twin is not an empty diff or obviously perfect rewrite. It should retain the shape that tempts a noisy Reviewer:

- a fallback that is correct because it distinguishes absence from an explicit empty value;
- a retry guarded by ancestry and compare-and-set evidence;
- concurrent completion with one explicit owner;
- a cache whose key includes all ownership dimensions;
- a required external-capability port rather than an internal dependency seam.

The twin must remain close enough to the defective variant that rejection cannot be justified by complexity alone.

## Multi-defect Fixtures

Multi-defect fixtures contain two or three causally independent oracle defects. They test whether the first correct
finding ends the Reviewer's search. The oracle records each identity separately; one broad comment cannot match several
defects unless it accurately states each trigger and wrong result.

Do not construct multi-defect fixtures by placing unrelated one-line mistakes in disconnected toy files. The defects
should interact through a believable feature while remaining independently repairable.

## Repair-state Fixtures

A repair fixture additionally supplies:

```yaml
priorLedger:
    - findingId: R1-1
      defectId: RV-D05-A
repairReport: "R1-1 — fixed: normalized the requested path before deletion."
repairBaselineRef: candidate-before-repair
repairRef: candidate-after-repair
expectedLedger:
    - findingId: R1-1
      state: open
newDefects: []
```

The evaluated Reviewer receives the prior finding and repair report through the production verification prompt. The
oracle may link the stable review identity to a corpus defect identity, but that link remains hidden.

Repair fixtures cover:

- complete resolution;
- partial resolution;
- an empty or irrelevant repair despite a completion claim;
- a symptom-only workaround;
- a repair that introduces a new regression;
- a correct repair accompanied by harmless unrelated churn.

The last case protects restraint: unrelated edits alone are not a blocking defect.

## Proof and Mutation Admission

Before a fixture is scored:

1. Materialize the defective variant in an isolated temporary project.
2. Run the hidden verifier and require the named proof to fail for the expected reason.
3. Materialize the clean twin and require the same proof to pass.
4. Check that normal project validation passes or fails exactly as the scenario declares. Some defects are intentionally
   invisible to the normal suite; others test whether the Reviewer catches a misleading touched test.
5. Confirm that the Reviewer-accessible tree contains no oracle, fixing patch, revealing history, or benchmark label.
6. Have a human inspect the Plan, diff, proof, and expected finding without seeing candidate benchmark output.

Fixtures that do not survive this admission process remain drafts and do not affect scores.

## Finding Matching

Match mechanically when the structured finding identifies the expected file or boundary and the defect has a precise
machine-readable category. Use blinded semantic adjudication when equivalent descriptions cannot be matched safely by
rules.

The adjudicator answers:

1. Does the finding identify the oracle trigger or an equivalent reachable trigger?
2. Does it identify the wrong behavior or consequence?
3. Does its evidence point to the cause rather than an unrelated suspicious line?
4. Is it independent of a finding already matched in this round?

All four are required for a unique `matched` result. A real newly discovered defect is `novel_valid` and triggers oracle
review before scoring continues.

## Result Record

Reviewer-specific result detail should remain nested under the common run record and include:

- scenario, variant, track, repetition, and configuration identities;
- expected and observed decision;
- per-defect match state;
- per-finding adjudication state;
- prior-ledger resolution state for repair fixtures;
- protocol outcome and correction attempts;
- tokens, elapsed time, turns, and tool calls;
- retained local trajectory path for deliberate inspection.

Do not write source, Plan text, diffs, findings, or oracle contents into passive workflow metrics.
