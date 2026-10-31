# Reviewer Benchmark Fixture Contract

## Goal

Define review fixtures whose repository context is realistic and whose expected defects are independently provable.
Keep the oracle out of the evaluated Reviewer's project and prompt.

The fixture contract belongs to the Reviewer evaluator. The current interim runner is
`bun scripts/run-reviewer-benchmark.ts`: it owns admission, isolation, production Reviewer execution, timeouts,
result capture, resume, and single-configuration reports. The shared runner, repetition, repair-state execution, and
paired comparison remain target. See [usage and human adjudication](../../evals/reviewer/README.md#run-and-score).

RV-D04, RV-D12, RV-D13, and RV-M01 are revision 2 after owner adjudication. RV-D01, RV-D02, RV-D03, RV-D05, and
RV-D06 are revision 1. The original paid baseline measures revision 1 only; see the [revision notes](../../evals/reviewer/README.md#fixture-revisions-after-owner-adjudication).

The 17 materialized discovery cases live in nine packages under `evals/reviewer/`: RV-D01–D06 A/B, RV-D12 A/B,
RV-D13 A/B, and RV-M01 A. The original nine-case smoke selection is unchanged. They are Bun 1.4.3 TypeScript
projects. RunWield CI excludes their `source/`, `variants/`, and `evaluation/` payloads; fixture admission checks them
separately. Runner code and tests remain in normal CI.

## Package Boundary

Each fixture package has three payload directories and an execution manifest:

```text
reviewer/<scenario-id>/
  source/                 files copied into the isolated project
  variants/               patches selected by the runner, never copied as labelled data
  evaluation/             hidden oracle, verifier, and adjudication notes
  scenario.yaml           execution facts, never copied into the project
```

Only the selected `source/` tree plus its selected variant becomes the Reviewer's project. The following must not enter
that project or its Git history:

- the `evaluation/` directory;
- variant names such as `defective` or `clean`;
- expected findings, defect identities, categories, or severities;
- hidden proof tests or fixing patches;
- corpus prose that describes the intended trap;
- Git history or commit messages that reveal the later fix.

The runner records the internal variant identity outside the project and presents an ordinary baseline-to-candidate diff
through `review_diff`. Each Reviewer project is outside the RunWield checkout, with neutral `main` baseline history
and a `change` branch. Hidden proofs run in separate verification trees. `.wld/` settings do not enter the review diff.
The current runner does not sandbox absolute reads: a Reviewer that guesses the checkout path could read hidden files.
The project contains no pointer back to the corpus. This residual risk remains accepted for the interim runner.

## Scenario Manifest

The non-secret scenario manifest records execution facts:

```yaml
schemaVersion: 1
scenarioId: RV-D04
track: discovery
group: correctness-beyond-plan
fixtureRevision: 2
planPath: docs/plans/reuse-plan-summaries.md
baselineRef: main
candidateRef: change
language: typescript
runtime:
    name: bun
    version: 1.4.3
sourcePath: source
tags:
    - correctness-beyond-plan
timeoutMs: 120000
validation:
    publicCommand: bun run test
    publicExpectedOutcome: pass-for-every-candidate
```

`scenarioId` must match `^RV-(?:D|M)\d{2}$` and the package directory name. `group` is required and must be one of:
`plan-adherence`, `plan-named-edge-case`, `correctness-beyond-plan`, `cross-file-context`, `architecture`, or
`multiple-defects`. Reports use this group; package directories containing `scenario.yaml` define corpus membership
for `--scenarios all`. No runner registry edit is needed to add a package.

`publicExpectedOutcome` is `pass-for-every-candidate` unless it is `declared-per-variant`. In that mode, each oracle
variant declares `validationOutcomes.bun run test` as `pass` or `fail`; a failure also needs `publicFailureMarker` with
the exact assertion message. RV-D13 A uses this mode because its public test catches the planted ignored flag.
Admission requires the normal package command to fail and a separate external guard to observe an actual
`AssertionError` with that message. An unexpected pass, another exception, a spoofed error name, or an unreadable
result stops admission. The guard contains no oracle or proof files in the Reviewer project.

The manifest may describe how to build the project, but it must not state whether the selected candidate is correct.
Variant selection and expected truth stay in the harness-side batch definition and oracle.

## Hidden Oracle

Each package has one `evaluation/oracle.yaml` with `schemaVersion: 1`, its scenario id, and
`advisoryPolicy: supported-only`. See the [complete path-containment oracle](../../evals/reviewer/RV-D05/evaluation/oracle.yaml).

- `verification` declares proof files and package scripts copied only to the disposable verification tree.
- `proofs` maps proof ids to runnable commands and exact expected assertion markers.
- `variants.A` names the defective patch, `patchBase: source`, `expectedDecision: reject`, and its defect list.
- Paired `variants.B` names the clean patch, `expectedDecision: approve`, and an empty defect list.
- Each defect includes its proof command and assertion marker as well as the behavioral fields below.
- Clean near-misses explain suspicious but correct behavior without entering Reviewer context.

For example, RV-D05 uses `bun run test:oracle prefix-sibling` and requires
`RV-D05-OUTSIDE-DELETION` on A, not an import, syntax, or infrastructure error. The same proof passes on B. RV-M01 has
only A as a scored case; hidden clean and independent repair patches establish its two defects during admission.

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

Repair-state execution is target; the current runner supports discovery only. A future repair fixture additionally
supplies:

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

Mechanical admission steps 1–5 must pass for every selected package before any model call:

1. Materialize the defective variant in an isolated temporary project.
2. Run the hidden verifier and require the named proof to fail for the expected reason.
3. Materialize the clean twin and require the same proof to pass.
4. Check that normal project validation passes or fails exactly as the scenario declares. Some defects are intentionally
   invisible to the normal suite; others test whether the Reviewer catches a misleading touched test.
5. Confirm that the Reviewer-accessible tree contains no oracle, fixing patch, revealing history, or benchmark label.
6. After the paid run, the owner judges each fixture's Plan, diff, proof, and oracle together with the Reviewer's
   result. This judgment is not a pre-run requirement. Record an oracle verdict for each case. A
   `fixture_needs_repair` verdict or any `novel_valid` finding excludes that case from every score; other cases still
   score. The excluded case does not score until a revised fixture runs again.

Fixtures that fail mechanical admission cannot enter the run. Reports retain excluded cases and their repair reasons.

## Finding Matching

The runner suggests matches when a finding cites an oracle evidence path. A path match earns no semantic
credit. A human labels each blocking finding as `matched`, `duplicate`, `unsupported`, or `novel_valid` in the run's
`adjudications.json`, keyed by run, case, attempt, and zero-based finding index. Invalid or stale labels stop scoring.
Advisories are not blocking findings. See the [label format](../../evals/reviewer/README.md#human-adjudication).

The adjudicator answers:

1. Does the finding identify the oracle trigger or an equivalent reachable trigger?
2. Does it identify the wrong behavior or consequence?
3. Does its evidence point to the cause rather than an unrelated suspicious line?
4. Is it independent of a finding already matched in this round?

All four are required for a unique `matched` result. A real newly discovered defect is `novel_valid` and excludes
that case from every score, without stopping scores for other cases. The optional `oracleVerdicts` list in
`adjudications.json` records `{ caseId, verdict, note? }`, where `verdict` is `confirmed` or `fixture_needs_repair`.
A `confirmed` verdict with a `novel_valid` label is invalid. Unknown cases, duplicate verdicts, and unknown verdict
values also stop scoring.

Semantic scores stay `pending adjudication` while a counted case lacks a verdict or any of its blocking findings
lacks a label. Older files without `oracleVerdicts` remain valid but pending. Failed, timed-out, and missing cases
still count unless excluded.

## Result Record

The current runner writes a `run.json` manifest and append-only `results.jsonl` outside the Reviewer project.
The manifest holds the selected cases, oracle snapshot, fixture hashes, and configuration. Each result holds the case,
variant, fixture revision, trial and attempt, expected/observed decision, protocol outcome and cause, exact accepted
findings/advisories, nudges, actual model/provider, tokens, tool calls, elapsed time, and checkout/prompt identity.
Absent measurements say `unavailable`, never an estimate. Resume keeps completed cases, including incorrect verdicts,
and retries unfinished ones; scoring uses the latest attempt, not the best.

`score` writes `summary.json` and `summary.md` from saved data without model calls. Human verdicts and finding
labels live separately in `adjudications.json`. Each `summary.md` case has a readable worksheet before its JSON
record: package/patch paths, oracle defects and proof commands (or “Oracle: no defect”), blocking findings and suggested path matches, verdict,
and labels. Excluded cases and reasons appear in “Fixtures needing repair” and in `summary.json` under
`fixturesNeedingRepair`. These are deliberate local evaluation files, not passive metrics.

For the target shared harness, Reviewer-specific detail should remain nested under the common run record and include:

- scenario, variant, track, repetition, and configuration identities;
- expected and observed decision;
- per-defect match state;
- per-finding adjudication state;
- prior-ledger resolution state for repair fixtures;
- protocol outcome and correction attempts;
- tokens, elapsed time, turns, and tool calls;
- retained local trajectory path for deliberate inspection.

Do not write source, Plan text, diffs, findings, or oracle contents into passive workflow metrics.
