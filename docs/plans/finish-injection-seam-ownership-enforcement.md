---
planId: "bdc115ce-cfd3-4abe-a789-505a111369f6"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "AGENTS.md"
    - "docs/domain-language.md"
    - "docs/plans/deep-semantic-source-modules.md"
    - "scripts/check-injection-seams.js"
    - "scripts/check-injection-seams.test.js"
    - "scripts/external-capability-ports.json"
    - "src/shared/git-port.ts"
    - "src/shared/package-resources.ts"
    - "src/shared/extensions/wld-extension-manifest.js"
    - "src/shared/workflow/execution-start.ts"
    - "src/cmd/load-plan/plan-recovery-flow.ts"
    - "src/cmd/auth/index.ts"
    - "src/cmd/sleep/index.ts"
    - "src/cmd/registry.js"
    - "src/cmd/router/index.ts"
    - "src/cmd/agents/index.ts"
    - "src/cmd/init/index.ts"
    - "src/cmd/resume/index.ts"
    - "src/ui/theme/theme-discovery.ts"
    - "src/ui/tui/boot-banner.ts"
    - "src/ui/tui/chat-session.ts"
    - "src/ui/tui/system-notifications.ts"
    - "src/ui/tui/interactive-session-port.ts"
    - "src/shared/workflow/validation.ts"
    - "src/shared/workflow/validation-*.ts"
    - "src/shared/workflow/validation-test-helpers.js"
    - "src/shared/workflow/validation-*.test.*"
    - "src/shared/session/architecture-boundary.test.js"
    - "src/shared/workflow/architecture-boundary.test.ts"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-07-30T17:54:11.445Z"
status: "ready_for_work"
origin: "internal"
userVerifiedAt: null
---

# Finish injection-seam ownership enforcement

## Context

The original migration is complete. RunWield moved from 155 detected injection seams across 13 modules to a zero-seam
baseline. `scripts/check-injection-seams.js` scans production code under `src/` and `scripts/`, its empty baseline
cannot adopt new entries, and `deno task ci` runs the check. Tests now use isolated projects, repositories, Plans,
settings, SQLite stores, and home directories instead of replacing Plan, lifecycle, registry, lock, Work Record, Session
Runtime, or transaction machinery.

The zero result does not yet prove ownership. The detector automatically accepts an imported required type whose name
ends in `Port`, and it treats local all-required `Port`, `Ports`, or `Deps` objects as the desired replacement shape. A
required parameter removes a silent fallback, but it can still let a test replace behavior that RunWield owns.

A current audit found 23 TypeScript production port declarations, plus JavaScript JSDoc port shapes and port-like
classes. The draft originally named only execution start, Plan recovery, interactive-session startup, package settings,
and Workflow Validation. The user chose a complete production-port audit with no temporary ownership exceptions. The
change must therefore classify every required behavioral collaborator that the strengthened detector finds, preserve
genuine external capabilities, and remove or reshape every mixed or internal one.

Known mixed or internal declarations include:

- `ExecutionStartPorts`, which combines Git and clock boundaries with Worktree lookup, branch policy, canonical Plan
  loading, settings consent, user-confirmation policy, and metric recording;
- `RecoveryFlowPorts`, which combines Git probing with RunWield metric storage;
- both `InteractiveSessionPort` declarations, which make RunWield's own TUI and Session startup replaceable;
- `AuthUiPort`, `SystemNotificationPort`, and Sleep's `MnemotecaPort`, which combine external interaction or host work
  with RunWield presentation, settings, preflight, or session policy;
- optional `BootRuntimeToolsPort` and unused `TerminalPairPort` test controls;
- `resolveInstalledPackagePromptResources` and `resolveInstalledWldExtensionResources`, which still accept a
  `settingsManager` override and call `Deno.cwd()` directly;
- `ValidationSessionPort`, an 18-property aggregate containing workflow state, phase position, progress, Runtime event
  emission, interaction cancellation, Agent turns, display-name lookup, and post-verification handoffs.

