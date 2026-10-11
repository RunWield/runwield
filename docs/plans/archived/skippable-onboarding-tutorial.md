---
planId: "363848da-a5f1-469e-8da0-b06ed9a89da5"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/cmd/registry.js"
    - "src/ui/tui/chat-session.ts"
    - "src/ui/tui/slash-dispatch.ts"
    - "src/shared/session/"
    - "src/shared/settings.js"
    - "src/agent-definitions/"
    - "docs/quickstart.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-11"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "user_validated"
validatedCommit: "6154c43495761781b3fe2cd2ca85a9640f8a755b"
workRecord:
    status: "generated"
    recordId: "05d1aa33-187b-4577-9be9-932a559522ea"
    path: "docs/work-records/2026-09-22-delivered-skippable-onboarding-tutorial.md"
    lastAttemptAt: "2026-09-22T16:17:42.129Z"
archivedAt: "2026-09-23T20:59:58.175Z"
archiveReason: "Merged; user validated and requested archive"
archivedFromStatus: "draft"
archivedFromPath: "docs/plans/skippable-onboarding-tutorial.md"
---

# Skippable Onboarding Tutorial

## Context

RunWield currently offers model setup and project initialization. Neither walks a newcomer through its central value:
review a Plan before code changes, then see implementation checked, independently reviewed, and delivered.

The user requested a draft Plan for a skippable onboarding tutorial, with OpenSpec initialization as a reference.

References inspected for this proposal:

- [OpenSpec init](https://github.com/Fission-AI/OpenSpec/blob/9d4e5974e5c0d9a09b9c6c1e1eb0975e80ec4461/docs/cli.md#openspec-init)
  creates project folders, configuration, and assistant integrations. Use its clear setup entry point as a reference;
  RunWield's existing Init additionally explores the repository and captures project knowledge.
- [OpenSpec onboarding](https://github.com/Fission-AI/OpenSpec/blob/9d4e5974e5c0d9a09b9c6c1e1eb0975e80ec4461/src/core/templates/workflows/onboard.ts)
  teaches the workflow through a small real change, explaining each stage and pausing at meaningful decisions.
- [OpenSpec existing-project guide](https://github.com/Fission-AI/OpenSpec/blob/9d4e5974e5c0d9a09b9c6c1e1eb0975e80ec4461/docs/existing-projects.md)
  starts with the area the user wants to change rather than documenting the whole repository.

Current RunWield evidence: `src/ui/tui/chat-session.ts` owns the startup Init offer; `src/ui/tui/model-welcome.ts` owns
model setup; `src/cmd/init/index.ts` and `init-completion.ts` own initialization; `docs/workflows.md` describes the
existing planned-work lifecycle.

Owning requirements and proposed changes:

- [Core: Project context and initialization](../../prd/runwield-core-prd.md#project-context-and-initialization): add
  **Optional guided first change**, with warning, permanent Skip, explicit entry, and truthful recap scenarios. Preserve
  **Preserve useful project facts and retrieve relevant context**, including separately approved Init work.
- [Core: Plan review](../../prd/runwield-core-prd.md#plan-review): preserve **Apply the user's review decision to the
  saved Plan**. Tutorial feedback, approval, saving for later, and cancellation use the same controls and consequences.
- [Core: Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery):
  preserve **Publish successfully or end only by deliberate user abandonment** and **Validate and deliver approved work
  without losing recoverable changes**. Stopping guidance does not end the delivery workflow or waive checks.
- [Core: Session continuity](../../prd/runwield-core-prd.md#session-continuity): preserve **Continue the same saved work
  across clients**. Add acceptance coverage for returning to TUI tutorial guidance without repeating work. Workspace
  tutorial controls are deferred, not ordinary Session continuity.

No existing requirement is removed. Follow [ADR-015](../../adr/015-file-authoritative-session-bundles.md); do not change
Session authority, writer ownership, or Plan lifecycle.

## Objective

A new user can choose a short guided first change, understand each major RunWield stage, and leave with real work and
its actual validation outcome. Every tutorial entry is optional. Skipping never prevents ordinary work.

## Approach

Confirmed scope: the tutorial guides a small real change in the user's project, with a warning before Start. It does not
use a disposable sample. The user confirmed TUI-only guidance for this release, through `/onboard` and `wld onboard`,
reusing existing browser review surfaces. A Workspace-native tutorial is deferred. The tutorial teaches the workflow
through existing agents and controls; it does not introduce another implementation agent or a second Plan lifecycle.

### Entry and skipping

- On an eligible fresh interactive startup, after model setup and the existing Init decision, show one brief offer:
  **Start tutorial** or **Skip**. Do not interrupt a supplied initial request, a resumed Session, an active workflow, or
  a headless invocation. Eligibility means a new empty interactive Session with no saved handled preference; this
  includes existing installations on their first eligible startup after the feature ships. Empty or unsuitable projects
  keep ordinary startup guidance instead of an automatic tutorial offer. Do not change existing Init offers for
  unrelated commands or Session resumes.
- Skip returns immediately to normal input and permanently suppresses automatic tutorial offers at the user level,
  across restarts and repositories. There is no later reminder or expiry. Explicit `/onboard` remains available.
  Starting also marks the offer handled. Keep offer/completion preferences separate from project Init state.
- Displaying or skipping the offer starts no model work and creates no persisted Session, Plan, or repository file. Only
  the user-settings preference may change. This guarantee concerns the tutorial: it does not prohibit work from an
  earlier, separately accepted Init offer. Explicit `wld onboard` must defer startup Init until after tutorial consent.
  Non-interactive `wld onboard` explains that a terminal is required and exits without starting work.
- Every entry shows this warning before Start: **This tutorial makes a real change in your current project and uses your
  configured AI model. You will review the Plan before implementation. Normal checks and delivery approvals still
  apply.** Show the current project path with the warning. Choosing Start submits an explicit tutorial request through
  the ordinary Session activation path. Cancelling the offer has the same no-work, permanent-dismissal effect as Skip.
- Explicit entry shows the warning before tutorial-triggered setup. If model setup or project initialization is needed,
  explain it and reuse the existing flows after Start; do not rerun completed Init or make Init mandatory merely for the
  tutorial. Cancelling tutorial-triggered setup returns to input without marking the tutorial complete; chat still needs
  a configured model. Preserve ordinary startup model-setup cancellation behavior outside explicit tutorial entry.

### Guided journey

1. **Choose a real improvement.** After Start, inspect a bounded area and suggest at most three small changes with
   observable success criteria. The user can supply their own. Avoid broad migrations or invented work. Explain that
   this exercise deliberately uses a Plan so the user can experience review, even if the change could be a quick fix.
2. **Shape the request.** Briefly show how exploration clarifies the desired outcome. Mention Ideator for open product
   questions and Architect/Slicer for larger projects; do not force a tour of every agent.
3. **Plan and review.** Use Planner and ordinary Plan Review. Explain annotations, revision, Approve for Later, and
   Approve & Run when they become relevant. Practicing a revision is optional; approval remains a real decision.
4. **Implement.** The normal Plan Engineer or Frontend Engineer executes. Explain worktree isolation and how to pause or
   redirect. Narration follows actual workflow events; it never advances execution itself.
5. **Validate and deliver.** Explain project checks, AI review, any actual repairs, and available Code Review and
   delivery controls. Show failures honestly. Do not manufacture a failure for teaching or claim delivery before the
   normal workflow establishes it.
6. **Recap.** Link the actual Plan, available review/QA artifacts, and Work Record. Explain the outcome and how to begin
   ordinary work. Complete the tutorial only after the real change reaches RunWield Verified and the recap is shown.
   Other completion modes remain accurately labeled and can end the tutorial without counting as full completion.

Each stage gets a short explanation tied to the user's work. Optional explanations can be dismissed. Avoid repeated
Continue prompts between stages that require no user decision.

### Exit and resume

At teaching checkpoints, **Continue without tutorial** removes narration while preserving the normal workflow. **Pause
tutorial** requests the same cancellation as Escape and preserves work already done. During active work, teach the
existing Escape control; `/onboard` remains an ordinary queued command, not a second stop mechanism. Do not describe
Ctrl+C as pause: its first press clears input. A pause request is not proof that work stopped; report the actual settled
state. Plan Review cancellation keeps its normal recovery choice. Skipping instruction never means approving a Plan,
skipping validation, deleting work, or authorizing publication.

Store only guidance context with existing Session persistence. Derive work progress from the associated Plan/workflow,
not duplicated tutorial statuses. Resuming a guidance-enabled Session offers to resume guidance or continue ordinarily;
a Session where guidance was disabled stays quiet unless `/onboard` is requested. Use existing Session and Plan
recovery, not the initial tutorial prompt, to continue work. Never create a second Plan, execute completed steps again,
or repeat delivery. Missing context must not cause a guessed Plan association or success claim; preserve work and use
the existing recovery path.

### Implementation path

```text
startup offer / wld onboard / /onboard
  warning and project path → Start or Skip
  Start → existing setup when needed → ordinary Planner user turn
  plan_written → normal Plan Review → approved execution → validation and delivery
  committed workflow facts → TUI explanations and truthful recap
```

- `src/cmd/registry.js` registers a TUI-only slash command and interactive CLI entry. `wld onboard` opens the deferred
  TUI shell; it must not run Init or a model before the warning. Allow `/onboard` through the model-readiness command
  gate so it can show consent and then setup. Do not use test-only startup bypasses in production.
- After Start, submit one visible tutorial request through `SessionRuntime.promptUserTurn` with `AGENTS.PLANNER`.
  Preserve the input controller's busy state, synchronization, cancellation, and draft restoration. The first request
  asks for bounded discovery and user selection before Plan authorship; it does not authorize implementation. Use
  bundled instructions for this request, not a new agent or teaching instructions injected into execution/repair agents.
- Use a global custom settings key, registered in `RUNWIELD_CUSTOM_SETTING_KEYS`, for the handled offer. Read the global
  value, not a project override. Later model or theme setting saves must preserve permanent Skip.
- Keep a versioned Session custom entry for guidance enabled/disabled, shown explanation IDs, recap shown, and the
  selected Plan's durable `planId` when known. Derive that identity from committed Plan Association evidence. Do not
  store workflow phase, approval, or delivery success in the tutorial entry. Write the initial entry inside the accepted
  first-turn managed operation, before model work; later updates use the same Session writer ownership.
- Restore that entry through `HostedSession`, Session snapshots, and read-only transcript projection. In
  `rollSessionTranscriptSegment`, carry forward the latest committed tutorial context before the successor is committed,
  for both execution and semantic repair. Old Sessions without the entry behave unchanged. Reuse the existing custom
  entry pattern in `workflow-context-session.js`, not unrecognized fields that its normalizer discards.
- TUI notices use existing workflow events and facts: awaiting Plan Review, approved execution, project checks, AI
  review/repair, Code Review when enabled, and confirmed delivery. Deduplicate explanations across replay and rollover;
  normal workflow status still reports each real failure or repair. Ordinary non-tutorial Sessions get no teaching copy.
  The generic workflow presentation's completed flag is insufficient: `user_verified` and `closed_without_verification`
  are not RunWield Verified. Full recap requires actual `verified` status, confirmed publication, and available artifact
  evidence. Missing optional artifacts are omitted, not replaced with invented links.

A static sample-only walkthrough was set aside because it would not demonstrate actual review and verification. A
mandatory first-run wizard was set aside because experienced users should reach their own task immediately.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cmd/onboard/` (new), `src/cmd/registry.js`, `src/ui/tui/slash-dispatch.ts` — explicit tutorial entry and
  controls.
- `src/ui/tui/chat-session.ts`, `src/ui/tui/model-welcome.ts`, `src/cmd/init/` — place the optional offer around
  existing setup and preserve cancellation, empty-project behavior, and deferred Session activation.
- `src/shared/settings.js` and its existing schema/persistence owners — user-level offer preferences.
- `src/shared/session/` — tutorial context through `SessionRuntime`, `HostedSession`, transcript projection, and
  `segment-rollover.ts`; preserve context across execution/repair without introducing another workflow owner.
- `src/agent-definitions/` or bundled instructional assets — concise teaching instructions around existing role work.
- `src/ui/tui/chat-input-controller.ts`, `runtime-adapter`, and related TUI tests — ordinary submission, cancellation,
  restored guidance, and event-based teaching notices; no independent review UI.
- Session rollover/runtime tests and `src/ui/tui/golden-scenarios/` — prove real consent, continuation, and delivery,
  not just matching tutorial text.
- `docs/quickstart.md`, `docs/usage.md`, `docs/prd/runwield-core-prd.md` — command help, warning, permanent Skip, and
  the owning capability's requirements/scenarios, updated in the implementation change.
- `docs/domain-language.md` — define Tutorial as optional TUI guidance around one real Planned Change. It is not Init, a
  separate Plan lifecycle, or a substitute for Workflow Validation. Preserve AI review and Code Review terminology. Do
  not promote these proposed behaviors into current documentation during planning.

## Reuse Opportunities

- Command registry and slash dispatch for shared entry/help semantics.
- Existing model welcome, Init completion checks, and empty-project detection for prerequisites.
- Existing Session activation, transcript continuity, workflow events, and cancellation for progress and recovery.
- Planner, Plan Review, execution handoff, validation, delivery, and Work Record generation for actual work.
- Existing TUI prompts/notices and shared browser review surfaces. Any necessary browser change follows
  `docs/design-system.md` and `src/ui/design-system/`, using semantic tokens.
- Real Git/project fixtures and composed-TUI/golden tests. No new seams for RunWield-owned machinery.

## Implementation Steps

- [ ] Startup, `/onboard`, and `wld onboard` show the real-project warning and current project path, with explicit Start
      before tutorial discovery. Both commands expose the same guided journey and help text.
- [ ] Eligible startup offers the tutorial once. Skip leaves ordinary input usable and permanently suppresses automatic
      offers across restarts and repositories, without expiry. Explicit invocation remains available after skipping or
      completing.
- [ ] The offer itself and Skip cause zero model calls and no persisted Session or repository artifacts. Separately
      approved Init work remains permitted. Tutorial offers are suppressed for initial requests, resumed Sessions,
      active workflows, and non-interactive use; explicit CLI entry requires an interactive terminal.
- [ ] Setup uses existing model/Init flows. Cancelled setup cannot create false Init or tutorial completion.
- [ ] One selected improvement becomes one ordinary draft Plan, enters real Plan Review, and executes only through the
      approved workflow. Feedback and Approve for Later behave exactly as in ordinary planned work.
- [ ] Teaching messages reflect actual stage changes and distinguish checks, review, validation, and delivery.
      Failure/repair states cannot display an invented success.
- [ ] Continue without tutorial, Pause, and resume preserve the current Plan, edits, approvals, and delivery state.
      Guidance context survives both execution and repair segment rollover. Disabled guidance stays disabled. A pause
      request uses existing cancellation and does not report settlement early; resumption does not duplicate work.
- [ ] Verified delivery produces a useful recap with valid artifact links. A failed, paused, manually verified, or
      closed-without-verification Plan cannot masquerade as a completed verified tutorial.
- [ ] Behavioral tests cover the journeys below. Command documentation and the owning Core capabilities describe the
      shipped warning, permanent Skip, entry, resume, and recap scenarios. Shared review/recovery requirements remain
      authoritative; deferred Workspace guidance stays labeled deferred and affected references are updated.
- [ ] `docs/domain-language.md` defines Tutorial and its relationship to a Planned Change, Init, and Workflow
      Validation; implemented behavior, teaching copy, and glossary agree, including AI review versus Code Review.

## Approval Confirmation

No Work Record supersession is proposed. The user confirmed a real project change with a warning before Start, permanent
Skip, and TUI-only guidance using existing browser review pages. Explicit entry remains available after Skip. The
existing draft's guided journey and pause/resume behavior are retained through normal workflow controls. This Plan is
ready for scope review; it does not itself authorize implementation.

Reviewable defaults: existing installations receive one eligible offer if no preference exists; cancelling that offer
counts as Skip. Existing users are not forced into the tutorial, and explicit entry remains available.

## Verification Plan

Use the real settings, Session, Plan, and Git owners. Fake only external capabilities such as model turns and command
execution where an existing supported boundary permits it. Resolve home/cwd through project helpers and protect tests
that mutate them with `withProcessGlobalTestLock`.

- Automated: run the commands below, plus any new focused tutorial test files with the same safe runner. Then run
  `deno task ci`, including the zero-seam check. Never use `deno test` directly.

  ```sh
  deno run -A scripts/run-tests.js src/ui/tui/chat-session.test.ts src/ui/tui/slash-dispatch.test.ts src/ui/tui/model-welcome.test.ts src/shared/settings.test.js
  deno run -A scripts/run-tests.js src/shared/session/session-runtime.test.js src/shared/session/segment-rollover.test.js
  deno run -A scripts/run-tests.js src/ui/tui/golden-scenarios/initial-scenarios.test.js src/ui/tui/golden-scenarios/planned-change-workflow.test.ts src/ui/tui/golden-scenarios/session-resume-workflow.test.ts src/ui/tui/golden-scenarios/validation-publication-journey.test.ts
  ```
- Composed startup: test Start, Skip, restart, another repository, explicit invocation after dismissal, existing users,
  and no-model cancellation. Assert Skip remains suppressed after a large clock advance, a model/theme settings save,
  restart, and repository change. Project settings cannot override it. With setup already complete or declined, assert
  zero model calls and no Session/Plan/repository writes from the offer or Skip. In a separate case, accept Init first
  and prove its authorized work is unaffected. For explicit `wld onboard`, even an uninitialized project must not start
  Init before tutorial consent. Every entry must show the warning and current project. Cancelling the warning starts no
  tutorial work and persists dismissal. Non-interactive CLI entry must not hang or start work.
- Preserve existing startup coverage: empty prompt remains unpersisted, explicit requests run without tutorial
  interception, empty repositories remain usable, `/new` and loaded Sessions retain their activation/continuation
  behavior. Ordinary model-setup cancellation remains unchanged; tutorial-triggered setup cancellation returns to input
  without falsely marking setup or the tutorial complete. No existing workflow behavior or coverage is retired.
- Real temporary Git project: drive Start through the actual tutorial command, select a small behavioral change with a
  test that fails before implementation, then exercise Plan feedback, revision, approval, execution, validation, and
  verified delivery through the ordinary workflow. Script only external model/reviewer turns. Assert one Plan, no
  implementation before approval, the changed behavior, and delivered Git ancestry. Capture ordered TUI output: each
  stage explanation must describe the current work and follow its real event, not a canned sequence. Run an ordinary
  non-tutorial change as a control: it must show no tutorial copy. The existing publication golden test starts from an
  implemented fixture; it cannot replace this new Start-to-delivery journey.
- Failure path: a failing project check or reviewer finding must show the true failure/repair and prevent the verified
  recap. User Verified and close-without-verification must retain their distinct outcomes.
- Pause before approval and during execution; settle cancellation, reload the Session, and resume through normal
  controls. Assert one Plan, preserved edits and approvals, and no repeated implementation or publication. Approve for
  Later must stop execution. Carry guidance through real execution and semantic-repair segment rollovers, discard the
  in-memory runtime, and reload from committed files. Confirm shown explanations do not repeat, unshown stages still
  appear, disabled guidance stays off, and `/onboard` restores guidance for the same Plan without restarting discovery.
  After verified delivery, reload and prove the recap does not cause a second publication.
- Manual TUI/browser walkthrough: new-user Start, skip to a normal question, explicit `/onboard` after skip, annotate
  the real Plan Review, pause/resume, dismiss narration, finish a small change, and open recap artifacts. Confirm
  keyboard/cancellation behavior and concise instructions. Existing browser review rendering remains intact.
- Semantic review: confirm the tutorial cannot write approval, validation, or publication truth. Completion must read
  real workflow evidence; a generic completed display flag cannot count. Confirm capability links, glossary, command
  docs, and shipped scenarios agree, with Workspace guidance still deferred.
- A no-op command or scripted success narration must fail these tests: neither can deliver the required behavior,
  produce real approval evidence, preserve resumed work, or establish verified delivery. A plain Planner pass-through
  must also fail the required event-timed teaching and persisted guidance assertions.

## Edge Cases & Considerations

- Empty directory or unsuitable project: explain why a real tutorial change cannot start yet; let the user return to
  normal work and invoke `/onboard` after meaningful code exists. Do not create sample files automatically.
- Active work: explicit invocation explains the current work and offers a deliberate new Session rather than replacing
  it. An in-progress tutorial resumes its existing work.
- Large user-selected request: recommend a small useful slice; keep the full request available for ordinary planning.
- Dirty checkout, missing Git, absent real verification, unavailable browser, or publication permission: follow existing
  workflow behavior and report limitations. Do not weaken checks merely to finish the lesson. An Init placeholder
  verification command must be disclosed; never describe its successful exit as real test coverage.
- Model latency and project CI vary: present a short guided exercise, not a guaranteed completion time. Starting the
  tutorial does not grant extra commit/push permission beyond the normal user-approved workflow and repository policy.
- Cross-device tutorial narration and a standalone Workspace onboarding UI are outside this draft. Ordinary Plan and
  Session continuity remain available through existing supported surfaces.
