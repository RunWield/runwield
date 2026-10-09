---
planId: "9f124b4c-f21a-4fe4-815e-15e876ec169c"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/tools/pair-checkpoint.ts"
    - "src/tools/task-completed.ts"
    - "src/shared/session/agent-handler.ts"
    - "src/shared/session/session-runtime.js"
    - "src/shared/session/hosted-session.js"
    - "src/shared/session/session.js"
    - "src/shared/workflow/execution-collaboration.ts"
    - "src/shared/workflow/engineer-runner.ts"
    - "src/agent-definitions/shared-practice/plan-execution.md"
    - "src/acp/"
    - "src/ui/workspace/"
    - "src/ui/tui/runtime-interaction-adapter.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev"
devServerHmr: true
createdAt: "2026-09-20"
origin: "internal"
parentPlan: "conversational-checkpoints-and-acp-interviews"
order: 1
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "d3abcd6bf72f2e12ec04b0d10d3cf9d86d82a583"
archivedAt: "2026-09-28T01:30:51.868Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/conversational-checkpoints-and-acp-interviews/01-conversational-pair-checkpoints.md"
---

# Make Pair Checkpoints a Conversation

## Context

The owner cannot discuss an increment through the current Pair feedback box. Today, `pair_checkpoint` holds the Agent
turn open for Continue, Revise, Autonomous, or Stop. Revise returns one string and work resumes immediately.
`task_completed` repeats this interaction for final approval. ACP disables Pair because it lacks this interaction.

The owner approved ordinary conversation for every checkpoint, including final approval, in TUI, Workspace, and ACP. A
question gets an explanation without implementation. A direction such as “Change it to Y” authorizes revision. “Looks
good, continue” advances work. No exact phrase, button, or feedback box is required.

Owning requirements and proposed changes:

- [Core Pair Execution](../../../prd/runwield-core-prd.md#frontend-engineering-and-pair-execution), **Let the user steer
  visible increments without bypassing validation**: replace blocking forms with conversational checkpoints. Describe
  both existing execution owners, Plan Engineer and Frontend Engineer; keep visual-work ownership unchanged.
- [Core Session continuity](../../../prd/runwield-core-prd.md#session-continuity): a settled checkpoint can continue
  through another screen or a reloaded Session with the same Plan, worktree, and checkpoint context.
- [Workspace Browser Sessions](../../../prd/runwield-workspace-prd.md#browser-sessions), **Preserve conversation,
  drafts, and controls in the browser**: use the normal composer and history for Pair discussion.
- [ACP interactions](../../../prd/runwield-acp-protocol-prd.md#protocol-negotiation-and-interactions): add
  conversational Pair without requiring form elicitation. Native interview forms are unchanged in this child.

Preserve typed workflow authority, work-preserving Stop, autonomous execution, and independent validation. This replaces
the four-button direction in the older draft `docs/plans/fix-workspace-pair-checkpoint-decisions.md`; do not implement
that form redesign as part of this work. No Work Record supersession or unrelated Plan status change is requested.

## Objective

Users can discuss, revise, continue, stop, or switch to autonomous execution through ordinary messages at Pair
checkpoints. A checkpoint ends its managed turn and releases Session control normally; it does not finish the Plan. Only
a recorded final user decision followed by accepted `task_completed` can start initial Pair validation.

## Approach

Keep `pair_checkpoint` as the shared owner of checkpoint reporting and decisions. Extend its interface with report and
resolve actions rather than add a second tool or parse user intent with a phrase list.

```text
Engineer reports an increment through pair_checkpoint
  -> save checkpoint and show its report/evidence
  -> end Agent turn; commit Session and release writer lock
User sends an ordinary message in the same Session
  -> restore execution owner, worktree, tools, and pending checkpoint
  -> question: explain; leave checkpoint pending
  -> direction: model calls pair_checkpoint resolve
       revise / continue / autonomous / stop
  -> authorized work continues, or the turn ends for further discussion
Final checkpoint accepted
  -> task_completed -> existing validation workflow
```

Suggested tool shape: `action: report` with the existing summary/evidence fields and `final`; `action: resolve` with
checkpoint ID, decision, and revision direction when applicable. Preserve old report-shaped calls as reports if needed
for already-loaded prompts. Do not accept old form responses as new user decisions.

The model interprets the user's words. Core validates the active execution attempt, checkpoint identity, and a later
real user turn before accepting a decision. It must not accept a resolution in the report turn, from a generated
continuation prompt, or for a stale checkpoint. Read accepted user-turn evidence from Runtime, not a model-supplied
quotation. Reuse turn/request/transcript IDs; add only the provenance needed to distinguish user input from generated
execution prompts. Questions need no decision call. Remove the exact-phrase resume shortcut as Pair authority.

Persist the execution context needed for continuation and checkpoint state through typed custom entries in the existing
Session JSONL, following `task-completion-session.ts`. Restore before root activation. Reuse existing execution
continuation/attempt identity; do not add a database, lease, or second Plan lifecycle. A resolved/cleared checkpoint
must not reappear from an older handoff. Hidden entries must also supply current checkpoint context to the model after
hydration and compaction.

A report must be visible before the turn stops. Reuse the existing report/event and saved tool-result presentation; do
not depend on the model emitting text after a terminating tool. Show summary, evidence, and next increment once in the
normal timeline, without an answer form. The normal composer accepts discussion and existing image attachments.

For final completion, share this checkpoint owner with `task_completed`. Its first unapproved initial Pair completion
attempt creates a final conversational report and ends the turn without a completion event. Final assent allows a
subsequent typed completion. Revision removes final assent and requires a new final checkpoint. Choosing autonomous
explicitly retains normal typed completion requirements but stops further Pair checkpoints. Validation repairs keep
their existing focused flow; do not introduce a new mandatory Pair gate in every repair round.

Pair capability now means an interactive conversation can continue, not that `pair_checkpoint` forms exist. TUI,
Workspace, and ACP qualify regardless of native form support. Truly noninteractive hosts keep the existing autonomous
startup fallback. A settled conversational checkpoint is not capability loss and must not silently switch style.

A larger feedback form was set aside: it still cannot support a normal multi-turn discussion. This Plan also does not
introduce a general tool-permission sandbox; conversational intent is interpreted by the Agent, while checkpoint and
completion transitions have Runtime guards.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/tools/pair-checkpoint.ts`, `src/tools/task-completed.ts` — one report/resolve contract and final-assent guard.
- `src/shared/session/hosted-session.js`, a typed checkpoint/state helper beside `task-completion-session.ts`,
  `session-runtime.js`, `session.js`, and `agent-handler.ts` — committed continuation state, genuine user-turn evidence,
  owner/tool restoration, and normal turn settlement. Avoid broad changes to unrelated workflow persistence.
- `src/shared/workflow/execution-collaboration.ts`, `engineer-runner.ts`, `execution-segment-handoff.ts`, and
  `validation-helpers.ts` — conversation-based capability, initial/hydrated tool consistency, and correct paused copy.
- `src/agent-definitions/shared-practice/plan-execution.md`, `plan-engineer.md`, `frontend-engineer.md`, and
  `src/shared/workflow/workflow-prompts.ts` — concise discussion, resolution, and final-completion instructions.
- `src/ui/tui/runtime-interaction-adapter.js`, Workspace Session continuation/timeline/composer paths, and ACP event
  mapping — retire Pair form handling; show saved reports and accept ordinary follow-ups. Other forms remain unchanged.
- Tests beside those owners and existing managed-Session fixtures — multi-turn, reload, and real surface boundaries.
- The linked PRDs, `docs/domain-language.md`, `docs/acp-implementation-details.md`, and ADR-006/010/015 — synchronize
  behavior and authority. Update existing ADRs, not competing proposals. Use `docs/design-system.md` and existing
  timeline primitives; no new visual pattern is intended.

## Reuse Opportunities

- `createAgentHandler`, normal `promptUserTurn`, and managed operation settlement — continue the same workflow on a new
  user turn rather than keep a pending form alive.
- `task-completion-session.ts` and `workflow-tool-events.ts` — typed committed records, attempt matching, and accepted
  completion consumption. Plain message text remains non-authoritative.
- `execution-segment-handoff.ts` — existing owner/worktree identity; avoid reconstructing a new execution attempt.
- Current timeline Markdown/report rendering and composer — no separate discussion widget.
- `withRuntimeCommandFixture`, `defineGitFixture`, and managed Plan fixtures — real ownership/storage with only the
  model provider scripted. No new injection seam for RunWield-owned state.

## Implementation Steps

1. `pair_checkpoint` records a report, exposes its evidence in live and saved conversation, and ends the turn without an
   active structured interaction, completion event, or lifecycle change. The same report path serves final Pair
   completion. Same-batch later calls cannot resolve or complete the newly reported checkpoint.
2. Typed resolution accepts decisions only for the current checkpoint/attempt from a later accepted user turn. Questions
   leave it pending. Revision and Continue permit the intended increment; Stop preserves work and allows later natural
   resume; Autonomous records the user's style change. Stale calls and missing decisions do not imply approval.
3. Checkpoint and execution continuation data survive managed dehydrate/hydrate, reload, and compaction. Shared root
   activation supplies the correct execution Agent, cwd, `pair_checkpoint`, and handler on every follow-up, not only in
   `engineer-runner`. Cleared state and consumed handoffs cannot resurrect an old checkpoint or worktree.
4. Initial Pair `task_completed` is rejected or converted to a final report until final assent is recorded. A question
   does not authorize validation. Revision invalidates assent. Accepted completion still goes through the existing typed
   completion owner once; Plan review, code review, and validation evidence requirements remain unchanged.
5. Conversation-capable TUI, Workspace, and ACP execute canonical Pair recommendations without a Pair form. Normal reply
   controls are available after each report. Other structured interactions and noninteractive startup behavior retain
   their existing contracts. Discussion is not described as a failed or abandoned execution.
6. Shared Agent guidance distinguishes explanation from requested implementation, records natural-language directions
   through the resolution action, and presents a fresh checkpoint after revision. No hard-coded user phrase is required.
7. Core, Workspace, and ACP capability requirements and scenarios match the delivered journey. The glossary defines Pair
   Execution as conversational checkpoints and distinguishes these committed checkpoints from process-local Pending
   Structured Interactions. ADR-006 retains typed authority; ADR-010 describes conversational host support; ADR-015
   explains committed continuation with ordinary operation settlement. Preserve unrelated dirty document edits.

## Approval Confirmation

No Work Record supersession is proposed. The owner approved the conversational flow, final checkpoint, and ACP support
in this planning Session. The proposed report/resolve interface is the implementation of that decision, not a new user
command syntax.

## Verification Plan

Run focused tests through the safe runner, then CI:

```sh
deno run -A scripts/run-tests.js src/tools/__tests__/pair-checkpoint.test.js src/tools/__tests__/task-completed.test.js src/shared/workflow/pair-execution.test.js src/shared/workflow/agent-runners.integration.test.ts src/shared/session/agent-handler.test.ts src/acp/server.test.js src/ui/workspace/session-continuation.integration.test.ts src/ui/workspace/workspace-session-ux.test.tsx
deno task seams:check
deno task ci
```

Add new persistence tests to that focused run as needed. Never use direct `deno test`.

- **Decisive integration:** in a real managed Session and Git worktree, report an actual increment, await settlement,
  then submit an explanatory question, revision direction, and Continue on separate turns. Assert stable Session, owner
  and cwd, unchanged files during explanation, changed files for the requested revision, and a new checkpoint. Inspect
  provider requests to prove restored checkpoint context and current discussion instructions reach the model. The
  question turn must not publish completion or launch validation. A pass-through tool or form-only rename fails.
- **Authority:** attempt report, resolve, and completion in one assistant tool batch; attempt a generated continuation,
  wrong checkpoint, wrong attempt, and an already-consumed decision. None supplies user assent or starts validation.
- **Final checkpoint:** first completion reports and settles; a question leaves it pending; revision clears assent;
  later final assent plus `task_completed` invokes the existing completion path once. Verify the actual accepted-event
  journal and downstream validation boundary, not only returned text.
- **Persistence:** unload the runtime after report, create a new runtime, load the same bundle, then discuss/resolve.
  Verify no old interaction Promise or in-memory workflow is required. Repeat after compaction and after a resolved
  checkpoint. Confirm another surface can acquire the Session between turns.
- **Surface tests:** ACP with empty capabilities emits a readable checkpoint and `end_turn`, then accepts discussion and
  continuation without `elicitation/create` or a question URL. Workspace uses its normal composer; no pending Pair form
  remains. TUI settles to normal input. Exercise both execution owners.
- **Preserve:** autonomous execution, noninteractive fallback, Stop without abandonment, same-turn exclusion, browser
  evidence requirements, native interview forms, and ordinary Plan/code review. Old tests requiring Pair form choices,
  ACP Pair rejection, exact resume phrases, and same-turn form continuation must be replaced, not retained as policy.
- **Manual:** run `deno task workspace:dev`, inspect the `/dev` catalog, then use a real registered test Project and
  Pair Plan in headed Workspace. At desktop and phone width, discuss an increment, attach an image, request a revision,
  and give final assent. Verify normal composer focus, readable evidence, saved history after refresh, no feedback box,
  and no console/network failures. Repeat the text journey in TUI and through an unmodified OpenAB ACP host; record the
  host version/commit. Use a real model for the question-versus-direction behavior; scripted tests alone cannot prove
  natural-language judgment. Do not claim a live check passed if the external host or credentials were absent.
- **Semantic Review:** inspect all initial and restored root activation paths, final completion, and persistence order.
  Confirm no form capability fallback silently turns a conversation autonomous. Confirm docs distinguish completed
  behavior from untested external-host claims and retain Core's publication/abandonment completion rule.

## Edge Cases & Considerations

- Stop pauses work; it does not abandon the Plan. Canceling an active model turn does not record checkpoint assent.
- The model can ask about genuinely unclear intent. Do not add a parser that repeatedly asks users to reformat replies.
- Keep the checkpoint context through ordinary reload; do not promise restoration of a half-executed tool or uncertain
  external side effect after a crash. Existing Core recovery applies.
- Native external execution backends need the same report termination, tool availability, and final guards through their
  existing tool bridge. Do not claim a Pi-only test proves every backend, or add a new sandbox in this change.
- Passive metrics may record checkpoint counts and decisions, not user feedback, screenshots, or conversation content.
- Older form-fix Plans are not implementation guidance for this approved replacement. Leave unrelated Plans untouched.
