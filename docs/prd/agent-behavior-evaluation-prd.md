# Product Requirements Document: Agent Evaluation and Benchmark Harness

**Status:** Shared harness proposed; Reviewer-only corpus runner current. The Router golden set and the interim
Reviewer runner do not deliver the shared capability. This PRD combines Agent scorecards, support policy, and the
benchmark-running experience, with current and target scope separated below.

## Objective

Let RunWield maintainers compare Agent and model configurations through repeatable, privacy-safe evaluations of the
actual product. Measure both the Agent's role contract and the surrounding workflow, then use that evidence to decide
which models, prompts, tools, extensions, and Model Adaptation Profiles to support.

## Problem Statement

Automated source tests establish code behavior, but they cannot establish whether a model stops discovery, routes a
request correctly, calls its required completion tool, edits safely, or recovers from a failed tool. A plausible final
answer can still leave the workflow unfinished.

The Router golden set shows why decision accuracy alone is insufficient. Timeouts, missing completion calls, repeated
commands, discovery cost, and unscored rows matter too. Other Agents need their own scorecards, and complete workflows
need a shared way to run and compare them.

## Audience and Product Principles

The initial users are RunWield maintainers evaluating product changes and experimental Agent/model combinations.
Evaluation is deliberate and local; normal RunWield use remains independent of benchmark dependencies.

- **Evaluate role contracts.** Router, Engineer, Operator, Reviewer, and planning Agents need different scorecards.
- **Measure the workflow outcome.** Mechanical and Workflow Validation are stronger evidence than model self-report.
- **Separate facts from judgment.** Deterministic checks establish hard outcomes. Model judges assess other dimensions,
  and human review calibrates ambiguous quality judgments and new fixtures.
- **Make severe failures visible.** Report correctness, safety, workflow completion, costs, and uncertainty separately.
- **Exercise the real product.** Use the effective Agent configuration and normal tools, interactions, and validation.
- **Protect private content.** Detailed evaluation reports are deliberate local artifacts, separate from passive metrics.

## Capability Requirements

### Agent scorecards and support decisions

**Scope and maturity:** Mixed. Reviewer-only discovery evaluation is current. The shared scorecards and support-decision
capability remain target.

**Requirement: Score each Agent against its role.** Each run measures the applicable scorecard and expected workflow
outcome. Deterministic scoring covers tool and lifecycle events, timeout, retries, changed-file scope, and validation.
Judge and human assessments stay separate. Reports expose time, tokens, context pressure, interventions, and requests
for user attention as product costs.

**Requirement: Graduate support through evidence.** Provider compatibility and Agent-level support are separate claims.
A Model Adaptation Profile starts experimental. It becomes supported after improving an agreed baseline on its target
contract while preserving safety and workflow correctness. Reports state limitations and unsupported combinations.

#### Router

Measure agreement on labeled rows, unscored and timeout rates, exactly one `triage_report`, discovery cost and duration,
tool calls before triage, and repeated or forbidden tool attempts.

#### Semantic Reviewer

**Current requirement: Evaluate the production Reviewer on every admitted discovery package.** The interim
`bun scripts/run-reviewer-benchmark.ts` runner evaluates 33 admitted discovery cases in 17 synthetic Bun 1.4.3
TypeScript packages: RV-D01–D16 A/B and RV-M01 A. `--scenarios all` discovers every package containing `scenario.yaml`, ordered by scenario
ID then variant. The original nine-case `--scenarios smoke` set is unchanged. The runner uses the effective Reviewer
model, production prompt, tools, inspection gate, nudges, and `review_complete` through `runReviewerRound`, with
round 1 and an empty ledger. It does not run outer workflow lifecycle or Delivery Evidence writes.