The session-independent Workflow Validation extraction remains valid and must be preserved. Validation sequencing and
phase policy stay independent of `HostedSession` and Pi. The repair policy also stays RunWield-owned: the engine chooses
the Agent, prompt, retry, completion gate, and session-reuse policy; the external Agent capability only executes a
specific requested turn and translates its external result into a typed outcome.

## Objective

Make ownership, not required-parameter syntax, decide what production behavior tests can replace:

- keep the injection-seam baseline at zero with no temporary ownership exceptions;
- declare each genuine external capability by exact source declaration and member set;
- reject imported, local, JSDoc, and constructor-injected behavioral collaborators that are undeclared, stale, mixed, or
  expose RunWield-owned machinery;
- remove every current mixed or internal production port found by the complete audit;
- replace `ValidationSessionPort` with narrow Agent and user-interaction capabilities plus a non-replaceable RunWield
  runtime context;
- preserve all command, TUI, execution, recovery, resource-loading, notification, and Workflow Validation behavior.

## Approach

An injection seam is a public claim that a behavior can vary independently of RunWield. Apply these rules:

- Git, subprocesses, network, browser launch, Agent/model calls, low-level Pi sessions, hosted continuous integration
  (CI), clocks, terminal host input/output, and Mnemoteca can use small required ports with no fallback.
- Plan and Worktree writes, lifecycle transitions, validation and workflow state, settings policy, registries, Runtime
  events, transactions, locks, Work Record generation, command routing, and orchestration stay on real RunWield paths.
- Paths, identifiers, parsed settings, limits, and immutable request data are parameters, not ports.
- A RunWield module boundary does not become external because more than one runtime uses it. When internal state must
  cross modules, use a product-constructed nominal context that tests cannot replace with a plain object.

### Exact external-capability declarations

Add `scripts/external-capability-ports.json` as a repository-private ownership manifest. Each entry identifies one
source module and named TypeScript interface/type, JSDoc typedef, or other injected contract; records the external
owner; and lists the exact callable members. Imported declarations are resolved to their source. A changed, missing,
duplicate, or extra member makes the manifest stale and fails the check.

The checker must stop trusting `Port`, `Ports`, `Deps`, `Dependencies`, or `Hooks` suffixes and all-required object
shapes. It must inspect both local and imported required behavioral contracts. A type absent from the manifest is not
automatically invalid when it is plain data, but an undeclared behavioral collaborator is reported. Renaming a mixed
port or placing it behind a constructor must not evade the result.

The manifest records contracts, not implementations. It cannot name `SYSTEM_*` values, fakes, convenience wrappers, or
RunWield-owned modules. Valid entries include cohesive browser, Git, network, process, clock, Agent execution, CI,
terminal-host, clipboard, and Mnemoteca capabilities. Mixed aggregates are split or removed before the production scan
can pass. A generic `execute`, `invoke`, `dispatch`, or operation-code multiplexer is not cohesive merely because its
adapter eventually starts a subprocess; the checker fixtures and semantic review must reject any declared capability
that can route more than one external system or any RunWield-owned operation.

This manifest and checker are only for this repository. The completed Init seam-risk guidance remains advisory and must
not expose the manifest schema, source globs, naming rules, Deno tasks, or automated verdict to customer projects.

### Real composition for current mixed ports

Execution start and Plan recovery call canonical Worktree, Plan, settings, interaction-policy, and metric functions
directly. Extend or reuse `GitPort` only for raw Git questions, and use one narrow clock capability where deterministic
time is necessary. Tests use real Git repositories, Plans, settings homes, and metric files.

