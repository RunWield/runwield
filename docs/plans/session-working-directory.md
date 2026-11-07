---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/tools/session-directory.ts"
    - "src/tools/registry.ts"
    - "src/shared/session/"
    - "src/shared/git.ts"
    - "src/shared/project-checkout.ts"
    - "src/extensions/mnemoteca/tools.ts"
    - "src/agent-definitions/planner.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-10-31"
status: "draft"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
planId: "33524da7-a2b5-4ed0-b968-10d4a84e12b1"
---

# Session Working Directory and Checkout Context

## Context

**Move the Session, not just one shell command.** The owner approved movement between packages and existing worktrees
within one Project. Cross-Project routing was considered and explicitly deferred. Inspection must remain available
while execution, review, repair, or publication blocks movement.

The [proposal](../prd/session-working-directory-prd.md) defines three target capabilities:

- **Checkout inspection and prompt context:** identify the checkout and evidenced Plan/Epic ownership, including an
  available Epic planning worktree.
- **Same-Project Session movement:** subsequent tools, applicable instructions, and resume use the selected location.
- **Workflow-bound movement restrictions:** the harness blocks moves during protected phases, including waiting Plan
  and code review. These restrictions also apply to moves into package folders.

Lasting requirements belong in Core [Project context and initialization](../prd/runwield-core-prd.md#project-context-and-initialization)
and [Session continuity](../prd/runwield-core-prd.md#session-continuity). Preserve
[execution, validation, and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery), Session history,
Project ownership, command-local `cd`, and workflow-owned checkout transitions.

Current code binds tools and context in `buildAgentSession`. `switchActiveAgent` can rebuild at another cwd, but its
public runtime entry rejects active turns. Continuation reads the segment's `transcriptCwd`; rebinding the live Session
alone does not save a move. Git prompt context currently reports branch and clean/dirty state only.

The separate [Plan Store proposal](../prd/plan-store-prd.md#plan-store) remains out of scope. Moving to an Epic worktree
selects its code; it does not guarantee discovery of a new uncommitted child Plan under current branch-local storage.

## Objective

One `session_directory` tool inspects or moves a root Session within its Project. Harness-supplied prompt facts identify
its current checkout and known Epic context. Moves preserve Project and Session identity, refresh location-dependent
capabilities, survive reopen, and cannot bypass protected workflow phases.

## Approach

### One fact reader, one Session operation

Use a shared, read-only checkout-context reader for the tool and system prompt. It resolves canonical folder and checkout
paths, Git common-directory identity, branch/dirty state, and known worktree ownership. It does not prepare, repair, or
create worktrees. Match registry paths to the checkout root, not the package folder; validate Plan IDs and explicit
`parentPlan` metadata rather than inferring ownership from branch names.

The proposed tool interface is `session_directory({ action: "inspect" | "move", path?: string })`. A move requires a
path; inspection does not. Relative paths resolve from the current working directory. The response reports current cwd,
stable Project root, checkout identity, ownership/Epic availability, and movement eligibility with a blocking reason.

Keep three locations distinct:

```text
Project root       -> Session catalog, memory identity, Project association
Selected checkout  -> checkout-specific settings, Plan document resolution, root instructions
Working directory  -> relative file tools, commands, package instructions
```

Use canonical Git common-directory equality for Git Projects. This admits linked worktrees and packages, but rejects
another clone, submodules, and nested repositories with a different common directory. For non-Git Projects, use canonical
containment within the saved Project root; reject symlink escapes and nested Git repositories. Git probe errors are not
proof that a Project is non-Git.

### Apply movement at a settled turn boundary

The tool requests a Session operation; it does not mutate process cwd or replace its own running Agent. Reuse the typed
root-turn handoff pattern to stop further tools from the old root, settle the turn, recheck movement eligibility, and
apply the change through SessionRuntime using the current managed-operation capability and Session Writer Lock. Do not
reacquire the lock or call idle-only `switchAgent` from the running operation. A request acknowledgement is not a
successful move. Continue the same request with a generated completion/failure result, not a second user message.

The replacement root must use destination tools and context before work continues. Prepare the replacement without
losing the previous usable root. Reload location-dependent resources, including Model Context Protocol (MCP) tools,
against the destination rather than the old HostedSession cwd. Keep the selected Agent and explicit model choice.

**Persist the selected working location as Session evidence, not a new Project or a rewritten transcript header.** Use
a versioned committed transcript entry and a shared effective-location resolver. Existing segment origin and safety
checks remain intact. Restore the saved location before root activation, preserve it through compaction, and retain
workflow-owned execution-location precedence. Legacy Sessions without the entry retain their current behavior.

This is a proposed internal design. Update ADR-011 and ADR-015 with the distinction between Project ownership, transcript
origin, and selected working location. A new transcript segment for each folder move was set aside because movement
should not reset model context or require execution-handoff payloads.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/tools/session-directory.ts` and `registry.ts` — typed tool contract and universal root-Agent availability.
- `src/shared/session/` — shared checkout facts, effective location, guarded movement, durable evidence, root-turn
  handoff, tool rebuilding, continuation, and behavioral tests.
- `src/shared/git.ts`, `project-checkout.ts`, and worktree/controller registry readers — reuse read-only Git and ownership
  evidence; normalize package paths before checkout-scoped operations.
- `src/shared/settings.js`, `src/extensions/mnemoteca/tools.ts`, and cwd-bound resource/tool composition — distinguish
  working folder from Project or checkout ownership where the current code conflates them.
- `src/agent-definitions/planner.md`, Router guidance, and shared tool descriptions — explain inspection and movement
  without promising that cwd changes fix Plan storage.
- Core PRD, the transient proposal, glossary, ADR-011/015, and relevant user documentation — record delivered behavior,
  preserve deferred scope, and update references together.

No Plan Store migration, cross-Project move, worktree creation, external-host cwd control, new visual UI, or new workflow
pause mechanism is included. TUI, ACP, and Workspace use the same Core operation.

## Reuse Opportunities

- `src/tools/set-session-name.ts` — tool factory and typed text/details results.
- `src/tools/registry.ts:UNIVERSAL_AGENT_TOOL_NAMES` and Session tool resolution — all root Agents receive the tool
  without repeating an allowlist change in each definition.
- `src/shared/session/root-workflow-turn.ts` — typed, root-owned event handoff and old-root settlement, not parsing tool
  result prose. Directory movement is not a workflow advancement tool.
- `switchActiveAgent`, `RuntimeAgentSettings.activateSessionAgent`, and managed operations — root rebuilding and the
  existing mutation authority; do not add a second lock or an injection seam for owned Session behavior.
- `inspectWorktreeRegistry`, `inspectControllerDocumentWorktrees`, `loadPlan`, and read-only Plan location resolution —
  known ownership without repair side effects.
- `defineGitFixture`, `makeValidationProjectRoot`, and the runtime scripted-model fixtures — real Git/storage/tool
  integration with only the model or other genuine external boundary substituted.

## Implementation Steps

1. **Checkout inspection reports verified facts without changing the repository.** A shared TypeScript reader under
   `src/shared/session/` returns named types for working folder, stable Project root, checkout root/type, Git state,
   Plan/Epic ownership, and missing or ambiguous evidence. Git probes use the destination's canonical checkout root and
   common directory; registry reads use the existing inspection APIs. Disable optional Git index writes and lazy fetch
   during inspection. No inspection path enters runtime preparation,
   repairs registry state, creates directories, or creates a planning worktree. Preserve basic checkout facts when
   ownership cannot be read safely.

2. **Location-dependent behavior uses the right root.** `buildAgentSession`, its bridged-tool composers, prompt
   assembly, settings/resource loading, and memory binding distinguish working folder from checkout/Project ownership.
   Package movement keeps checkout-level configuration and the same memory collection. Plan and Work Record tools do
   not start looking under `package/docs/plans`. Worktree movement uses the destination checkout's applicable documents
   and configuration without copying them. Load root-to-destination instruction files in path order, preserving
   RUNWIELD.md-over-AGENTS.md precedence at each directory; do not include siblings or ancestors above the Project's
   checkout root. Keep the loaded-instruction report and context projection consistent with the actual prompt.

3. **One eligibility rule governs inspection and movement.** SessionRuntime derives the blocking phase from the
   Session's owned workflow, active review operations/interactions, and retained controller evidence when applicable.
   It covers QUICK_FIX and planned execution, mechanical/AI/code review and validation, Plan review (including its
   conversation and waiting state), semantic repair, and publication. Expose and tighten the existing
   `PlanReviewConversationOwner` active-review lifecycle so answering a review question does not briefly permit a move
   before its conversation ends. Use `stopCapture`/final decisions to release that state. Add a scoped runtime activity
   fact at an existing operation owner only where no authoritative fact exists; do not use the footer, selected Agent
   name, or generic model-busy flag as authority. Idle Planner and Engineer exploration remain eligible. A stale
   last-review reference is not an active review. Guard checks happen both when accepting a request and immediately
   before applying it.

4. **A move is a typed root-owned handoff, not an in-tool root replacement.** `session-directory.ts`,
   `root-workflow-turn.ts`, `agent-handler.ts`, and runtime turn handling accept a move from the current root only,
   stop further old-root tool dispatch, wait for the running turn to settle, and apply it under the existing managed
   mutation capability. Cover `planning-agent.ts::runPlanningAgent` and direct `runActiveAgentTurn` callers such as Slicer,
   not only `createAgentHandler`; the move is consumed internally and never becomes a `decidePostPlanning` result.
   Preserve queued steering exactly once through the root transition. Use the typed event transport if needed, but do
   not put this tool in `WORKFLOW_ADVANCEMENT_TOOL_NAMES`, parse response prose, release a workflow, or replay an old
   accepted move on resume.
   Isolated Agents cannot move their parent Session. Duplicate/stale root requests cannot apply a second transition.
   A generated result continues the current user request only after success or a clear refusal; no extra user message,
   model-choice reset, or task-completion event is fabricated.

5. **Successful moves rebuild and persist one consistent working context.** A dedicated Session location owner
   validates the existing destination against the saved Project, builds destination tools/resources, and commits the
   selected location as versioned transcript evidence using the existing Session Writer Lock and generation protocol.
   Do not use `ensureSessionProjectForCwd` to register or create the destination. Stage new MCP integration using the
   destination checkout/configuration and cwd; discard it on failure and close replaced resources only after the new
   context is accepted. `switchActiveAgent`/`activateSessionAgent` retain their existing ownership guarantees. Failed
   validation or root preparation leaves the previous context usable and records no successful location change.
   Split the existing root builder into prepare/commit stages where required so location-write failure cannot detach
   the old root. Read selected-location evidence only from the committed generation; uncommitted or failed requests
   never become effective merely because text was appended. Commit failures remain truthful recoverable failures, not
   a successful response or a silently mixed root.

6. **Reopen and compaction restore the committed location without changing transcript identity.** Extend the shared
   effective-location resolver across `session-continuation.ts`, lifecycle loading, managed hydration/synchronization,
   image preflight, and root activation where they currently equate `transcriptCwd` with working cwd. Keep transcript
   opening and digest verification tied to the original segment evidence. Carry the latest location entry through
   compaction and necessary segment transitions. Active workflow checkout ownership overrides it; publication cleanup
   retains its existing restoration behavior, while a later explicit allowed move must not be overwritten by an old
   delivery. Older transcripts without a location entry need no migration. Session IDs, Project IDs, history, Plan
   Associations, Workspace registration/access, and other Sessions' cwd remain unchanged.

7. **Every root Agent receives a usable tool and current prompt facts.** Register `session_directory` through universal
   Agent policy and wire both Pi and `composeClaudeCliBridgedTools` (also used by the Antigravity bridge). Inspection
   stays available in protected phases; movement refuses them mechanically. Do not grant parent mutation to delegates
   or promise this tool through Connect's external-host role instructions. Prompt assembly and the loaded-context
   report use the shared reader at start, resume, and root rebuild. Planner gets a short instruction to inspect checkout
   ownership and move to the relevant available Epic planning checkout before planning additional Epic work when
   needed. It must not claim that doing so publishes or shares child drafts. Router remains a discovery/routing Agent.

8. **Behavioral regressions prove the feature and preserve existing ownership.** Tests use real temporary Projects,
   Git worktrees, Session bundles, and registered tools. A scripted model can request the move, then call the actual
   read/write/bash tools. Add a focused `session-directory` suite and preserve the existing runtime, prompt, tool-policy,
   safe-root opening, review, rollover, and publication-restoration coverage described below. No new seam for owned
   transition, storage, registry, or lock behavior is allowed.

9. **Documentation describes the delivered capability in the same change.** Update Core's owning capabilities and
   acceptance scenarios, `docs/domain-language.md` Session/Project relationships and avoided aliases, ADR-011's Session
   root model, ADR-015's committed location evidence and restoration precedence, and `docs/user-documentation/sessions.md`.
   Consolidate fulfilled requirements from `docs/prd/session-working-directory-prd.md` into Core, remove the completed
   transient proposal, and update references (including this Plan's requirements links). Preserve any unmet intent as
   explicit target/deferred scope. Keep Plan Store and cross-Project movement separate and unimplemented.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

### Automated

Use Bun 1.4.3 and run `bun run install:locked` before checks. Do not use direct `bun test`.

Add `src/shared/session/session-directory.test.ts` for runtime journeys, `src/shared/session/checkout-context.test.ts`
for read-only facts/identity, and `src/tools/session-directory.test.ts` for the tool contract.
Reuse `src/cmd/testing/runtime-command-fixture.ts::withRuntimeCommandFixture` and
`src/shared/mcp/fixture-server.ts` with real storage; do not fake the runtime transition itself.

Focused commands:

```sh
bun scripts/run-tests.js src/tools/session-directory.test.ts src/shared/session/session-directory.test.ts src/shared/session/checkout-context.test.ts
bun scripts/run-tests.js src/shared/session/session-runtime.test.js src/shared/session/agent-switching.test.ts src/shared/session/session-prompt.test.js src/shared/session/__tests__/session-tools-policy.test.js
bun scripts/run-tests.js src/shared/workflow/planning-worktree-inspection.test.ts src/shared/workflow/controller-registry.integration.test.ts src/acp/managed-session.integration.test.ts
bun scripts/run-tests.js src/shared/session/execution-segment-runtime.test.ts src/shared/session/segment-rollover.test.ts src/cmd/load-plan/plan-review-conversation.integration.test.ts src/shared/workflow/plan-execution-runtime-boundaries.integration.test.ts src/shared/workflow/validation-tool-continuation.integration.test.ts
bun run seams:check
bun run doc-links:check
```

Required evidence:

- **Real package and worktree movement:** distinct sentinel files and instructions in checkout A, its package, and
  linked checkout B. Have the scripted Agent call the real tool, then actual relative read/write and `pwd`. Assert
  destination contents, writes only at the destination, destination instructions, retained root instructions/settings,
  unchanged memory collection and Project identity, and no stale MCP configuration. Repeated inspect cannot substitute
  for movement. A cwd-label-only implementation or shell-only `cd` must fail this test.
- **Durable continuity:** close the runtime/store, reopen the same Session from a fresh runtime, and perform another real
  relative read and command. Repeat after compaction. Assert stable Session/Project IDs, old history and Plan links,
  original transcript-header validation, and restored destination context. Assert a second live Session did not move.
- **Protected phases:** drive real workflow/review ownership into each blocked phase, including a waiting Plan review,
  standalone code review, QUICK_FIX, retained/paused execution, repair, and publication. Inspect reports the phase;
  moves to both package and worktree destinations are refused and leave actual tools and saved location unchanged.
  Reopening retained execution does not bypass the guard. After the owner releases the protected phase, an eligible
  move succeeds. Agent-name-only or model-busy-only guards must fail these cases.
- **Transition safety:** request a move followed by an old-root write in the same scripted tool batch; the old-root write
  must not execute after acceptance. Test stale/duplicate and isolated-source requests, a phase becoming protected
  between request and application, cancellation before commit, and failed destination root/resource preparation and
  location persistence. Use real filesystem failure conditions; do not add a fake persistence seam. Cover queued
  steering, movement during `runPlanningAgent`, and a direct `runActiveAgentTurn` path. No successful location entry or
  success message may precede a completed move. Previous tools remain usable after a
  precommit failure; reopen after a committed move uses the destination without replaying the move request.
- **Ownership and no side effects:** primary, managed child, unmanaged linked worktree, detached HEAD, missing Epic path,
  mismatched Plan ID, ambiguous registry entry, and unreadable ownership evidence produce truthful inspection. Snapshot
  Git status/index, refs, registry/controller files, and worktree list before/after inspection and prompt assembly.
  These operations must not migrate, repair, create, or alter them.
- **Project boundary:** another repository, another clone with the same remote, nested Git repository, submodule,
  nonexistent path, file path, and symlink escape are refused. Canonical aliases within the Project and legitimate
  linked worktrees succeed. Non-Git descendants keep the original memory identity and root configuration. Probe errors
  do not grant access by falling back to non-Git rules.
- **Tool reachability and adapters:** actual Router and Planner roots expose both operations, protected roots still
  expose inspect, and isolated delegates cannot mutate the parent. Exercise bridged-tool composition with the same
  typed request/result semantics. Use the existing ACP managed-runtime integration fixture to reopen and continue a
  moved Session; no adapter may implement its own cwd mutation or broaden Workspace authorization.

### Preserved coverage and semantic review

Existing tests must continue to protect manual model choice, active Agent/handler agreement, rejection of synthetic
switch-requesting tool results, once-only steering delivery, Session writer exclusion, transcript origin checks,
worktree image hydration, execution/semantic-repair rollover, and post-publication Project restoration. Keep or adapt
these tests against the new shape; do not delete their behaviors. Only the assumption that working cwd always equals
transcript origin is expected to stop applying after an explicit move.

Inspect the implementation for one fact reader and one movement eligibility rule. Verify no `process.chdir`, Project
re-registration, header rewrite, branch-name ownership inference, UI-state authority, or Plan-copy mechanism was added.
Check that applicable instruction order, root settings, memory identity, and document roots remain correct for packages.
Verify the Core PRD, glossary, ADRs, user documentation, and remaining references match delivered behavior.

### Manual

1. In a disposable monorepo, start Router from a package. Ask for checkout information. Confirm the package cwd and
   checkout root are distinct and correct. Move to another package; ask it to read a relative file and run `pwd`.
2. Start Planner in a managed Epic-child worktree. Inspect the parent Epic path, move to it, and confirm subsequent code
   inspection uses that checkout. Confirm the tool makes no claim that sibling drafts are published or shared.
3. Close and reopen the Session in TUI or Workspace. Confirm the same conversation and selected location. Continue it
   through ACP using the existing Session continuation path; tools must agree on the location.
4. During a review wait and an execution/repair workflow, inspect successfully and attempt a move. Confirm a clear
   phase-specific refusal and no change to the workflow's checkout. Finish or leave the phase through its existing
   owner; confirm movement becomes available only when no protected phase remains.

No visual redesign is included; browser pixel or layout acceptance is not required.

## Edge Cases & Considerations

- **No implicit move:** inspection and prompt construction only report facts. An available Epic path is not an
  instruction for the harness to move automatically.
- **Checkout-local Plans remain checkout-local:** do not migrate or copy them during a move, and do not claim the
  reported stranded-Plan failure is fixed here.
- **Existing Session identity stays fixed:** starting in a linked worktree does not authorize re-registering that
  Session under the primary checkout or broadening Workspace access.
- **No new confirmation policy:** the owner approved deliberate same-Project moves. Cross-Project inference,
  confirmation, and transfer remain deferred.
- **Background work keeps its start location:** a move does not retarget, cancel, or restart existing background
  commands/delegates. Their results retain origin information so an old-checkout result is not described as a check of
  the new checkout. Verify no result triggers a second move or an old-root continuation.
- **Missing saved destination:** do not create it or silently execute elsewhere on resume. Keep the Session/history
  available and explain the unavailable location through existing recoverable runtime errors.
- **Reviewable low-risk choices:** the tool name is `session_directory`; relative destinations use current cwd, and
  canonical aliases use the same identity. Instruction inheritance is checkout-root to selected-folder order, with the
  existing per-directory RUNWIELD.md precedence. No new command or location-picker UI is required.