The [one-trial baseline](../evaluation/reviewer-benchmark-results/2026-10-baseline-smoke.md) completed RV-D04 A/B,
RV-D05 A/B, RV-D12 A/B, RV-D13 A/B, and RV-M01 A: nine complete rounds, mechanical decisions 7/9, and clean approval
2/4. The owner accepted all 13 findings; under the historical scoring rules, the original oracle needed corrections
before semantic scoring. Four fixture packages are now revision 2 after repairs; the paid baseline measures revision 1
only. The [full discovery report](../evaluation/reviewer-benchmark-results/2026-10-discovery-pairs.md) records one
trial on all 33 current cases, pending adjudication. Changed smoke fixtures cannot show a trend against the baseline.
Mechanical decision accuracy and clean approval are separate from finding quality. Evidence-path matches are
suggestions, never recall.

The owner judges each fixture together with the Reviewer's results after the paid run, not as a pre-run requirement.
Human `adjudications.json` accepts an optional `oracleVerdicts` list of `{ caseId, verdict, note? }`, with verdict
`confirmed` or `fixture_needs_repair`, alongside blocking-finding labels. A `fixture_needs_repair` verdict or any
`novel_valid` finding excludes the entire case from every score: decision accuracy, clean approval, variant/group
splits, recall, precision, and severe-defect recall. Other cases still score. Reports retain excluded cases and reasons
under fixtures needing repair. Repair the fixture and rerun the revised fixture before it can score.

Semantic status stays `pending adjudication` while a counted case lacks an oracle verdict or any of its blocking
findings lacks a label; otherwise it is `scored`. Older files without verdicts remain valid but pending. Unknown
cases, duplicate verdicts, unknown verdict values, and a `confirmed` verdict with a `novel_valid` finding stop scoring.
Invalid or stale finding labels also stop scoring.

**Target requirement: Compare discovery and repair judgment.** Compare the current discovery prompt with the proposed
Review Reconnaissance prompt on paired fixtures with the same model configuration and repository context. Report:

- distinct known defects found;
- supported blockers, unsupported findings, and duplicates;
- approval of clean twins with similar but correct code;
- severe-defect recall separately from aggregate recall;
- evidence accuracy and identification of causal behavior rather than symptoms;
- completeness when a change contains several independent defects;
- defect-state tracking after complete, partial, empty, misleading, or regressive repairs;
- advisory noise, protocol completion, diff inspection, cost, and repeated-trial stability.

A blocking finding requires repository evidence. Reports retain supported findings rather than risks ruled out during
review. Recall, precision, clean approval, and severe misses remain separate measures.

The shared harness, candidate prompt authoring/comparison, repeated trials, RV-M02–M06 multi-defect fixtures, and
RV-R01–R06 repair-state scenarios remain target. One-trial runs do not establish stability, a prompt improvement, or a
model support decision.

**Current acceptance scenarios:**

- Given `--scenarios all`, the runner admits all 17 packages before model calls and records all 33 cases in the discovery report.
- Given a finding that cites an oracle path but has no human label, recall stays pending rather than counting a match.
- Given confirmed counted cases and fully adjudicated findings, recall counts distinct matched defects, precision
  penalizes duplicates and unsupported findings, and high/critical recall remains separate.
- Given a `fixture_needs_repair` verdict or a `novel_valid` label on a case, that case leaves every score and is
  listed as needing repair, and the other cases still score.
- Given a counted case without an oracle verdict, semantic scores stay pending.
- Given `confirmed` and `novel_valid` on the same case, scoring reports invalid adjudications.
- Given an older adjudications file without oracle verdicts, scoring accepts it and keeps semantic scores pending.

Scorecards, fixtures, and the current runner:

- [Reviewer Benchmark Scorecard](../evaluation/reviewer-benchmark-scorecard.md)
- [Reviewer Benchmark Fixture Contract](../evaluation/reviewer-benchmark-fixtures.md)
- [Reviewer Benchmark Pilot Corpus](../evaluation/reviewer-benchmark-pilot-corpus.md)
- [Runner and adjudication instructions](../../evals/reviewer/README.md)

#### Engineer and Operator

The first adaptation pilot measures successful completion, required terminal-tool use, changed-path scope, destructive
whole-file rewrites, read/edit recovery, repeated or non-progressing calls, interventions and recovery, validation,
Scope Escalation, context interventions, elapsed time, and token use.