Commands that launch a Session call the real interactive-session composition. Their parsing and validation can remain
pure, but tests no longer replace startup through either `InteractiveSessionPort`. Auth keeps only a narrow user
interaction capability; model registry, model selection, Session Runtime, and message policy remain real. Sleep reuses
the shared Mnemoteca process capability, calls RunWield preflight directly, and enters the real Session composition.
System notifications read RunWield settings directly and retain only host environment, process, and terminal-write
operations as an external capability. Theme discovery uses real temporary files and a narrow external package-resource
resolver. Boot-banner tests control `PATH` around the real binary probe instead of passing optional runtime tools. The
unused `TerminalPairPort` is removed.

Package prompt and WLD-extension resolution always use the canonical settings manager and `getCwd()`. Tests select the
wanted settings and package state through sandboxed homes and working directories; no `settingsManager` option or `any`
cast remains.

### Validation ownership

`validation.ts` stays the Core Session composition root:

```text
runValidationLoop
  create Core ValidationRuntimeContext from real HostedSession
  bind required ValidationAgentPort and ValidationInteractionPort
  bind Git, CI, and Mnemoteca external capabilities
  run session-independent validation engine
```

`ValidationAgentPort` has a deep two-operation shape: create an opaque external Agent conversation and execute a typed
Agent-turn request in that conversation. The engine owns Agent selection, prompts, repair versus review purpose,
completion gates, retries, continuation, and when a conversation is reused or cleared. The adapter owns Pi handles,
external execution, raw-message translation, and external-failure classification. `SemanticReviewPort`,
`runIndependentRepairTurn`, and `continueLastRepairTurn` do not survive as replaceable policy operations.

`ValidationInteractionPort` only requests a typed user decision. The real adapter owns presentation details. Runtime
event emission and active-interaction cancellation registration remain RunWield machinery and do not move onto this
port.

A nominal `ValidationRuntimeContext` carries one run's authoritative Core bindings and engine-owned progress/repair
conversation state. Its construction is private to approved Core Session composition and a future Attached Workflow
composition path; plain structural objects and test subclasses are rejected. Tests obtain it only through a real fixture
`HostedSession`. It delegates to canonical state and event modules rather than duplicating lifecycle, persistence,
registry, or lock logic. Remove unused `setCurrentProgress`; import Agent display-name lookup directly, and let the
nominal context invoke the canonical HostedSession-based post-verification handoff without exposing it as a replaceable
port method.

The main option set aside is a temporary allowlist for today's mixed ports. It would make this change smaller, but it
would recreate an ownership baseline and let the checker report success before the repository satisfied its rule.

## Expected Change Surface

The boundaries below are guidance, not an allowlist: verify the real footprint during implementation and change whatever
the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved
intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk
grows, or the Verification Plan no longer proves the objective.

- `scripts/check-injection-seams.js` and `scripts/check-injection-seams.test.js` — resolve and validate required
  behavioral contracts against the exact ownership manifest; preserve optional-fallback and test-hook detection.
- `scripts/external-capability-ports.json` — declare every current genuine production external capability with no debt
  or internal-machinery entries.
- `AGENTS.md` — state that required ports must be declared and cohesive, and that the zero result includes required-port
  ownership.
- `src/shared/git-port.ts`, `src/shared/workflow/execution-start.ts`, and `src/cmd/load-plan/plan-recovery-flow.ts` —
  separate raw Git/clock work from RunWield execution and recovery policy.
- `src/cmd/{auth,sleep,router,agents,init,resume}/`, `src/cmd/registry.js`, and `src/ui/tui/interactive-session-port.ts`
  — remove replaceable Session startup and mixed command ports while preserving every CLI and slash-command route.
- `src/ui/theme/theme-discovery.ts` and `src/ui/tui/{boot-banner,chat-session,system-notifications}.ts` — retain only
  cohesive package/host capabilities; remove optional or dead test controls.
- `src/shared/package-resources.ts` and `src/shared/extensions/wld-extension-manifest.js` — use canonical settings,
  `getCwd()`, and sandboxed environment state.
- `src/shared/workflow/validation.ts`, `validation-session-adapter.ts`, `validation-ports.ts`, `validation-types.ts`,
  `validation-engine.ts`, and phase modules — replace the mixed Session port with the nominal Runtime context and narrow
  required external capabilities.
