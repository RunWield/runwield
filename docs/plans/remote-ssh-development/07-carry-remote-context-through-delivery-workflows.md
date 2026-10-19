---
planId: "fca9ebb0-e78c-4f04-ba12-2cbd7ded93b8"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/session/session.js"
    - "src/shared/session/runtime/managed-operations.ts"
    - "src/shared/session/runtime/turns.ts"
    - "src/shared/session/runtime/workflows.ts"
    - "src/shared/session/runtime/remote-persistence.ts"
    - "src/shared/session/segment-rollover.ts"
    - "src/shared/session/file-session-store.ts"
    - "src/shared/session/background-tasks.ts"
    - "src/shared/remote/session-protocol.ts"
    - "src/shared/remote/session-save-bridge.ts"
    - "src/shared/remote/laptop-session-control.ts"
    - "src/shared/remote/session-control-client.ts"
    - "src/tools/plan-written.ts"
    - "src/shared/workflow/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T02:05:51.352Z"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 7
dependencies:
    - "04-run-and-resume-remote-sessions-with-local-history"
    - "05-keep-memory-and-integrations-on-their-owning-machine"
    - "06-forward-personal-mcp-tools-from-the-laptop"
userVerifiedAt: null
targetBranch: "epic/remote-ssh-development"
status: "in_progress"
---

# Carry Remote Context Through Delivery Workflows

## Context

A remote conversation alone is not enough. A user must be able to take a change on a remote-only project through
planning, Plan review, isolated execution, validation, AI review, repair, and publication, with the same rules as a local
Session. Child04 admitted only the root conversation and deliberately left the rest blocked.

### What already works

The remote Core process runs on the server, so project work already lands in the right place:

- Worktrees resolve under the remote account's `~/.wld/worktrees/` (`worktree.js` `resolveWorktreeParent`).
- The worktree registry, Plan locks, transition journals, delivery evidence, and the Work Record index use the remote
  project's internal runtime layout (`project-runtime-layout.ts`).
- Plans and Work Records are read from the remote project cwd.
- Epic continuation already creates its new root Session through `remotePersistence.create`
  (`runtime/lifecycle.ts`).

### What blocks delivery workflows today

| Blocked work                                                                                                                   | Cause                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delegated agents (read and write, foreground and background), semantic reviewers, Manual QA, Recorder, Slicer, semantic repair | The `buildAgentSession` guard in `session.js` refuses every Session that is not the bridged root manager or has a `subAgentDefinition`. These agents use `SessionManager.inMemory` and need no laptop storage.           |
| `plan_written`, `artifact_written`, validation artifacts                                                                       | The remote capability in `managed-operations.ts` throws from `registerArtifact`.                                                                                                                                         |
| Plan Association, Plan review, semantic-repair Plan Association                                                                | The remote capability has no `stagePlanAssociation`, `recordLastPlanReview`, or `getCurrentSegmentKind`.                                                                                                                 |
| Reopen Plan review, Plan Session lookup, tutorial context                                                                      | The remote runtime has no Session store, so `getLastPlanReview` and `listSessionPlanAssociations` return empty or degraded results.                                                                                      |
| Execution and semantic-repair handoff                                                                                          | `rollManagedSessionSegment` (`runtime/turns.ts`) needs a Session store. `RemoteSessionOwner.rollover` exists on the laptop (`file-session-store.ts`) but only tests call it, and the protocol has no rollover operation. |

`RemoteSessionOwner.rollover` also has three gaps for remote projects:

- **Successor path.** It would create the successor under `sessionDirForRoot(remoteCwd)`. Remote projects store
  transcripts under `sessionDirForProject` (`laptop-session-control.ts`).
- **Identity.** `RemoteSessionPersistence.metadata` reads the first `runwield.remote_identity` entry of the current
  transcript (`runtime/remote-persistence.ts`). A successor segment has none.
- **History.** `savedSession` in `laptop-session-control.ts` reads only the current-generation segment.

### Smaller gaps

- **Swallowed save errors.** Workflow code catches some Session-save errors and continues (`workflow-context-session.js`,
  `hosted-session.js`, `plan-written.ts`, `runtime/workflows.ts`). In remote mode, a save fault is sticky and stops the
  Agent. Git, worktree, CI, and Plan-file work can still start until something touches the manager again.
- **Background task logs.** `background-tasks.ts` writes logs to `~/.wld/sessions/<projectId>/<sessionId>/` on the
  remote host. This breaks the "no remote Session storage" invariant that `assertRemoteStorageAbsent` checks.