Engineer is judged on scoped implementation and validation. Operator is judged on task completion, self-verification,
scope discipline, and Scope Escalation.

#### Planning Agents

Later scorecards assess decision quality, evidence use, collaboration, and artifact quality with human-calibrated
judgment rather than one mechanical score.

**Acceptance scenarios:**

- Given a Router run with a correct routing answer but no required terminal tool, its report keeps accuracy and
  completion failure separate.
- Given a Reviewer tested on a defective fixture and its clean twin, the report shows defect recall and unsupported
  findings separately from clean approval.
- Given a candidate adaptation and the same unadapted baseline, maintainers can compare validated outcomes, costs,
  regressions, and variance before deciding support.

### Repeatable scenario runs

**Scope and maturity:** Mixed. Reviewer-only corpus selection, admission, isolation, timeouts, persistence, and resume
are current. Shared selection by tag, Agent, or workflow, repetitions, concurrency, and the shared runner remain target.

**Current requirement: Run an isolated Reviewer batch.** Select `all`, the preserved nine-case `smoke` set, package
scenario IDs, or individual variants. Corpus membership comes from package directories with `scenario.yaml`; each
manifest supplies a `group` from `plan-adherence`, `plan-named-edge-case`, `correctness-beyond-plan`,
`cross-file-context`, `architecture`, or `multiple-defects`. New packages need no runner registry edit. Unknown cases
fail before admission. Options include `--model`, `--timeout-ms`, `--out`, and `--resume`. Mechanical admission of
every selected package, model resolution, and credential checks precede model turns. Each case gets a fresh external
temporary Git project with neutral history.
The project excludes the oracle, hidden proofs, variant labels, fixing patches, and pointers to the corpus. Absolute
read sandboxing is not provided; guessed checkout paths remain an accepted interim-runner risk.

Each result is flushed locally after the case. Timeout, pause, provider error, and harness error retain their cause
and stay in denominators unless their case is excluded for fixture repair. Resume keeps completed cases, even
incorrect decisions, and retries unfinished cases only. It rejects changed configuration, selected cases, fixture
hashes, or timeout. Scoring uses the latest attempt rather than the best. Runner tests use a faux provider and make no paid calls; fixture payloads are outside ordinary source CI.

**Target requirement: Run one scenario or a resumable batch.** Maintainers select scenarios by name, tag, Agent,
workflow,
model, preset, or profile. They configure repetitions, concurrency, and per-scenario and per-operation timeouts. The run
checks prerequisites before spending model calls and saves completed results as it proceeds, so an interrupted batch
can resume.

**Requirement: Isolate and identify every trial.** Each scenario uses an isolated temporary Project or the benchmark's
sandbox, separate from the user's saved Project data. Trials begin from equivalent filesystem and Session state unless
the scenario tests resume or recovery. The run records fixture or repository revision, model/provider identity and
version, effective Agent Definition revision, preset, profile, and relevant configuration before Agent work starts.

Fixtures are versioned and reviewable, with expected outcomes or human labels. Historical requests are sanitized before
becoming fixtures. Synthetic fixtures test known failure modes and are labeled as such. Expected answers, scoring
fixtures, and oracle solutions stay outside the Agent's available Project tools.

**Requirement: Failures stay contained and visible.** Timeouts and cancellation settle the current run and leave later
runs usable. Reports distinguish Agent, verifier, harness, infrastructure, provider, model-server, sandbox, and dataset
failures. Interrupted, unsupported, and unscored trials remain visible in results and denominators, except cases
explicitly excluded for fixture repair.

**Acceptance scenarios:**

- Given a failed or timed-out trial followed by another scenario, the next scenario starts from its own clean state.
- Given an interrupted batch, resume keeps completed trials and clearly identifies unfinished ones.
- Given a missing benchmark prerequisite, the run reports the setup problem before invoking a model.
- Given an evaluated Agent searching its Project, expected answers and labels remain unavailable.