- Command, TUI, Git, package-resource, recovery, execution-start, validation, Session Runtime, and architecture tests —
  prove real composition and preserve behavior after the test-only replacement points disappear.
- `docs/domain-language.md` — update **Session-Independent Validation Engine** to describe the implemented runtime
  context and narrow Agent/interaction capabilities; do not present `ValidationSessionPort` as current truth.
- `docs/plans/deep-semantic-source-modules.md` — update the future move map and checks to move the resulting
  declarations, with no legacy `ValidationSessionPort` exception.

The completed and archived Init seam-risk Plan is deliberately outside the change surface. Its behavior is a
compatibility constraint, not a document to revise.

## Reuse Opportunities

- `src/shared/git-test-fixture.ts#defineGitFixture` — real Git repositories for execution, recovery, and Git-port
  contract tests.
- `src/shared/workflow/validation-test-helpers.js#makeValidationProjectRoot` and `attachRecorder` — isolated real Plans,
  project state, `HostedSession`, and Runtime events.
- `src/testing/process-global-lock.ts#withProcessGlobalTestLock` — safe `HOME`, `PATH`, and working-directory mutation.
- `src/ui/tui/testing/interactive-composition-fixture.ts` and existing Golden TUI fixtures — real command-to-TUI
  composition without opening a browser or calling a model.
- `src/shared/work-records/mnemoteca-port.ts#WorkRecordMnemotecaPort` — shared external Mnemoteca process execution for
  Work Records and Sleep.
- `src/shared/session/architecture-boundary.test.js` and `src/shared/workflow/architecture-boundary.test.ts` — existing
  import and ownership fences for the validation engine.
- Existing network, browser, clipboard, CI, process, and model-discovery ports — retain them when their complete member
  set belongs to one external owner.

## Implementation Steps

- `scripts/external-capability-ports.json` has a validated, deterministic schema keyed by source declaration; every
  entry has one external owner and an exact non-empty member set, and duplicate, missing, stale, or
  implementation-valued entries fail `seams:check`.
- `scripts/check-injection-seams.js` resolves local, imported, and JSDoc required behavioral types and constructor
  arguments without a suffix exemption. Undeclared behavioral collaborators and mixed-owner aggregates fail while
  ordinary data objects pass.
- The complete current production-port inventory is accounted for: each genuine external contract is in the manifest,
  each mixed or internal contract is split or removed, and `scripts/injection-seam-baseline.json` remains empty with no
  second exception file or inline waiver. No declared contract multiplexes behavior through an opaque operation code,
  generic payload, or catch-all dispatcher.
- `ExecutionStartPorts`, `createExecutionStartPorts`, and `RecoveryFlowPorts` no longer exist. Execution start and Plan
  recovery call RunWield Worktree, Plan, settings-consent, interaction-policy, and metric owners directly while raw Git
  and clock operations use declared external capabilities.
- `startActiveExecutionWorkflow` tests exercise real reusable-Worktree lookup, target-branch policy, canonical Plan
  loading, consent persistence, and workflow metrics in isolated fixtures. A fake can supply Git/clock outcomes but
  cannot report a RunWield-owned transition as successful.
- Both `InteractiveSessionPort` declarations and `SYSTEM_INTERACTIVE_SESSION_PORT` are removed. Router, Agent, Init,
  Resume, and Sleep CLI routes reach real interactive-session composition; unit tests cover pure argument behavior and
  composed tests prove startup without replacing it.
- `AuthUiPort`, Sleep's `MnemotecaPort`, `SystemNotificationPort`, `ThemeDiscoveryPorts`, `BootRuntimeToolsPort`,
  `TerminalPairPort`, and `UpdateCheckPorts` no longer survive as mixed or multi-owner bags. Each caller either uses
  real RunWield machinery or a declared narrow external user/package/network/clock/process/terminal/Mnemoteca
  capability.
