---
planId: "8faf46c2-95d7-4e2d-8458-194172ff0e9a"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/metrics.js"
    - "src/shared/workflow/execution-metrics.ts"
    - "src/shared/session/session.js"
    - "src/shared/session/session-context-report.js"
    - "src/shared/session/backends/"
    - "src/shared/session/bridged-tools/mcp-bridge.ts"
    - "src/shared/session/runtime/turns.ts"
    - "src/ui/tui/slash-dispatch.ts"
    - "src/acp/server.js"
    - "src/ui/workspace/islands/SessionSurface.jsx"
    - "src/ui/workspace/routes/owner-session-api.js"
    - "docs/settings.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-08T01:08:52-04:00"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "4208a46e3a0b16bd803c45d722f2a9ccedd3565f"
workRecord:
    status: "generated"
    recordId: "e24fc4b5-cf6e-488e-a977-b5f90016d8a2"
    path: "docs/work-records/2026-09-29-opt-in-local-workflow-metrics-across-execution-surfaces.md"
    lastAttemptAt: "2026-09-29T21:51:38.721Z"
archivedAt: "2026-10-08T20:05:46.388Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/complete-tool-call-metrics.md"
---

# Complete Tool-Call Metrics

## Context

> [!NOTE]
> **Independent recording change; metrics stay off by default**
>
> The owner confirmed that this Plan runs on its own and only expands recording. It does not depend on
> [Reliable Usage, Workspace Dashboard, and Langfuse Export](reliable-usage-dashboard-and-langfuse-export.md). That Epic
> overlaps this work, but its default-on policy is not current owner intent. Leave the Epic and its children unchanged
> here; their later revision must reconcile delivered recording and use the same Core requirement owner. No dashboard,
> export, retention controls, or new storage service is included in this Plan.

RunWield already records sanitized tool-call start and finish events for Pi session subscribers. Coverage is not yet
proven across Claude CLI/MCP, isolated repairs, delegated agents, cancellation, and failure paths. Call counts also lack
the advertised-tool and estimated-schema-token denominator needed for context-reduction decisions.

The owner expanded this draft to recording for a future dashboard: ordered tool use, model usage and cost, context
pressure, and slash commands. Reporting remains out of scope. All proposed measurements below were accepted, including
normalized bash labels in place of raw commands.

Current gaps are concrete: background Pi children skip UI subscribers; the shared CLI bridge writes no tool metrics;
call IDs are not saved; CLI parsers lose usage availability; and the generic sanitizer redacts numeric token fields.
Pi's context estimate and usage-bearing transcript entries provide reusable measurement sources.