### Production-representative workflows

**Scope and maturity:** Target.

**Requirement: Compare real RunWield entry points.** Maintainers run equivalent scenarios through native RunWield and
public ACP, including the compiled product. Reports identify the entry point and compare configuration, outcomes,
failures, usage, and timing. A limited ACP pilot establishes only the workflows it exercises.

Runs use normal Agent Definitions, model resolution, protected tools, extensions, Session behavior, orchestration, and
validation. Benchmark prompts retain the production system prompt and contain no hidden workflow instructions.
Explicit benchmark-only tools or controlled inputs are recorded as methodology differences; normal clients keep their
existing approval, validation, and scope protections.

**Requirement: Supply declared fixture decisions.** A fixture declares answers for interviews, verification-command
selection, approval, and review. The run records the supplied answers or decision categories and rejects unexpected
interactions. Unsupported interactions, user cancellation, timeout, protocol failure, process exit, and harness failure
remain distinct. Planned-change review through ACP uses its production interaction path.

**Initial native portfolio:**

- Router to Guide for read-only inquiry;
- Router to Engineer, Task Completion, and Mechanical Validation;
- Router to Planner, Plan review, Engineer, and Workflow Validation;
- Operator completion and Scope Escalation;
- cancellation during active work;
- context pressure, mid-run compaction, and continuation;
- resume and recoverable failure;
- replay parity, interaction handling, and multi-Session isolation.

Each scenario names its isolated fixture, request, declared interactions, Routing Intent or starting Agent, expected
terminal tools and outcome, deterministic verification, timeout, cleanup policy, and scorecard. Start with a small suite
that maintainers can inspect, then expand after failure classification is trustworthy.

**Acceptance scenarios:**

- Given an equivalent supported scenario through native RunWield and compiled ACP, both reach the intended repository
  and workflow outcomes, with their entry points named in the report.
- Given a planned workflow that asks an undeclared approval question, the run reports an unexpected interaction rather
  than selecting an answer.
- Given a final answer that claims success but failed validation, the report retains the failed workflow verdict.

### Reports and comparison

**Scope and maturity:** Mixed. Local single-configuration Reviewer reports are current. Paired comparison,
variance, and shared workflow reports remain target.

**Current requirement: Report saved Reviewer evidence.** `score <run-directory>` writes `summary.md` and
`summary.json` without model calls. Reports preserve case/variant/revision/trial/attempt identity, expected and observed
decisions, exact accepted findings and advisories, failure causes, actual model/provider, checkout revision/dirtiness,
prompt hashes, fixture hashes, usage, tool calls, elapsed time, and nudges. Missing measurements say `unavailable`.
Decision measures split by variant and group; semantic measures split by group. Missing results remain visible.
Each case in `summary.md` has a readable worksheet before its JSON record: package and patch paths, oracle defect
IDs/severities/triggers/expected and wrong behavior/proof commands (or “Oracle: no defect”), blocking findings with
indexes and suggested path matches, and any verdict and labels. “Fixtures needing repair” lists exclusions and
reasons; `summary.json` stores this list under `fixturesNeedingRepair`, with owner notes or default reasons and
`novel_valid` finding indexes. Human verdicts and labels stay in the local run directory, separate from passive metrics.

**Current acceptance scenarios:**

- Given saved results, `score` produces both report formats without invoking a model.
- Given missing measurements, the report says `unavailable` rather than estimating values or reporting zero.
- Given absent human labels, mechanical decisions remain reportable and semantic scores stay pending.

**Target requirement: Compare a candidate with a fixed baseline.** Local reports include human-readable summaries and
machine-readable results. They preserve observed Agent changes, tool outcomes, validation verdicts, final workflow
status, elapsed time, usage, intervention counts, methodology differences, and enough trajectory detail for diagnosis.
Comparisons show improvements, regressions, variance, and missing results separately.