- Package prompt and WLD-extension resolution have no settings-manager override or `any` cast, resolve cwd through
  `getCwd()`, and read selected packages from sandboxed canonical settings.
- `ValidationSessionPort` and `SemanticReviewPort` are removed. `ValidationAgentPort` and `ValidationInteractionPort`
  are required at composition and contain no Plan, workflow, progress, Runtime event, registry, lifecycle, Work Record,
  or handoff operations.
- Validation repair and review policy is engine-owned: the engine creates typed Agent-turn requests, chooses Agents and
  prompts, applies completion gates and retry limits, and owns opaque conversation reuse; the Agent adapter only runs
  the request, translates external results, and reports external failures.
- A nominal `ValidationRuntimeContext` created from the real `HostedSession` owns workflow state, position, progress,
  Runtime event emission, active-interaction registration, assistant workflow messages, and current repair-conversation
  state. Plain-object construction and imports outside approved composition and engine modules fail architecture tests.
- Validation phase modules use canonical Agent display-name lookup directly, and the nominal runtime context invokes
  canonical HostedSession-based post-verification handoffs. Unused `setCurrentProgress` is gone, and no replaceable
  port, callback, or service-locator member exposes that machinery.
- Existing command, TUI, execution, recovery, resource, and validation tests retain their behavioral assertions but use
  real RunWield composition and fixture environments. Fakes remain only for manifest-declared external capabilities and
  fail loudly if a scenario unexpectedly reaches a real browser, model, CI process, terminal host, network, or Mnemoteca
  process.
- `docs/domain-language.md`, `AGENTS.md`, and `docs/plans/deep-semantic-source-modules.md` describe the implemented
  names, ownership rule, and move sequence. The glossary no longer names `ValidationSessionPort`, and no customer-facing
  Init prompt or check exposes this repository-private manifest.

## Approval Confirmation

No Work Record is proposed for supersession. This Plan builds on the verified zero-seam migration and
session-independent validation extraction rather than replacing their historical record.

## Verification Plan

- Automated checker contract: `deno run -A scripts/run-tests.js scripts/check-injection-seams.test.js`. Tests must fail
  for an undeclared imported `*Port`, a local all-required mixed port, a constructor-injected renamed collaborator, a
  stale manifest member, a missing declaration, a manifest entry for known RunWield machinery, and a declared generic
  dispatcher that routes an operation discriminator to both external and RunWield-owned work. They must pass for exact
  cohesive external declarations and ordinary immutable data.
- Automated focused behavior:
  `deno run -A scripts/run-tests.js src/shared/git-port.test.js src/shared/package-resources.test.js src/shared/extensions/wld-extension-manifest.test.js src/cmd/load-plan/plan-recovery-flow.test.ts src/cmd/auth/index.test.ts src/cmd/sleep/index.test.ts src/cmd/router/index.test.ts src/cmd/agents/index.test.ts src/cmd/init/index.test.ts src/cmd/init/init-verification-confirmation.integration.test.ts src/cmd/resume/index.test.ts src/ui/theme/theme-discovery.test.ts src/ui/tui/boot-banner.test.ts src/ui/tui/system-notifications.test.ts src/shared/session/architecture-boundary.test.js src/shared/workflow/architecture-boundary.test.ts`.
- Automated execution and validation behavior:
  `deno run -A scripts/run-tests.js src/shared/workflow/workflow.test.js src/shared/workflow/execution-progress.test.ts src/shared/workflow/plan-location.integration.test.ts src/shared/workflow/authority-continuation.integration.test.ts src/shared/workflow/orchestrator.test.ts src/shared/workflow/validation-*.test.*`.
- Automated repository gates: `deno task seams:check`, then `deno task ci`. The seam check reports zero without changing
  `scripts/injection-seam-baseline.json` or creating another exception source.
- Concurrency: run the complete `src/shared/workflow/validation-*.test.*` set twice in parallel through
  `scripts/run-tests.js`. Both runs use separate sandboxed homes, projects, Plans, and repositories and produce no lock,
  journal, or settings contention.