### Product ownership

This child delivers the non-browser part of the Remote SSH PRD:

- [Remote workflows and local review](../../prd/remote-ssh-prd.md#remote-workflows-and-local-review): **Complete normal
  Core work remotely**, and the scenario "planning, review, execution, validation, and publication occur remotely and the
  local Session records the results". The local browser is child09.
- [Disconnect and recovery](../../prd/remote-ssh-prd.md#disconnect-and-recovery): **Preserve work and report
  uncertainty**, and the scenario "a remote edit or publication attempt whose result was not saved locally is checked
  on reconnect, not repeated".
- [Local memories and saved Sessions](../../prd/remote-ssh-prd.md#local-memories-and-saved-sessions): workflow context
  and rollover on resume.

It extends the Core [Laptop-owned remote Session saves](../../prd/runwield-core-prd.md#laptop-owned-remote-session-saves)
contract to Session records and rollover. It must preserve, unchanged, the meanings in
[Plan review](../../prd/runwield-core-prd.md#plan-review),
[Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery),
[Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair), and
[Work protection](../../prd/runwield-core-prd.md#work-protection).

### Epic Scope Changes

- New `08-stop-owned-remote-work-on-connection-loss` — receives the owned-process termination work: stopping every
  RunWield-owned subprocess on loss, including orphans after a forced TUI kill.
- `08-open-remote-reviews-in-the-local-browser` is renamed `09-…`; `09-package-and-qualify-remote-ssh-support` is renamed
  `10-…`. Their `order` and `dependencies` follow.

## Objective

In a connected remote Session, every Core delivery workflow runs with the existing workflow code:

- Project effects happen on the remote project.
- Session records (transcript entries, artifacts, Plan Associations, Plan review references, segment rollover) are saved
  only by the laptop owner.
- Model requests use the laptop model bridge.

A save fault blocks every later workflow effect. Reconnect continues from saved evidence without automatic replay.

## Approach

Keep one rule: **remote Core never owns Session storage, and in-memory work needs none.** Add the missing Session
record operations to the existing laptop save bridge, and relax the agent guard to that rule. No workflow code learns
about remote mode.

### Non-root agents

Change the `buildAgentSession` guard from "only the bridged root" to "no file-backed manager":

```diff
 if remote
-  refuse unless (hostedSession and no subAgentDefinition and manager is bridged root)
+  refuse if manager.isPersisted()
+  refuse if manager is the hosted root manager without a save bridge
```

In-memory agents return results to the parent through existing workflow-tool events. Those events reach the root
transcript through the save bridge, so their results are saved on the laptop.

### Session records through the save bridge

The capability methods are synchronous. The save bridge already makes synchronous, ordered, operation-scoped calls to
the laptop through its Worker. Add record kinds to the same channel, not to the asynchronous control channel:

```text
remote capability                        laptop RemoteSessionOwner (holds the native lock)
  registerArtifact(options)       ──►  "artifact"          → store.registerSessionArtifact(proof, …)
  stagePlanAssociation(entry)     ──►  "plan-association"  → store.stagePlanAssociation(proof, …)
  recordLastPlanReview(review)    ──►  "plan-review"       → store.recordLastPlanReview(proof, …)
  getCurrentSegmentKind()         ──►  "segment"           → store.getCurrentSessionSegment(…)
  read: last review, associations ──►  "records"           → read-only manifest projection
```

Each request has the operation and sequence identity that entries already have. An identical retry returns the saved
receipt. A conflicting or stale request is refused. A failure is the same sticky bridge fault that a failed append
causes.

### Rollover on the laptop

```text
execution / repair handoff (runtime/workflows.ts)
  prepareSegmentHandoff                  existing: worktree, Plan events
  rollManagedSessionSegment (turns.ts)
-   requires local sessionStore
+   remote: bridge "rollover" → RemoteSessionOwner.rollover on the laptop
+     successor in sessionDirForProject, remote identity resolvable, lock held throughout
+   remote manager hydrates the successor under a fresh operation
  continue in successor segment
```

> [!WARNING]
> **The lock must not be released between segments**
>
> The laptop keeps its native Session Writer Lock from the predecessor commit to the successor operation. Old-operation
> requests are refused after rollover. A timeout never grants takeover.

### Save faults stop workflow effects

`capability.assertLive()` already checks bridge health in remote mode and only `settled` in local mode. Call it at the
workflow boundaries where an external effect begins. A fault that an intermediate caller swallowed then still blocks the
next effect. Local behavior does not change.

Set aside: a separate SSH-shell workflow implementation. It would bypass lifecycle, work protection, and recovery rules.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/session.js` — the `buildAgentSession` remote guard follows the "no file-backed manager" rule.
- `src/shared/remote/session-protocol.ts`, `session-save-bridge.ts`, `session-save-worker.ts` — new record and rollover
  request kinds, with the same validation, identity, and sticky-fault rules as entries.
- `src/shared/session/file-session-store.ts` (`RemoteSessionOwner`) and `src/shared/remote/laptop-session-control.ts` —
  laptop handling of record kinds and rollover. Successor in the remote project's Session directory. Saved history
  reads the committed current segment.
- `src/shared/session/runtime/managed-operations.ts` — the remote capability implements `registerArtifact`,
  `stagePlanAssociation`, `recordLastPlanReview`, and `getCurrentSegmentKind` through the bridge.
- `src/shared/session/runtime/turns.ts`, `runtime/remote-persistence.ts`, `segment-rollover.ts` — the remote rollover
  path, successor hydration, and identity metadata for successor segments.
- `src/shared/session/runtime/workflows.ts`, `runtime/reads.ts`, `runtime/agent-settings.ts` — remote reads of last Plan
  review and Plan Associations instead of empty results.
- `src/shared/workflow/` (handoff preparation, validation start, repair start, publication start) — `assertLive()` at
  each effect boundary.
- `src/shared/session/background-tasks.ts` — log location in remote mode.
- `src/shared/remote/remote-runtime-test-fixture.ts` and new `src/shared/remote/remote-runtime-workflows*.test.ts` —
  cross-machine workflow tests.
- `docs/prd/remote-ssh-prd.md`, `docs/prd/runwield-core-prd.md`, `docs/domain-language.md` — delivered scope and links.

Not touched: process termination on loss (child08), browser forwarding and Guided Review (child09), Claude CLI and
Antigravity CLI backends (stay refused by `model-execution.ts`), remote `/sleep` (deferred by the Epic).

## Reuse Opportunities

- `RemoteSessionOwner.handle` receipts, sequence checks, and sticky failure — the model for record and rollover kinds.
- `RemoteSessionOwner.rollover` and `rollSessionTranscriptSegment` — the laptop rollover transaction; fix its remote
  inputs rather than write a second one.
- `ManagedOperationCapability` (`managed-operation.ts`) — the existing interface; the remote capability implements the
  same optional methods as the local one.
- `withRemoteRuntimeFixture`, `assertRemoteStorageAbsent`, and `assertSmallControlBodies`
  (`remote-runtime-test-fixture.ts`) — real remote runtime against a real laptop owner.
- Existing workflow recovery (`transition-recovery.ts`, `publication-attempt.ts`, `plan-review-recovery.js`,
  `validation-recovery.ts`) — reconnect uses it unchanged against remote evidence.

## Implementation Steps

- In remote mode, `buildAgentSession` refuses any Pi Session manager for which `isPersisted()` is true, and refuses the
  hosted root manager when it has no save bridge. In-memory managers for delegated agents (read and write, foreground
  and background), semantic reviewers, Manual QA, Recorder, Slicer, and semantic repair are admitted. Their model
  requests go through the laptop model bridge.
- The save protocol accepts record kinds for artifact registration, Plan Association staging, last Plan review
  recording, current segment kind, and a read-only records projection (last Plan review and Plan Associations). Each
  carries operation and sequence identity. The laptop `RemoteSessionOwner` applies them with its held activation proof.
  Identical retries return the saved receipt, conflicting or stale requests are refused, and a failure is a sticky
  bridge fault.
- The remote managed-operation capability implements `registerArtifact`, `stagePlanAssociation`,
  `recordLastPlanReview`, and `getCurrentSegmentKind` through the bridge. It no longer calls `requireLocalSessionWriter`.
  `plan_written` registers its Plan artifact and Plan Association and opens Plan review in a remote Session.
- In a remote Session, `getLastPlanReview`, Plan-associated Session lookup, and tutorial context return the laptop's
  saved records, not empty or `session_store_unavailable` results.
- The save protocol has a rollover kind. `rollManagedSessionSegment` in remote mode sends it, and the laptop runs
  `RemoteSessionOwner.rollover`. The successor is created in the remote project's laptop Session directory
  (`sessionDirForProject`). The native lock is held from the predecessor commit to the successor operation. Requests
  from the old operation are refused afterwards.
- After rollover, the remote runtime hydrates the successor segment from laptop evidence and continues the workflow in
  it. `RemoteSessionPersistence.metadata` resolves the Session's remote identity for any segment. Laptop `savedSession`,
  `wld remote sessions`, and remote `/resume` read the committed current segment and its lineage.
- Execution handoff, semantic-repair handoff, and mechanical repair turns in a remote Session produce the same segment
  kinds, lineage, continuation, and workflow entries as a local Session in the same state.
- Before each workflow effect boundary begins (handoff preparation and worktree creation, validation start, repair
  start, publication start), the workflow calls `assertLive()` on the active managed-operation capability. In remote
  mode, a save fault, including one an intermediate caller caught, stops the workflow before that effect. Local
  behavior is unchanged.
- In remote mode, background task logs are written to a private (0700) directory owned by the connection's remote
  runtime, outside the remote `~/.wld`. `background_task` status still reads their output. The directory is removed
  when the runtime exits. `assertRemoteStorageAbsent` holds after a background task runs.
- On reconnect, remote `/resume` of a Session that was interrupted during execution, validation, repair, or publication
  applies the saved workflow context and pending segment continuation, and runs the existing recovery against remote
  Plan, worktree, transition, and publication evidence. It reports proven and uncertain outcomes. It does not repeat a
  tool call, validation run, review decision, or publication step before the user chooses.
- A failed attempt, transport loss, retry limit, or internal inconsistency leaves the Plan in a recoverable state.
  Delivery concludes only after confirmed publication or deliberate user abandonment, as in local mode.
- The Remote SSH PRD marks **Complete normal Core work remotely**, its planning-to-publication scenario, workflow context
  and rollover on resume, and the reconnect-without-replay scenario for workflows as delivered. Local browser review
  stays target scope in child09, and owned-process termination stays target scope in child08. The links to the renamed
  `09-open-remote-reviews-in-the-local-browser` resolve.
- The Core PRD **Laptop-owned remote Session saves** section states that artifacts, Plan Associations, Plan review
  references, and segment rollover use the laptop save bridge. Its "workflow authorization and rollover remain target"
  note is removed.
- The **Remote SSH connection** entry in `docs/domain-language.md` says that delivery workflows run remotely with
  laptop-owned Session records, replacing "delivery workflows remain target scope".

## Verification Plan

All automated tests run a real remote runtime against a real laptop `RemoteSessionOwner` through
`withRemoteRuntimeFixture`, with a synthetic laptop model provider. Each test also runs `assertRemoteStorageAbsent`.

- Automated, agents: in a remote Session, a read delegate, a write delegate, a background delegate, a semantic reviewer,
  and the Recorder each complete. Assert that their model requests reached the laptop model bridge and that no
  persisted Pi manager was created. A test that builds a persisted manager in remote mode still fails with the guard
  error, and a separate named case asserts that the hosted root manager without a save bridge is refused. This fails if
  the guard is removed instead of changed.
- Automated, records: `plan_written` in a remote Session registers the Plan artifact, stages its Plan Association, and
  records the last Plan review. Assert those exact records in the laptop manifest. Then stop the remote runtime, start a
  fresh one, and `/resume`: `getLastPlanReview`, Plan-associated Session lookup, `getCurrentSegmentKind`, and tutorial
  context return the laptop records. A second case seeds a Plan review on the laptop that the remote runtime never
  wrote and asserts the remote runtime returns it. A capability that caches what it sent fails both cases.
- Automated, record faults: an identical retry of a record request does not change the manifest. A conflicting payload
  and an old-operation request are refused. A failed record request makes `assertLive()` throw for the rest of the
  operation.
- Automated, rollover: an execution handoff in a remote Session commits the predecessor and successor on the laptop, in
  `sessionDirForProject`, with lineage. A fixture barrier pauses the laptop owner after the predecessor commit and
  before the successor operation starts. At that point a competing laptop process fails to acquire the lock, and the
  lock holder's identity is the same before and after rollover. An old-operation append after rollover is refused.
- Automated, successor content: after the handoff, later execution entries and the workflow continuation are in the
  successor transcript on the laptop, not in the predecessor. A fresh `begin` and remote `/resume` hydrate the
  successor and show predecessor history through lineage. `wld remote sessions` shows the same history.
- Automated, effect gate: three separate cases, each with a save fault that a workflow caller catches. (1) Fault after
  worktree creation, before validation start: validation does not start. (2) Fault after validation passes, before
  publication start: no publication git command runs, proven by the fixture's command log and the remote repository
  refs. (3) Fault before repair start: the repair turn does not start. Each case asserts that the stop comes from its
  own boundary, so it fails if that boundary's `assertLive()` call is removed. The same cases in a local Session show
  unchanged local behavior.
- Automated, end to end: a remote-only Plan goes through planning, `plan_written`, an approval sent to the review
  server's API, execution in an isolated remote worktree, validation, semantic review, a repair, Work Record generation,
  and local publication into the fixture's remote repository. Assert that every project path is remote, the laptop
  sentinel tree is unchanged, and the laptop Session holds the workflow records and segments.
- Automated, reconnect: stop the fixture transport (a) during validation and (b) after a publication attempt is recorded
  but before its result entry is saved. Reconnect and `/resume`. Assert that the Plan is in a recoverable state, that
  the recovery outcome matches local recovery for the same evidence, and that no git command, validation run, or
  publication step ran before the user chose. Then send the user's choice (retry validation; confirm or finish
  publication) and assert that the workflow reaches confirmed publication with each side effect happening exactly
  once.
- Automated, background logs: in a remote Session, a background task's output is readable through `background_task`
  status. Its log directory has mode 0700, is outside the remote `~/.wld`, and is gone after the runtime exits.
- Automated: `bun scripts/run-tests.js` with the new `src/shared/remote/remote-runtime-workflows*.test.ts` files and
  the protected suites below, then `bun run seams:check` and `bun run doc-links:check`.
- Protect, unchanged: `session-save-bridge.test.ts`, `remote-session-owner.test.ts`,
  `remote-session-lifecycle.test.ts`, `session-worker-death.test.ts`, `remote-runtime-*.test.ts`,
  `segment-rollover.test.js`, `file-session-plan-review-rollover.test.ts`, and the local workflow, publication, and
  validation recovery suites.
- Behavior expected to stop existing: `remote-runtime-guards.test.ts` assertions that non-root and sub-agent Sessions are
  refused in remote mode. Rewrite them to assert the new rule: in-memory agents are admitted, persisted managers and an
  unbridged root are refused. Do not delete them without that replacement.
- Live on `sct` (Plan review uses a manual `ssh -L` forward of the printed review URL until child09): take a remote-only
  Plan through planning, Plan review approval, isolated execution, validation, AI review, repair where triggered, Work
  Record generation, merge, and confirmed publication. Confirm the laptop sentinel tree is unchanged.
- Live on `sct` (moved from child04): after an execution handoff creates a successor segment, disconnect, reconnect, and
  confirm `/resume` continues from the successor with laptop lineage intact.
- Live failure on `sct`: cut transport during validation and during publication. Reconnect and confirm that proven
  outcomes are retained, uncertain outcomes are reported, and no external effect is repeated automatically.
- Documents: the Remote SSH PRD, Core PRD, and glossary describe the delivered workflow behavior. Browser review and
  owned-process termination stay labeled target.

## Edge Cases & Considerations

- **External action accepted before loss.** It can finish after RunWield stops. Report evidence and uncertainty; closing
  SSH cannot roll it back.
- **Artifact paths are remote.** Artifact references saved on the laptop name remote project paths. The laptop does not
  open them. Laptop-side helpers that act on an artifact path, such as `requestWorkspaceSearchRefresh`, must not run
  against a remote path.
- **Worktree cwd changes.** Execution moves the cwd into an isolated remote worktree. Project identity, Memory
  collection, and the remote project locator stay those of the parent project.
- **No remote-mode branches in tools.** The guard, the capability, and the rollover path are construction-time
  boundaries. Workflow and tool code calls the same interfaces in local and remote mode.
- **Plan review before child09.** The review server runs on remote loopback. `BrowserPort.open` returns `opened: false`
  and the URL is shown. A user can reach it with a manual SSH forward until child09 automates it.
- **Assumption: background log location.** Remote background task logs are transient and do not survive the runtime.
  A connection-owned private directory matches that lifetime. They are not part of laptop Session history.
- **CLI backends.** Claude CLI and Antigravity CLI stay refused in remote mode, including for delegated and repair
  agents. Refusal happens before a provider request.