**Product ownership:** Add a proposed **Local workflow metrics** capability at
`docs/prd/runwield-core-prd.md#local-workflow-metrics`. It will own opt-in local recording, per-Project separation,
content exclusion, ordered activity, usage attribution, and honest measurement coverage. This fills a gap in the current
PRD, not a new reporting promise. Preserve the existing settings contract in
[Settings](../user-documentation/settings.md#workflowmetrics).

Preserve [Models and providers](../prd/runwield-core-prd.md#models-and-providers),
[Compaction and image context](../prd/runwield-core-prd.md#compaction-and-image-context), and
[Session continuity](../prd/runwield-core-prd.md#session-continuity). Add shared-requirement links and command-recording
scenarios to [Browser Sessions](../prd/runwield-workspace-prd.md#browser-sessions) and
[ACP Session access](../prd/runwield-acp-protocol-prd.md#acp-session-access). Metrics do not own workflow state, Session
history, billing, or command behavior.

## Objective

Save enough observations to construct useful Project dashboards later, without adding a dashboard, report, or summary
command now. From records alone, a reader must be able to derive:

- Tool counts, frequency per execution/turn, first/last/most-used tools, and ordered transitions within each Agent's
  work.
- Memory operations, normalized bash command labels, and ordered `code_batch` child operations.
- Tool exposure and estimated schema/context cost, including executions that call no tools.
- Input/output/cache-read/cache-write tokens, monetary cost, source, coverage, and links to the work that used them.
- Context occupancy and capacity, compaction changes, tool-result size/truncation, retries, interruptions, and latency.
- Slash-command counts, names, surface, outcome, duration, and the model/tool work they initiate.

Keep `workflowMetrics` disabled by default, with the existing merged global/project setting. Store records only in
`~/.wld/workflow-metrics/<encoded-primary-project-root>/metrics.jsonl`. Separate Projects stay separate; linked
worktrees share the primary Project file. Keep existing retention and best-effort writes. No upload, analytics sync,
historical transcript backfill, automatic tool-bundle changes, or metrics-driven workflow decisions.

## Approach

### One recording owner, several observation sources

Keep storage and setting enforcement in `src/shared/workflow/metrics.js`. Add a cohesive execution recorder in
`src/shared/workflow/execution-metrics.ts` to own identity, ordering, pairing, measurement normalization, and
settlement. It must do this work, not just forward calls. Surface and backend adapters supply observations; they do not
each invent schemas, outcome rules, or privacy filters.

```text
Pi events + new usage entries     CLI stream + shared MCP bridge     slash dispatch
                 \                         |                         /
                    execution/command observation records
                              |
                  existing opt-in Project JSONL writer
```

Separate metrics observation from foreground display subscriptions. Root work, foreground isolated work, and background
children must receive the same recording rules without making hidden work appear in the foreground UI. Capture Agent,
model, and execution identity when work starts, not from mutable foreground state when it ends.

A larger runtime or transcript rewrite is not needed. Keep the adapter boundary from
[ADR-010](../adr/010-session-runtime-sibling-adapters-and-acp.md) and the authority boundary from
[ADR-015](../adr/015-file-authoritative-session-bundles.md). No ADR decision changes are planned.

### Record contract

Use version 2 for the new observation records. Keep unrelated version-1 workflow records and old files valid; do not
rewrite them or invent missing fields. Retain `ts`, `category`, `event`, and `cwdHash`. New records have an `eventId`, a
recorder scope ID, and a monotonic sequence assigned at observation time, before asynchronous disk writes.

Link records with actual available identities: managed Session, transcript segment, execution, request, attempt, turn,
model request, command invocation, parent execution/tool call, and Background Task. Each identity has a distinct field.
Use generated or validated opaque IDs, never transcript paths, request hashes, prompt-derived labels, or text. Mark
unavailable links explicitly. A child execution must not claim its parent's transcript segment as its own.

Every execution records its Agent, provider, model, backend, dispatch kind, and execution kind (`root`, `isolated`, or
`delegated`, with foreground/background mode). Reuse `prepareRequestDispatch` request/attempt identity. Pass parent-call
and task identity through delegation; do not change workflow dispatch semantics just to label metrics.

| Event family         | Required observations                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution start/end  | Attribution, source surface, request/attempt links, outcome/reason code, elapsed time, coverage, and observed call count; include zero-call work.                                                                |
| Tool exposure        | An exposure ID, effective tool names, per-tool schema-only and resident-context token estimates, estimator version, inventory coverage, and total count. Calls link to the active exposure ID.                   |
| Tool start/end       | Namespaced tool identity, call ID, start sequence, outcome, elapsed time, fixed error/rejection reason, result text bytes and estimated text tokens, image count, and truncation when known.                     |
| Tool operation       | Parent call ID and operation index; Memory `recall`/`store`/`delete` and scope; normalized bash labels; each `code_batch` requested `show`/`outline` operation with its own result status and truncation.        |
| Model usage          | Source observation ID, usage kind, model attribution, input/output/cache-read/cache-write tokens, monetary amount/currency/source, measurement availability, aggregation basis, and relevant request/turn links. |
| Context snapshot     | Capacity, current usage, static category counts, usage state/source, and sampling point: execution/turn start/end and before/after compaction.                                                                   |
| Compaction and retry | Manual/threshold/overflow reason, start/end/outcome, available before/after context, retry source/index/delay/outcome, and cancellation/interruption reason. No summary or error text.                           |
| Response latency     | Backend-turn or model-request start, first response, first visible text, and end, with basis and availability. Tool duration remains separate.                                                                   |
| Slash command        | Invocation ID, canonical name and recognized alias, builtin/template/skill kind, originating surface, phase/outcome, duration, and linked execution IDs.                                                         |

Define event-specific typed allowlists for these records. Numeric `inputTokens`/`outputTokens` and opaque `requestId`
must survive; credentials or arbitrary fields with similar names must not. Do not weaken the generic sanitizer or the
existing dedicated frontend-event privacy policy. Store one exposure item per tool rather than silently losing tools
beyond the existing 40-element array limit. Include an exposure summary/count so incomplete snapshots are detectable.

### Ordering, outcomes, and interruption

Sequences describe observed starts within one execution, not a global order across parallel Agents. Parent/child IDs and
timestamps permit cross-execution analysis without inventing a causal order. Preserve batch operation position as
**requested order**; Cymbal groups and deduplicates actual subprocess reads.

Start/end pairs share a call ID scoped to their execution. Duplicated source observations do not create duplicate calls.
Returned `isError`, thrown errors, bridge rejection, cancellation, and missing ends are distinct. Fix the shared
bridge's loss of a returned `isError` before recording its result. An authenticated known-tool rejection is not a
successful execution; unauthenticated transport traffic is not an Agent tool call.

At normal cleanup, settle still-open calls as canceled or incomplete according to the observed reason, and release
tracking state. `WorkflowStepCompleted` is accepted completion, not a failure just because it aborts the backend. Record
observed call results before applying turn settlement. Hard process loss can leave unmatched starts: do not fabricate an
end event or a duration. Attempt-end coverage must expose missing measurements.

Serialize writes within the local writer and provide a bounded drain at execution/command cleanup. Write failures and a
stopped process still cannot guarantee delivery. Recording must not fail, retry, or indefinitely delay the user's work.
Do not add a persistent delivery queue, recovery service, or new locking system for metrics.

### Model usage and context are different measurements

Pi exposes assistant usage and usage-bearing `usage`, `compaction`, `branch_summary`, and `toolResult` transcript
entries. Read only newly added entries in the active operation, using entry IDs for deduplication. Reconcile at
settlement, including failed/canceled operations. Do not re-record old entries when resuming or switching Agents. Use
live events for latency/context; do not count the same usage again from live and committed sources.

Normalize provider token semantics explicitly. Record whether input includes cache counts, and do not sum overlapping
fields. Use `null` plus a fixed unavailable reason for missing measurements; preserve a measured zero. Pi rate-based
cost is calculated cost, not an invoice. CLI reported amounts are reported cost. Currency is explicit (USD for current
sources); missing rates do not mean free work.

For CLI usage, consume supported observations before checking terminal success. Preserve available usage on failed
turns. Parse Claude's top-level `total_cost_usd` and supported per-model usage as well as nested usage. Link aggregate
turn totals and per-request/per-model observations as alternative bases, not additive charges. When only turn totals
exist, do not invent model-request cost. Compaction or retry usage absent from a backend remains unavailable.

A context snapshot is current occupancy, not cumulative billed tokens. Reuse `estimateContextTextTokens` (characters/4)
and current context report state. Keep schema-only estimates separate from the existing resident estimate, which also
includes descriptions and prompt guidance. After compaction, preserve `unknown_after_compaction` until a usable
measurement exists. Never record raw schemas, prompts, summaries, or tool results.

### Backend coverage

| Source                                                   | Required delivered coverage                                                                                                                     | Explicit limit                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Pi root, isolated repair, foreground/background delegate | Tool lifecycle/operations, actual configured inventory, available usage entries, context, retries, compaction, latency                          | Missing provider usage stays unknown; no additional model calls to measure it.                                         |
| Shared CLI MCP bridge, including Claude and Antigravity  | Known admitted and rejected calls, results/errors/cancel, bridge inventory/estimates, parent execution links                                    | Bridge inventory is not the complete native CLI inventory.                                                             |
| Claude stream                                            | Native tool-use/result observations supported by verified stream fixtures; usage including failed turns and reported total cost; first response | Native schema cost/context occupancy and unobserved tools remain explicitly partial/unavailable.                       |
| Antigravity stream                                       | Available tool-info observations and usage, native observation identity when supplied, first response                                           | Tool-info progress is not automatically a complete call; missing IDs/results/cache/cost/context cannot be synthesized. |

Native CLI observations must not count the same Bridged Tool again. The bridge owns its calls; stream adapters exclude
or correlate its known aliases. Keep foreign native tool namespaces distinct. Preserve available observations even when
a source cannot provide a complete pair. Mark coverage by measurement and source; a global `complete: true` flag is not
sufficient. Document the supported CLI versions and fixture provenance.

### Content exclusion and normalized commands

Only resolved tool/Agent/model/command identifiers, fixed enums, opaque IDs, booleans, and bounded numbers belong in new
records. Unknown slash names or tool aliases use a fixed `unknown` label, not arbitrary submitted text. Custom resolved
names remain identifiers; descriptions, targets, paths, arguments, queries, results, errors, and user text do not become
metric fields.

Bash normalization uses a finite vocabulary of known executables and public subcommands. Recognize labels such as
`git status`, `git diff`, `deno task test`, and `npm test`; strip all argument values, environment assignments,
redirects, paths, URLs, and literal/script bodies. Unknown executables or custom task names become `other`, not copied
basenames. For safely parsed pipelines/chains, retain ordered labels under the one bash call. Dynamic expressions,
command substitution, malformed quoting, and unsupported syntax receive a fixed unknown/partial marker. Never execute
shell text to classify it. Keep this policy in one normalizer with adversarial tests, not in each backend adapter.

Memory records retain action and effective scope, not query, content, tags, or document ID. Unified recall identifies
both project and global scopes; store/delete identify the selected mutation scope. Do not label unified recall as
project-only. Batch records retain operation kind and result status, not target symbol/file. Result-size measurements
use bounded numeric values; text bytes/tokens and image count must not imply image-token precision. Unknown truncation
stays unknown.

### Slash-command coverage

Record builtins at their actual dispatch/settlement boundaries in TUI, ACP, and Workspace. Resolve names through the
shared command catalog; include the ACP `/plan-review` early path. A handler that catches an error must still report an
error outcome. Picker opened, work dispatched, succeeded, canceled, rejected, and failed are distinct phases/outcomes;
opening `/model` is not proof of a model change. Do not change the existing command effects to simplify metrics.

Record template and Skill invocations once at `RuntimeTurns.promptUserTurn`, not inside `resolveNamedInvocation`, which
also runs during preflight. Preserve one invocation ID across replacement-Session recursion and resulting work. A
surface acceptance and Core expansion must not become two commands. Carry surface/invocation links into resulting
execution contexts. Commands without model work have no model-usage record; later unrelated turns do not inherit them.

For browser-only commands, add `POST /api/owner/projects/:projectId/command-metrics` beside the Owner Session routes.
Use existing `ownerFetch`, paired-device/origin/CSRF protection, and `requireOwnerProjectRoot`. Accept only a bounded,
validated command-observation payload; derive the Project root on the server. Check any optional Session link belongs to
that Project. Write through the local recorder, not Workspace SQLite, shared artifacts, or SaaS services. It must work
in new-Session mode without creating a Session. No offline browser backlog or network-dependent command failure.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/metrics.js` and new `execution-metrics.ts` with focused tests — typed observations, privacy,
  pairing, sequence, usage identity, local writes, and bounded drain.
- `src/shared/session/session.js`, `session-context-report.js`, and `request-dispatch.ts` — independent observation for
  every execution, true attribution, effective tool exposure, and context snapshots.
- `src/shared/session/background-tasks.ts` and `src/tools/delegate-agent.ts` — parent call/task links and recording for
  background children without foreground UI changes.
- `src/shared/session/bridged-tools/mcp-bridge.ts` and CLI backend parsers/execution owners — bridge error truth, native
  observations, usage availability, partial failure, and deduplication.
- `src/extensions/cymbal/tools.ts` and `src/extensions/mnemoteca/tools.ts` — reuse operation metadata; change result
  metadata only if needed for reliable measurement. Do not expose private tool inputs through a new public seam.
- `src/shared/session/runtime/turns.ts`, named-invocation handling, TUI slash dispatch, `src/cmd/`, and
  `src/acp/server.js` — one command invocation across resolution, execution, and actual outcomes.
- `src/ui/workspace/islands/SessionSurface.jsx`, Owner Session routes, and `server.js` — local command transport and
  asynchronous command settlement; no visual redesign.
- `src/testing/workflow-metrics-fixture.ts` and boundary tests — version-2 real-file assertions under sandboxed HOME.
- `docs/settings.md`, Core/Workspace/ACP PRDs, and applicable CLI coverage docs — schemas, examples, source limitations,
  privacy, settings inheritance, and acceptance scenarios in the same change.

No glossary change is needed: Session, Agent Session, Execution Backend, Bridged Tool, and Background Task keep their
current meanings. New metric field names are technical schema terms, not replacements for these domain concepts.

## Reuse Opportunities

- `recordWorkflowMetric`, `getWorkflowMetricsFilePath`, and `resolvePrimaryCheckoutRoot` — retain the current setting,
  local storage, Project isolation, and linked-worktree behavior.
- `prepareRequestDispatch`, `HostedSession.getManagedMetadata`, and SessionManager entry IDs — reuse actual identity
  rather than reconstructing it from prompts or display labels.
- `estimateContextTextTokens`, `serializeToolContextForProjection`, and runtime context readers — share estimates and
  state, while separating schema-only cost from resident context.
- Shared MCP bridge admission/result points and CLI process/stream boundaries — observe real execution, not replay.
- `getSlashCommandDefinition`, `RuntimeTurns.promptUserTurn`, and Owner HTTP authentication — use existing dispatch and
  trust boundaries without creating a second command engine.
- `withWorkflowMetricsFixture`, `defineGitFixture`, and `withProcessGlobalTestLock` — prove real writes safely; no
  recorder/settings/filesystem injection seams.

## Implementation Steps

1. **The recording contract is explicit and safe.** `metrics.js` and `execution-metrics.ts` implement the event
   families, versioning, field-specific allowlists, availability states, identities, and order defined above. Normalized
   bash, Memory, and batch operation extraction excludes private content before queued writes. Existing unrelated
   metrics and dedicated frontend sanitization remain compatible.
2. **Every owned execution records independently of UI visibility.** Root and isolated setup attach the recorder once;
   background delegation carries parent/tool/task identity. Start, retries, configuration/exposure changes, zero-tool
   work, settlement, and bounded drain are recorded through real execution paths. Per-execution call state is released
   on success, failure, cancellation, and disposal. Subscriber reattachment and duplicate events do not multiply calls.
3. **Bridge and CLI observations are truthful.** The shared bridge preserves returned `isError`, records rejection and
   cancellation distinctly, and uses execution identity. Claude parses native lifecycle and available usage from
   version-qualified stream fixtures. Antigravity preserves usable tool-info/usage without manufactured pairs or zero
   measurements. Bridge/stream duplicates and aggregate/detail usage cannot be counted twice.
4. **Model/context measurements cover more than replies.** Pi new-entry reconciliation includes standalone usage,
   compaction, branch summaries, and usage-bearing tool results, with no historical replay. Backend usage survives
   failed terminal status where supplied. Token basis, cost source/currency, context unknown states, compaction,
   retry/interruption, first-response timing, and result sizes match their observed sources.
5. **Slash commands are recorded once across surfaces.** Builtin handlers report real phases/outcomes even when they
   catch errors. Template/Skill invocations keep one ID through shared resolution and resulting Agent work. Workspace
   has the authenticated local Project endpoint, including new-Session commands; unknown commands are content-free
   rejections. Metrics transport cannot change command results or cause Session creation.
6. **Boundary tests prove useful records, not just helper calls.** Real Project JSONL from Pi, bridge/CLI fixtures,
   background delegation, and slash-command paths supports exact counts, order, attribution, and usage assertions below.
   Privacy, failure, concurrent writing, opt-out, and partial-source tests cover every new event family.
7. **Product and settings documents match delivered behavior.** Core owns the new Local workflow metrics requirements
   and scenarios; Workspace/ACP link to them. Settings document v1/v2 coexistence, fields, normalization, units,
   aggregation rules, availability, retention, and backend coverage. Mark unavailable targets as deferred. Preserve all
   current model, command, context, Session, and workflow semantics; do not claim a dashboard or new domain model
   shipped.

## Approval Confirmation

No Work Record supersession is proposed. This extends existing local recording. The owner confirmed recording-only
scope, local per-Project storage, all listed measurements, and normalized bash labels. The owner also confirmed
**default-off recording and independent execution**, with no dependency on or changes to the dashboard/export Epic.
Execution owner: `engineer`; style: `autonomous`.

## Verification Plan

Run focused tests through the safe runner, never `deno test` directly. Add the proposed focused suites named below;
extend adjacent existing suites as needed. Full CI is performed by the normal workflow, not duplicated here.

```sh
deno run -A scripts/run-tests.js src/shared/workflow/metrics.test.js src/shared/workflow/execution-metrics.test.ts src/shared/session/session-metrics.test.ts
deno run -A scripts/run-tests.js src/shared/session/session-subscribers.test.js src/shared/session/session-prompt.test.js src/shared/session/session-context-report.test.js
deno run -A scripts/run-tests.js src/shared/session/backends/claude-cli/claude-cli-backend.test.ts src/shared/session/backends/claude-cli/mcp-bridge.test.ts src/shared/session/backends/agy-cli/agy-cli-backend.test.ts src/shared/session/claude-cli-execution.test.ts
deno run -A scripts/run-tests.js src/shared/workflow/command-metrics.test.ts src/ui/tui/slash-dispatch.test.ts src/ui/workspace/command-metrics.test.ts
deno task seams:check
```

Required behavioral evidence:

1. **Project and setting ownership:** an absent setting, explicit `false`, and `{ enabled: false }` each create no
   metrics file for any new family. Explicit `true` and `{ enabled: true }` enable recording. Global opt-in, Project
   override, two Projects, and a linked worktree produce the existing intended separation. Parallel producers and two
   local processes leave parseable JSONL with all expected event IDs under normal conditions. A blocked metrics
   directory does not fail Agent work or slash commands; cleanup does not wait forever.
2. **Counts and ordering from saved data:** a real execution fixture runs `read`, Memory recall, `code_batch` with
   `[show, outline, show]`, and normalized bash, plus a delegated child and a zero-call turn. Shuffle the parsed JSONL
   rows, reconstruct by IDs/sequences, and assert exact first/last/most-used tools, adjacent transitions, execution
   denominators, and parent-child links. Assert one batch parent and three ordered operation records, including mixed
   success and duplicate targets, not four top-level calls. Removing background observation must fail this test.
3. **Lifecycle truth:** use real subscriber/bridge boundaries for success, returned error, thrown error, known-tool
   rejection, invalid arguments, user cancellation, accepted `WorkflowStepCompleted`, duplicate end, same provider call
   ID in two executions, and missing end. Each observed call has at most one terminal metric. Simulate hard process loss
   after a flushed start; it remains incomplete without a fabricated success or latency.
4. **Usage arithmetic:** fixtures contain ordinary assistant usage, compaction, branch-summary, standalone usage,
   usage-bearing tool results, and a retry with partial usage. Assert the exact numeric totals and model attribution
   from saved records, including cache read/write, calculated cost, and a measured zero. Resume/reattach and assert no
   old usage is re-recorded. For Claude, detail records plus a turn total must have one documented accounting basis;
   failure after valid usage preserves that usage. Missing CLI cache/cost values are null/unavailable, never zero.
5. **Exposure and context:** configure more than 40 tools and assert every effective name and numeric estimate survives.
   Change Agent/tool configuration and assert calls link to the new exposure, not the previous one. Zero-use exposed
   tools remain visible. Verify separate schema/resident estimates, capacity, before/after compaction, and unknown
   occupancy after compaction. Replacing measurements with constants or zero must fail numeric fixture assertions.
6. **Native/bridge coverage:** replay version-qualified sanitized CLI fixtures through real parsers and execution
   owners, including native calls, a RunWield bridged call also present in the stream, duplicate progress, failed
   status, and truncated streams. Assert one bridge count, supported native observations, available usage, and partial
   coverage where information is absent. A parser that drops all native events cannot pass the Claude case.
7. **Slash journeys:** real TUI, ACP, and Owner HTTP paths cover `/help`, a recognized alias, a rejected command,
   `/plan-review`, a canceled picker, a failed asynchronous command, `/compact`, a template, and `/skill:name`. Assert
   one invocation, true outcome, correct surface, no argument text, and linked work where applicable. Include preflight
   and replacement-Session recursion to catch double counts. Browser new-Session commands record without creating a
   Session; opening a picker is not a completed change. Unauthorized, wrong-origin, cross-Project Session links, and
   malformed/oversized metric payloads cannot append records. Recording failure leaves command behavior unchanged.
8. **Privacy at the file boundary:** plant unique secret/path/query/result markers in every input and result source,
   including rejected tools, custom task names, shell environment assignments, pipes, redirects, `sh -c`, heredocs,
   substitutions, URLs, invalid slash names, summaries, and provider errors. None may appear in saved JSONL. Known
   normalized labels still distinguish `git status`, `git diff`, and `deno task test`; Memory actions and batch kinds
   remain distinct. Raw command text and arbitrary fields must not pass the explicit numeric/identity allowlists.
9. **Timing and result measurements:** controlled provider/subprocess fixtures separate request start, first response,
   first visible text, and completion. Assert ordered timings and elapsed bounds that fail for constant-zero values; use
   clock control only at the genuine clock boundary if needed. Assert exact byte counts for multibyte result text, the
   documented token estimate, image count, known true/false truncation, and unavailable truncation. Exercise a retry
   followed by success, retry cancellation, and manual/automatic compaction; assert source, attempt count, reason,
   outcome, and before/after context from saved records. Missing observations stay unavailable.

**Manual verification:** In disposable Projects with metrics enabled, run one short Pi Session, one background delegate,
and available Claude/Antigravity turns; exercise `/context`, `/compact`, a canceled picker, and a named invocation. Use
synthetic harmless tool inputs. Inspect local JSONL for available fields and absence of private text. In a paired
browser, run a new-Session navigation command and a command that starts work; confirm local-only recording and unchanged
UI behavior. Record CLI versions and any unavailable live checks; do not substitute a mock for a claimed live result.

**AI review:** Check that production paths reach the recorder, the generic sanitizer was not relaxed, foreground UI
subscriptions no longer control coverage, no metrics become workflow authority, and no cloud storage/export was added.
Check Core/Workspace/ACP capability scenarios against actual tests and documented limits.

Existing tests must continue to protect opt-in/default-off behavior, worktree grouping, fail-open recording, private
content exclusion, dedicated frontend privacy, command effects, background invisibility, retry cancellation, accepted
workflow completion, and context unknown states. Only the old impoverished tool-record shape and CLI missing-as-zero
metric interpretation are replaced. Existing Runtime/UI compatibility must not be silently changed to fit the new
metrics types.

## Edge Cases & Considerations

- **Incomplete data is not failure of the user's work.** Metrics remain best-effort. Unmatched starts and incomplete
  coverage are honest evidence; no exactly-once or crash-recovery guarantee is introduced.
- **Parallelism:** timestamps and file order cannot define a total causal order. Scope-local sequence and parent links
  are authoritative only for observed metric ordering, never workflow state.
- **No double charging:** child Agent cost belongs to the child execution; parent tool duration can include waiting, but
  it does not carry a second copy of that cost. Cumulative provider snapshots are not additive events.
- **Custom names:** resolved catalog identifiers may appear, but arbitrary unknown names, task arguments, and source
  content do not. Conservative bash normalization gives less detail in exchange for the approved privacy boundary.
- **Opt-out during an execution:** stop new writes under the existing setting gate; do not retain raw observations or
  backfill the missing interval. Consumers must not infer completeness from an absent end record.
- **Legacy data:** version-1 records lack the new denominators and identities. Leave them intact and document their
  limits; do not assign guessed Sessions or sequence numbers.
- **Assumption for review:** `!`/`!!` user shell shortcuts and standalone top-level CLI commands are not slash commands
  or Agent tools, so they remain outside this change. Their inclusion would be a separate scope extension.
- **Assumption for review:** browser recording uses the existing local Owner server, including paired-device access.
  Future SaaS analytics and RunWield Connect host telemetry remain out of scope.