- Mutation proof:
  - add an internal method such as `recordWorkflowMetric` to a declared external port; the manifest/checker test fails;
  - restore an optional `SemanticReviewPort` fallback; `seams:check` fails;
  - replace `ValidationRuntimeContext` with a plain object or construct it from an unapproved module; the architecture
    test fails;
  - bypass real Worktree lookup, settings consent, workflow metric recording, Runtime event emission, or
    post-verification handoffs; a focused behavioral test fails;
  - remove the explicit Agent fake from a semantic-review scenario; the test fails loudly before any real model call.
- Preserved behavior: Workflow Validation still protects phase order, lifecycle transitions, repair limits,
  pause/resume, reviewer convergence, human review, publication, progress events, Manual QA, and Work Record outcomes.
  Router, Agent, Init, Resume, Sleep, auth, theme, boot banner, notification, package, and extension behavior remains
  unchanged.
- Behavior expected to stop: production code no longer exports or accepts the removed aggregate ports, and tests can no
  longer replace Session startup, settings managers, Worktree/Plan lookup, metrics, validation state, Runtime events,
  display-name lookup, completion policy, or post-verification handoffs.
- Semantic and manual inspection: trace every manifest member from its declaration through its production adapter and
  callers. Confirm that it translates one named external system's operation and answer, has no RunWield operation-kind
  switch or opaque multiplexer, and cannot report owned workflow work as complete. Confirm no entry names a `SYSTEM_*`
  object or RunWield Plan, Worktree, settings, metric, Runtime, registry, lifecycle, transaction, lock, Work Record,
  command-routing, or validation-state owner.
- Safety: compare `git status --short` before and after focused and concurrent tests. No test may create or change files
  in the real checkout `.wld`, real Plan directories, real settings, `~/.wld`, or the real Mnemoteca database, and no
  test may open a browser or contact a real model or network service.
- Documentation: confirm the glossary describes the implemented validation architecture, the source-move Plan uses the
  resulting names, and the existing Init prompt-contract tests still prove that repository-private checker details do
  not appear in customer guidance.

## Edge Cases & Considerations

- A required parameter is not automatically a valid external capability. Required syntax removes fallback ambiguity; it
  does not prove ownership.
- The checker must cover JavaScript JSDoc contracts and imported aliases as well as local TypeScript declarations. A
  rename, re-export, or constructor wrapper must not create an escape hatch.
- A port aggregate is valid only when all members belong to one external capability. A mixed `ports`, `deps`, `context`,
  or options object remains a dependency bag under a different name. One generic method with an opaque operation code is
  still an aggregate and must fail the ownership review.
- The nominal validation context must not become a service locator. It contains one run's state and Runtime bindings and
  cannot expose Plan storage, registries, lifecycle, settings, metrics, locks, or transactions for callers to replace.
- Pi conversation execution is external. RunWield's decisions about Agent role, prompt, completion, repair continuation,
  retry, and handoff remain engine-owned.
- Attached Mode is a future second composition root, not evidence that RunWield validation state is external. Keep the
  engine free of Pi and `HostedSession` implementation imports while reserving an approved product-owned context factory
  path for the Attached Workflow coordinator.
- Tests that mutate `HOME`, `PATH`, or cwd use `withProcessGlobalTestLock`; all source cwd/home reads use `getCwd()` and
  `getHomeDir()` at call time.
- Do not execute this Plan concurrently with `docs/plans/deep-semantic-source-modules.md`. Finish this ownership change
  first and then update the source-move Plan to move the resulting modules. If the move lands first, translate paths to
  the moved modules without restoring a legacy-port exception.
- The archived Init seam-risk work is complete. Keep it advisory and language-neutral; do not modify its archived Plan
  or introduce `wld check` ownership enforcement.
- Pure formatters and data transforms do not need ports.

[Mnemoteca]: https://github.com/gandazgul/mnemoteca
