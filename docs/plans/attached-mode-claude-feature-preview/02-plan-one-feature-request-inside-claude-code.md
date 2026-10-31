---
planId: "5c2b4b19-93fa-4522-9ad2-caf82cbc131f"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/attached/claude/"
    - "src/shared/attached/"
    - "src/cmd/attached/"
    - "src/shared/session/agents.js"
    - "src/shared/session/bridged-tools/prompt.ts"
    - "src/plan-store.js"
    - "src/shared/project-runtime-layout.ts"
    - "docs/domain-language.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/adr/014-attached-workflow-coordination-boundary.md"
planDeviations:
    - id: "call_aee379039e024a8b9b474a5e843b9171|fc_0904a8e92a9e24e0016ac65c2415348194bc8c77dfb1ca0f46"
      supersededRequirement: "Manual pair check with Claude Code 2.1.292 and `claude --plugin-dir src/attached/claude/plugin`, in a new Git repository with no `.wld/`:\n1. Send an ordinary prompt. No RunWield text appears and no record is created under `~/.wld/attached/`.\n2. Run `/runwield add a dark-mode toggle`. Claude triages, shows the setup preview, writes the Plan, and calls `plan_written`.\n3. Run `wld` in the repository. The Plan is listed in `draft` with its Plan ID.\n4. Ask Claude something unrelated in the same conversation after submission. It answers normally."
      replacementRequirement: "Do not require the live Claude Code manual acceptance journey in this execution. The user will test that journey later. Complete automated and local non-model checks, and report the live Claude journey as not run because Claude quota was unavailable."
      reason: "The user explicitly asked not to wait for the quota reset and will perform the manual test later."
      approvedAt: "2026-10-07T15:00:58.079Z"
    - id: "call_5sZwTIUqnVS13uLICe8ynv26|fc_0904a8e92a9e24e0016ac65fe236b88194be529092e1cba505"
      supersededRequirement: "The plugin provides `/runwield <request>` through `src/attached/claude/plugin/commands/runwield.md`, loaded with `claude --plugin-dir src/attached/claude/plugin`."
      replacementRequirement: "The plugin provides `/runwield:request <request>` through `src/attached/claude/plugin/commands/request.md`, loaded with `claude --plugin-dir src/attached/claude/plugin`. Use this command name in the child’s user-facing documentation and acceptance checks. No standalone alias is installed."
      reason: "Claude namespaces plugin commands. The user selected request as the public command name."
      approvedAt: "2026-10-07T15:26:06.956Z"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-07T03:22:46.056Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 2
dependencies:
    - "01-activate-and-resume-an-attached-workflow"
userVerifiedAt: null
targetBranch: "epic/attached-mode-claude-feature-preview"
status: "validated"
validatedCommit: "d107e5f81c0ebafaa2898512870e25dd1431f35d"
---

# Plan one FEATURE request inside Claude Code

## Context

Child 01 delivered the Attached Workflow Coordinator, the Attached Workflow Record, and the `activate`, `submit`, and
`status` operations through `wld attached` and `wld attached mcp`. A PLANNED_CHANGE Triage outcome leaves the workflow
in `awaiting_planning` with `nextAction: { kind: "plan" }`. Nothing gives Claude the Router or Planner instructions yet,
and nothing accepts a Plan. Child 01 also named the Triage operation `submit`, while Core's Router tool is
`triage_report`.

This child adds the Claude Code plugin, run-time role instructions, and Plan submission. After it, a user runs
`/runwield <request>` in Claude Code, Claude triages and plans under the RunWield Router and Planner instructions, and
the Plan lands in `docs/plans/` with a Plan ID. Browser review is child 03.

Owning capabilities:

- [Explicit per-request activation](../../prd/runwield-connect-prd.md#explicit-per-request-activation) — the plugin
  delivers activation steps 1, 3, and 4 inside Claude Code. Host preflight (step 2) is limited to the contract-version
  check below.
- [Host-owned reasoning](../../prd/runwield-connect-prd.md#host-owned-reasoning) — Claude makes every model call.
- [Compatibility and honest availability](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability) —
  role boundaries are instructions, not enforcement.
- [Lazy project setup and recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery) — the first
  repository write is Plan submission, and the user sees the setup changes first.

Core keeps [Plan lifecycle](../../prd/runwield-core-prd.md#plan-lifecycle) authority.

### Decisions from planning

- **Role instructions are sent at run time.** Each response that hands Claude a role carries that role's current
  instructions, resolved from project, home, and bundled agent definitions, plus a RunWield-to-Claude tool-name map. The
  plugin ships no generated Skills and no copied prompts. A tool result instead of a system prompt is an accepted
  compromise of Attached Mode.
- **No tool restrictions.** RunWield follows the Pi approach: the Planner in Core has edit, write, and unrestricted
  bash, and is told to write only Plan files. Attached Mode does the same. The plugin has no hooks. Other MCP servers
  and shell commands stay available.
- **Lifecycle tools keep their Core names.** The Router calls `triage_report` and the Planner calls `plan_written`, as
  in `wld`. Child 01's `submit` operation is renamed to `triage_report`. The tool-name map covers only Core tools that
  Claude has under its own names (`read`, `write`, `edit`, `bash`, and similar). `activate` and `status` have no Core
  equivalent and keep their names.
- **No Plan ownership.** The Attached Workflow Record stores a Plan reference only. A Plan written in Claude is an
  ordinary Plan; running it later with `wld` is a welcome conversion path.
- **The Attached code may import Pi-loading shared code.** The only rule is that it never starts a model turn. Child
  01's import-graph test (`src/shared/attached/isolation.test.ts`) is removed.
- **No change check at submission.** `wld` does not run one, so Connect does not either.
- **Install flow belongs to child 07.** This child installs the plugin only for local development with
  `claude --plugin-dir`.

### Epic Scope Changes

The decisions above changed the parent Epic, its decision record, and the owning PRD. These edits are part of this
review:

- `docs/plans/attached-mode-claude-feature-preview.md` — removed the Planning Gate, hooks, generated Skills and their
  stale-copy check, Plan ownership through the controller registry, and the import-graph architecture test. Added
  run-time role instructions and the "never starts a model turn" rule.
- `docs/adr/014-attached-workflow-coordination-boundary.md` — replaced hook-based mutation gating and Skill
  materialization with run-time role instructions and the Pi trust model. Plan submission records a Plan reference, not
  ownership.
- `docs/prd/runwield-connect-prd.md` — removed "prevent implementation changes until planning and approval permit them"
  from the disclosure list. Rewrote the planning-restriction scenario, journey step 4, and the False Enforcement Claims
  risk: role boundaries are instructions in Connect as in Core.
- `07-prove-and-document-the-supported-claude-preview.md` — replaced "role materializer" and "regenerate stale layered
  assets" with the run-time resolver and the contract-version check. Child 07 already owns the install flow.

## Objective

In a trusted Git repository with no `.wld/` directory, a user with the plugin loaded through `--plugin-dir` runs
`/runwield add a dark-mode toggle`. Claude triages under the Router instructions, plans under the Planner instructions,
writes `docs/plans/<name>.md`, and submits it. Core gives the Plan an ID, writes the Triage front matter, sets up the
project runtime, and records the Plan reference. The user can then open the Plan with `wld`.

## Approach

The flow reuses child 01's operations, renames one, and adds one operation and one response field:

```text
/runwield <request>                       (plugin command)
  activate          -> pending router action + Router instructions
  triage_report     -> pending planner action + Planner instructions + setup preview
  Claude writes docs/plans/<name>.md
  plan_written      -> Plan ID, front matter, project runtime, Plan reference
```

**Role instructions** are attached to the response, never saved. Child 01 saves each accepted result in
`acceptedOperations` so a retry returns it unchanged. If instructions were inside that saved result, a retry would
return old instructions. So `runAttachedOperation` adds them after the decision:

```text
runAttachedOperation(name, root, input)
  result = decide and commit (unchanged)
  if result.workflow has a pending router or planner action
    result.instructions = resolveAttachedRoleInstructions(root, role)
  return result
```

`resolveAttachedRoleInstructions` calls `loadAgentDef` (project, then home, then bundled) and appends a tool-name map
built with `buildBridgedToolPromptAppendix`, plus a short Attached addendum. Both lifecycle tools keep their Core names
(`triage_report`, `plan_written`), so the map only covers tools Claude has under its own names. The addendum explains
the Attached envelope fields (`operationId`, `workflowId`, `expectedRevision`, `actionId`) that wrap the Core arguments.

The `triage_report` rename is a straight rename of child 01's `submit`. Its `outcome` fields already match the Core
tool's arguments (`routingIntent`, `summary`, `workKind`, `sessionName`, and so on):

```diff
-AttachedOperationName = "activate" | "submit" | "status"
+AttachedOperationName = "activate" | "triage_report" | "status" | "plan_written"
-parseSubmitInput / SubmitEnvelope / SubmitPayload / submitOutcome
+parseTriageReportInput / TriageReportEnvelope / TriageReportPayload / triageReport
-wld attached activate|submit|status|mcp
+wld attached activate|triage_report|status|plan_written|mcp
```

**Plan submission** reuses the steps of Core's `plan_written` that do not need a Hosted Session or review:

```text
plan_written(actionId, planName, executionAgent?, collaborationRecommendation?)
  check revision and pending planner action
  resolveWorkflowPlanLocation(root, planName); the file must exist
  enterProjectRuntime(root)          # .wld/internal/, managed .gitignore block
  updatePlanFrontMatter(Triage fields + execution policy)
  resolvePlanExecutionPolicy         # invalid -> invalid_outcome with a repair message
  ensurePlanIdentity                 # planId
  record: plan = { planId, planName }, state "plan_submitted"
```

No Plan Event is recorded. That matches Core's `plan_written` today: the Plan stays `draft` until review, which is
child 03.

> [!NOTE]
> **The setup preview is shown, not confirmed**
>
> The planner action carries `projectSetup`: the paths `plan_written` will create (`.wld/internal/`, the managed
> `.gitignore` block). The Planner addendum tells Claude to show these to the user before writing the Plan. There is no
> confirm round trip; the user can stop at that point like any other Claude turn.

**The plugin** is three static files: a manifest, a `/runwield` command, and `.mcp.json` that starts `wld attached mcp`.
The MCP carrier fills `evidence` from the MCP `initialize` client info and the plugin version, so the model never types
version strings.

Set aside: generating Claude Skills from agent definitions. It needs regeneration and a stale-copy check, and project
overrides would not apply until the next install.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

```diff
 src/attached/claude/
+├── plugin/.claude-plugin/plugin.json  # manifest: name, version, description
+├── plugin/commands/runwield.md        # /runwield: call activate, follow returned instructions
+├── plugin/.mcp.json                   # starts `wld attached mcp`
 └── mcp.ts                             # fills evidence from client info; serves triage_report, plan_written
 src/shared/attached/
+├── role-instructions.ts               # resolves Router/Planner instructions at run time
 ├── operations.ts                      # submit -> triage_report; plan_written envelope, parser, schema
 ├── coordinator.ts                     # triageReport, planner action, planWritten, instructions on responses
 ├── record-store.ts                    # plan reference, plan_submitted state
 ├── attached-test-fixture.ts           # submitInput -> triageReportInput
-└── isolation.test.ts                  # removed by decision
 src/cmd/attached/index.ts              # `triage_report` and `plan_written` subcommands
```

The child 01 tests in `coordinator.test.ts`, `src/cmd/attached/index.test.ts`, and `src/attached/claude/mcp.test.ts`
change only the operation and helper names.

- `src/shared/session/agents.js` — `loadAgentDef` is reused unchanged; change it only if it cannot run without a
  Session.
- `src/shared/session/bridged-tools/prompt.ts` — reuse `buildBridgedToolPromptAppendix` for the tool-name map; extend it
  only if Claude's native names need entries it lacks.
- `src/plan-store.js`, `src/shared/workflow/plan-location.ts`, `src/shared/project-runtime-layout.ts` — reused for
  identity, front matter, location, and runtime entry. No change expected.
- `docs/domain-language.md` — add Attached Role Instructions and the Plan reference relationship.
- `docs/prd/runwield-connect-prd.md` — update the activation scope note to what this child delivers.
- `docs/adr/014-attached-workflow-coordination-boundary.md`, the Epic, and child 07 — already edited in planning (see
  Epic Scope Changes).

Not touched: `src/shared/workflow/controller-registry.ts`, Plan Events, `src/tools/plan-written.ts`, and review code.

## Reuse Opportunities

- `src/tools/plan-written.ts` — copy the order of its Plan checks (`resolveWorkflowPlanLocation`, `ensurePlanIdentity`,
  `resolvePlanExecutionPolicy`, `updatePlanFrontMatter`), not its Hosted Session or review code. If the shared part is
  more than a few calls, extract a function both callers use instead of keeping two copies.
- `assertNotReservedEpicArtifactPlanName` — same Plan-name rule as Core's `plan_written`.
- `normalizePlanClassification` and `normalizeWorkKind` (`src/constants.js`) — Triage fields become front matter the
  same way `resolveTriageMeta` does it.
- `src/shared/attached/attached-test-fixture.ts` and `defineGitFixture` — real records and real Git repositories in
  tests.

## Implementation Steps

1. `src/shared/attached/isolation.test.ts` no longer exists. No other test asserts the Attached import graph.
2. The Triage operation is named `triage_report` everywhere: `AttachedOperationName`, `ATTACHED_OPERATIONS`,
   `parseTriageReportInput`, `TriageReportEnvelope`, `TriageReportPayload`, the coordinator's `triageReport`,
   `runAttachedOperation`, `wld attached triage_report`, the MCP tool list, and the test fixture `triageReportInput`. No
   alias remains: `wld attached submit` prints the usage error and the MCP server has no `submit` tool. Records written
   by child 01 under the old name need no migration, because no one uses the preview yet.
3. When `triage_report` accepts a PLANNED_CHANGE Triage outcome, the record's `pendingAction` is
   `{ actionId, role: "planner", contractVersion: ATTACHED_PLANNER_CONTRACT_VERSION }` and the view's `nextAction` is
   `{ kind: "plan", actionId, role, contractVersion, projectSetup }`. `projectSetup` lists the repository paths that
   `plan_written` will create and is empty when the project runtime already exists.
4. `src/shared/attached/role-instructions.ts` exports `resolveAttachedRoleInstructions(projectRoot, role)`. It returns
   the text of `loadAgentDef(role, projectRoot)` with the tool-name map and the Attached addendum appended. A
   `.wld/agents/planner.md` in the project changes the next returned Planner instructions with no other step.
5. Every `activate`, `triage_report`, `plan_written`, and `status` result whose workflow has a pending router or planner
   action carries `instructions: { role, contractVersion, text }`. The saved result in `acceptedOperations` contains no
   `instructions` field; a replayed operation returns current instructions.
6. `plan_written` is an operation in `ATTACHED_OPERATIONS`, `parsePlanWrittenInput`, `wld attached plan_written`, and
   the MCP tool list. Its payload is `{ actionId, planName, executionAgent?, collaborationRecommendation? }`, parsed
   with the same strict rules as child 01 envelopes.
7. An accepted `plan_written` leaves `docs/plans/<planName>.md` with a `planId`, the Triage `classification`,
   `workKind`, and `complexity`, and the given execution policy. The project has `.wld/internal/` and the managed
   `.gitignore` block. The record is at the next revision with state `plan_submitted`, `plan: { planId, planName }`, no
   pending action, and `nextAction: { kind: "plan_submitted", planName }`. No Plan Event is recorded.
8. `plan_written` rejects without changing the record or the Plan when the Plan file is missing (`invalid_outcome`), the
   name is a reserved Epic artifact name (`invalid_outcome`), the execution policy is invalid (`invalid_outcome` with
   the policy error), the action is not pending (`action_superseded`), or the revision differs (`revision_conflict`).
   After a rejection for a missing file or bad policy, the pending planner action stays, so Claude can fix it and submit
   again.
9. A repeated `plan_written` with the same `operationId` returns the saved result and leaves the Plan file unchanged.
10. `src/attached/claude/plugin/` holds a manifest, `commands/runwield.md`, and `.mcp.json`.
    `claude --plugin-dir
    src/attached/claude/plugin` loads it. The command tells Claude to call `activate` with the
    user's text and then follow the `instructions` in each result. Without `/runwield`, the plugin adds no context and
    no tools other than its MCP server's tool list.
11. The MCP carrier fills `evidence.host`, `evidence.hostVersion`, and `evidence.adapterVersion` from the MCP client
    info and the plugin version. The CLI carrier still requires `evidence` in its input.
12. `docs/domain-language.md` defines **Attached Role Instructions** (the effective layered agent instructions Core
    returns with a pending host action; _Avoid_: generated Skill, role contract copy) and states that an Attached
    Workflow Record references its Plan but does not own it.
13. The Connect PRD activation scope note says the Claude Code plugin delivers activation steps 1, 3, and 4 and Plan
    submission. Review, execution, the install flow, and full preflight stay target scope.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/shared/attached/ src/cmd/attached/ src/attached/claude/`.
- `coordinator.test.ts` (real record store, real Git fixture):
  - Triage to Planner: after a PLANNED_CHANGE `triage_report`, `status` returns a planner action and Planner
    instructions whose text contains the bundled Planner definition.
  - Override: with a project `.wld/agents/planner.md`, the returned text is that file's body. This test fails if the
    instructions are a constant or bundled-only.
  - Replay: call `triage_report`, change the project override, repeat the same `operationId`. The result has the new
    instructions, and the saved record has no `instructions` field.
  - Plan submission in a repository with no `.wld/`: the Plan file gains `planId` and Triage front matter,
    `.wld/internal/` and the `.gitignore` block exist, and the record has `plan_submitted` and the Plan reference. This
    test fails if `plan_written` only updates the record.
  - Rejections: missing file, reserved name, invalid policy, wrong action, and stale revision each leave the record
    revision and the Plan file bytes unchanged.
  - Retry: a repeated `plan_written` returns the saved result and the Plan file bytes do not change.
  - Hand-off: after `plan_written`, `loadPlan` finds the Plan in `draft` with its `planId`, the same view `wld` uses.
- `src/cmd/attached/index.test.ts`: `wld attached triage_report` and `wld attached plan_written` give the same result as
  the coordinator for the same input. `wld attached submit` exits with the usage error.
- `src/attached/claude/mcp.test.ts`: the tool list is exactly `activate`, `triage_report`, `status`, `plan_written`; a
  call with no `evidence` gets evidence from the client info.
- Manual pair check with Claude Code 2.1.292 and `claude --plugin-dir src/attached/claude/plugin`, in a new Git
  repository with no `.wld/`:
  1. Send an ordinary prompt. No RunWield text appears and no record is created under `~/.wld/attached/`.
  2. Run `/runwield add a dark-mode toggle`. Claude triages, shows the setup preview, writes the Plan, and calls
     `plan_written`.
  3. Run `wld` in the repository. The Plan is listed in `draft` with its Plan ID.
  4. Ask Claude something unrelated in the same conversation after submission. It answers normally.
- Protected behavior: child 01's `activate`, Triage, `status`, retry, revision-conflict, and project-moved tests still
  pass. Only the operation and helper names change (`submit` to `triage_report`); their assertions stay the same. Core's
  `plan_written` (`src/tools/plan-written.ts`) and its tests are unchanged.
- Behavior expected to stop existing: the import-graph assertions in `isolation.test.ts`, by decision.
- Expected: no Core model call, no Hosted Session, no hooks, and no tool restrictions in the plugin.
- Docs: the glossary, the Connect PRD scope note, ADR-014, and the Epic describe run-time instructions and no planning
  gate. None of them claims review, execution, or install delivery.

## Edge Cases & Considerations

- **Claude edits code during planning.** Allowed, as with the Planner in Core. RunWield does not detect it or block it.
- **Claude cannot call a RunWield-only tool** named in the instructions (for example `code_search` or `memory`). The
  tool-name map names Claude's equivalent where one exists; the addendum tells Claude to use its own tools otherwise.
- **No planning worktree.** Core Planner Sessions may plan in a worktree; here Claude writes in its own working
  directory. `plan_written` resolves the Plan with `resolveWorkflowPlanLocation` from the project root the MCP server
  was started in.
- **The user runs the Plan with `wld` before child 03 exists.** Allowed and wanted. The Attached record stays at
  `plan_submitted`; child 03 must accept that the Plan may have moved on.
- **Assumption: Claude's session ID as `hostRequestId`.** Use `${CLAUDE_SESSION_ID}` in the command if 2.1.292
  substitutes it; otherwise the command tells Claude to generate an ID. It is binding evidence only.
- **Assumption: setup preview without a confirmation step**, as described in Approach. Reviewable.
- **Assumption: the plugin lives under `src/attached/claude/plugin/`.** Child 07 may move it when it builds the install
  flow.