Detailed fixtures and outputs belong to the deliberate evaluation run. Passive
[workflow metrics](runwield-core-prd.md#local-workflow-metrics) remain content-free; private requests, prompts, code,
diffs, tool arguments and results, and credentials stay out of that stream.

**Acceptance scenarios:**

- Given a candidate with better accuracy but more completion failures, the comparison exposes both outcomes.
- Given missing or infrastructure-failed trials, the report keeps them visible rather than counting them as Agent
  success or omitting them.
- Given a detailed local evaluation, passive metrics still contain no private benchmark content.

### External benchmark adapters

**Scope and maturity:** Target after the native suite.

**Requirement: Preserve canonical benchmark methodology.** Established datasets, task preparation, verification, retry
semantics, and reporting can be reused when suitable. Reports disclose deviations and narrower workflow coverage.
External benchmarks complement the RunWield scorecards.

1. **Aider Polyglot over ACP:** Use canonical Aider Polyglot / Exercism exercises through `wld acp`, protected tests,
   and two attempts: an initial attempt and one retry with test feedback. Reports separate first-pass success, retry
   success, failure, timeout, and infrastructure error, with usage and elapsed time. Long batches resume with completed
   results intact. An initial QUICK_FIX/Engineer pilot measures implementation and adaptation, not the complete planned
   workflow.
2. **Harbor / Terminal-Bench:** Add longer containerized tasks when RunWield can run representatively in that
   environment. Keep canonical instructions, verifiers, and result conventions.

Reuse requires the applicable source and dataset licenses, attribution, citations, NOTICE content, and changed-file
notices. The earlier proposals treated little-coder as Apache-2.0 reference material, not a complete maintained
six-language runner. Confirm current source and dataset terms before adopting them; prefer canonical upstream fixtures
and methodology over a copied reference snapshot.

**Acceptance scenarios:**

- Given an Aider exercise that fails its first test attempt, the run supplies test feedback once, records the second
  outcome separately, and preserves both on batch resume.
- Given a task requiring changed methodology, its report names the change and limits the comparison claim.

## Delivery and Success Measures

1. Establish repeatable results for one small native workflow and compare it with compiled ACP on a supported path.
2. Expand to the native portfolio and Agent scorecards. Evaluate
   [Session Context Resilience](session-context-resilience-prd.md) and
   [Selective Execution Model Adaptation](selective-execution-model-adaptation-prd.md) against fixed baselines.
3. Add Aider Polyglot, then Harbor / Terminal-Bench when its environment supports representative product behavior.

Success means maintainers detect routing and completion regressions, attribute failures, compare validated adaptation
outcomes with costs and variance, resume interrupted batches, and make at least one documented execution Agent/model
preset support decision from the evidence. Baseline quality thresholds remain to be agreed; no numeric target is
invented here.

## Risks and Non-goals

Fixture leakage can invalidate results; keep answers outside Agent reach. Sampling variance can hide regressions; use
paired comparisons and repeated trials. Infrastructure failures can resemble model failures; keep their causes
separate. Methodology shortcuts can overstate product coverage; disclose controlled inputs and tested workflow scope.

Out of scope: a public leaderboard, raw-model benchmarking, hosted analytics uploads, model judges as the sole release
gate, replacing source tests or canonical external verifiers, running full external corpora in normal CI, and claiming
one benchmark predicts every repository or workflow.

## Proposed Domain Language

**Agent Behavior Evaluation:** A repeatable assessment of whether an Agent/model configuration fulfills its RunWield
role contract and reaches the expected workflow outcome. _Avoid_: generic model benchmark, model leaderboard, unit test.
Affected terms: Agent, Model Adaptation Profile, Workflow Validation. The scorecard measures the Agent and workflow;
provider compatibility alone does not establish support.

**End-to-End Benchmark Harness:** The RunWield-owned evaluation capability for running isolated scenarios, collecting
outcomes, and comparing configurations through production-representative entry points. _Avoid_: replacement Runtime,
raw-model runner. It runs the Agent Behavior Evaluation scorecards and preserves the existing Session and workflow
boundaries.
