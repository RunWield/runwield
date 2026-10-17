# Product Requirements Document: Agent Evaluation and Benchmark Harness

**Status:** Proposed. The existing Router golden-set work is a starting point, not delivery of this shared capability.
This PRD combines the Agent scorecards, support policy, and benchmark-running experience in one proposal.

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

**Scope and maturity:** Target.

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

Measure defect discovery and restraint. Compare the current discovery prompt with the proposed Review Reconnaissance
prompt on paired fixtures with the same model configuration and repository context. Report:

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

Detailed proposed scorecards and fixtures:

- [Reviewer Benchmark Scorecard](../evaluation/reviewer-benchmark-scorecard.md)
- [Reviewer Benchmark Fixture Contract](../evaluation/reviewer-benchmark-fixtures.md)
- [Reviewer Benchmark Pilot Corpus](../evaluation/reviewer-benchmark-pilot-corpus.md)

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

**Scope and maturity:** Target.

**Requirement: Run one scenario or a resumable batch.** Maintainers select scenarios by name, tag, Agent, workflow,
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
failures. Interrupted, unsupported, and unscored trials remain visible in results and denominators.

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

**Scope and maturity:** Target.

**Requirement: Compare a candidate with a fixed baseline.** Local reports include human-readable summaries and
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
preset support decision from the evidence. Baseline quality thresholds remain to be agreed; no numeric target is invented here.

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
