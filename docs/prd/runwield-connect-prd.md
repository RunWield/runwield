# Product Requirements Document: RunWield Connect

**Document role: Living central PRD.** Principles and lasting requirements for using RunWield inside external agent
hosts.

Keep this document as current product guidance. Fold lasting requirements from completed feature PRDs here;
implementation steps belong in Plans, architectural choices in ADRs, and delivery evidence in Work Records.

Last updated: 2026-09-11

## Objective

Make RunWield's planning, verification, and organizational-memory workflow available inside the coding agent a user
already prefers, without making RunWield the user's default interface or model execution layer.

**RunWield Connect** should let a user keep Claude Code, Codex, OpenCode, or Pi, explicitly invoke RunWield for one User
Request, and receive the deepest workflow that the External Agent Host can honestly support. Every LLM call remains
owned and made by the External Agent Host. RunWield Core remains authoritative for durable workflow truth: Plans,
review, Plan Lifecycle, execution isolation, validation outcomes, recovery evidence, Work Records, and organizational
memory.

RunWield Connect is the public name for this plugin ecosystem, beginning with first-party plugins. **Attached mode**
remains the internal architectural term, and an **Attached Workflow** remains the per-request domain object coordinated
through a Connect plugin. Public installation, distribution, compatibility, and documentation surfaces should say
RunWield Connect or RunWield Connect for the relevant host.

Connect is both a low-friction acquisition surface and a durable first-class part of RunWield. Users who never adopt
RunWield Core as their primary interface or RunWield Workspace must still receive a complete, trustworthy product.
Adoption of other RunWield surfaces should be earned through stronger integration and convenience, not forced through
deliberate feature withholding.

The product-family promises are:

| Product            | Promise                                                  |
| ------------------ | -------------------------------------------------------- |
| RunWield Connect   | Keep your agent. Add RunWield planning and verification. |
| RunWield Core      | Run the complete local workflow through `wld`.           |
| RunWield Workspace | Collaborate on planning and records across projects.     |

When Core drives a workflow but delegates agent turns to Pi, Claude through `claude -p`, or another harness, those are
Execution Backends within Core. They are siblings at the runtime boundary and do not need separate product names.

## Problem Statement

RunWield currently provides an opinionated Plan-by-Default workflow through its own TUI, Workspace, Agent definitions,
and Pi-backed Session runtime. This delivers strong lifecycle and verification guarantees, but adopting a new harness is
a meaningful barrier for users and teams already working effectively in Claude Code, Codex, OpenCode, or Pi.

A prompt or Skill alone cannot provide RunWield's value. Instructions may encourage planning, but they do not own Plan
state, approval, worktree baselines, validation, merge-back, recovery, Work Records, or durable memory. Conversely,
running a hidden RunWield Agent behind a host slash command would preserve the host's interface but not the promise to
"keep your agent."

RunWield Connect therefore needs a cooperative boundary:

- the External Agent Host owns the conversation, model access, and all Agent reasoning;
- RunWield supplies role prompts, Skills, deterministic workflow gates, durable artifacts, review surfaces, validation,
  recovery, and memory;
- the user explicitly activates this cooperation for one request;
- ordinary host use remains unchanged when no Attached Workflow is active.

The integration must reuse RunWield's existing domain authorities rather than implement a second host-specific Plan
Lifecycle. It must also distinguish truthful product parity from enforcement capabilities that a particular host does
not expose.

## Target Users

RunWield Connect primarily serves:

- existing Claude Code users who want stronger planning, review, verification, recovery, and project memory without
  replacing Claude Code;
- existing Codex users with the same need after the Claude integration proves the shared contract;
- teams evaluating RunWield who want to begin within familiar tools before using Core directly or adopting Workspace;
- users who prefer to remain permanently on Connect and accept host-specific UX or enforcement limitations while keeping
  RunWield's verification semantics intact.

External Agent Host priority is:

1. Claude Code
2. Codex
3. OpenCode
4. Pi

This order is a product and distribution priority, not a judgment that later hosts have weaker extension APIs.

## Capability Requirements

These are agreed Connect product requirements, not evidence that each adapter has shipped. The release strategy below
sets Preview and stable acceptance. Core owns shared workflow behavior; Connect owns host activation, model ownership,
compatibility, privacy at the host boundary, and host-specific continuation.

- [Explicit per-request activation](#explicit-per-request-activation)
- [Host-owned reasoning](#host-owned-reasoning)
- [Shared Plan and verification outcomes](#shared-plan-and-verification-outcomes)
- [Isolated implementation](#isolated-implementation)
- [Artifact privacy and records](#artifact-privacy-and-records)
- [Lazy project setup and recovery](#lazy-project-setup-and-recovery)
- [Compatibility and honest availability](#compatibility-and-honest-availability)
- [First-class Connect use](#first-class-connect-use)

<a id="per-request-opt-in"></a>
<a id="installation-and-inactive-use"></a>
<a id="starting-an-attached-workflow-with-connect"></a>

### Explicit per-request activation

**Scope and maturity:** The Claude Code plugin delivers activation steps 1, 3, and 4 below and FEATURE Plan submission.
For local development, load `src/attached/claude/plugin` with `claude --plugin-dir` and start
`/runwield:request <request>`. `wld attached activate` identifies the Project root, binds one host request to one
Attached Workflow Record, and returns a pending Router action with current role instructions. `triage_report` hands a
FEATURE request to the Planner; `plan_written` gives the written Plan its ID and Triage front matter. The Plan stays in
draft and can be opened and run with `wld`. The operations are also MCP tools through `wld attached mcp`. The plugin
checks the role contract version. Review, execution, the install flow, and full host and Core preflight (step 2) remain
target scope.

**Requirement: Leave ordinary host work unchanged outside explicit activation.**

- Installing a RunWield Connect plugin must not alter ordinary External Agent Host behavior.
- A user explicitly starts one Attached Workflow for one User Request, conceptually through
  `/runwield:request <request>` or the closest host-native equivalent.
- RunWield prompts, restrictions, and lifecycle claims apply only within that Attached Workflow.
- The host returns to ordinary behavior after the workflow reaches an outcome.
- Existing RunWield closure and recovery choices govern an active workflow; Connect does not introduce a separate
  partially governed lifecycle.

The user installs the first-party RunWield Connect plugin through the External Agent Host's normal extension mechanism.
Installation must establish or obtain compatible local RunWield Core dependencies without requiring separate model
authentication. Executable hooks and local Core access must be disclosed through the host's normal trust and permission
experience.

After installation:

- normal host prompts behave exactly as they did before installation;
- RunWield does not inspect prompts, inject context, or block tools unless an Attached Workflow is active;
- RunWield-specific actions are discoverable through the host's normal command or Skill UI;
- uninstalling or disabling the adapter returns the host to its prior behavior without removing canonical project
  artifacts.

The primary experience is conceptually:

```text
/runwield:request <request>
```

The exact spelling may adapt to host command conventions. Activation should:

1. identify the current trusted Project root;
2. preflight the host and local Core capabilities required for the request;
3. establish the association between the host request and one Attached Workflow;
4. supply the appropriate RunWield Triage role and tools to the host model;
5. leave unrelated host sessions and future ordinary prompts untouched.

A user can explicitly initialize richer project context through a namespaced action such as:

```text
/runwield:init
```

Initialization is optional and may occur before or after the first Attached Workflow.

**Acceptance scenarios:**

- Given Connect installed but inactive, when the user sends an ordinary host prompt, RunWield does not inspect it,
  inject instructions, or restrict tools.
- When the user explicitly invokes RunWield for a trusted Project request, only that Attached Workflow becomes active;
  unrelated conversations and later ordinary prompts remain unaffected.
- When the user disables or uninstalls the adapter, ordinary host behavior returns and canonical project artifacts
  remain intact.

<a id="host-owned-model-execution"></a>

### Host-owned reasoning

**Scope and maturity:** Target for every Connect workflow.

**Requirement: Use the external host for every model call.**

- Every LLM call is made by the External Agent Host using the user's existing host model access.
- This includes Triage, planning, ideation, implementation, semantic review, repair, recording, and delegated worker
  calls.
- RunWield Connect does not require separate RunWield model credentials or a RunWield account.
- RunWield may inject its Agent prompts and Skills or ask the host to create isolated workers, but it must not silently
  substitute a RunWield-owned Agent Session.

**Acceptance scenarios:**

- Given a complete attached change, when planning, implementation, review, repairs, and recording run, every model call
  uses the host’s model access.
- When an isolated worker is needed, the adapter uses a host-owned worker or discloses the limitation; it does not
  substitute a hidden RunWield model session or ask for separate model credentials.

<a id="runwield-owned-workflow-truth"></a>
<a id="one-verification-meaning"></a>
<a id="shared-product-behavior"></a>
<a id="review-experience"></a>

### Shared Plan and verification outcomes

**Scope and maturity:** The Claude FEATURE Preview delivers Plan review, Feedback, approval, and readiness through
Plannotator and Core. Review decisions are durable before browser acknowledgment. Claude receives Feedback and image
paths through `status`, revises the Plan, and submits the next round into the same browser page. Cancellation returns to
Claude with a review-canceled note and leaves the workflow open. The Preview also implements the guarded execution
handoff, implementation checkpoint, and shared validation continuation below. Validation coordination has automated
coverage and live Claude Code verification of direct reviewer MCP access, fresh repair workers, independent
re-verification, restoration after MCP loss, and a CI call longer than five minutes. Code review and publication remain
target scope (child 06); Core owns their shared requirements.

**Requirement: Keep Core approval and verification authoritative.**

RunWield Core remains the sole authority for:

- canonical Plan files and Plan Lifecycle transitions;
- approval and readiness decisions;
- Plan Lifecycle authority and recovery evidence;
- execution baselines, worktree registration, merge-back, and cleanup decisions;
- Mechanical Validation and Workflow Validation outcomes;
- canonical Work Records and their provenance;
- project memory and derived search/index state.

The External Agent Host submits requests, structured outcomes, completion evidence, and review results. Host prose or a
host-local task state cannot independently make a Plan Ready For Work, Implemented, or Verified.

- A Verified Plan means the same thing in RunWield Connect and RunWield Core, regardless of Core Execution Backend.
- RunWield Connect must not introduce host-specific "verified-ish" Plan statuses.
- If a host cannot satisfy a required invariant, disclose the limitation and offer an explicit supported continuation or
  deliberate abandonment. An active delivery workflow does not end automatically with a non-verified failure.
- Host capability differences belong in a disclosed compatibility matrix rather than weaker durable truth.

The [Core capability requirements](runwield-core-prd.md#capability-requirements) owns the lasting requirements for Epic
decomposition, holding and resuming Plans, bounded semantic review and human review, frontend Pair execution, and Work
Records. Connect preserves their applicable user outcomes with host-appropriate controls and disclosed limitations. It
must not duplicate their policies or import TUI-specific theme, attachment-storage, or compaction implementation into
the external host. The host continues to own its conversation and model calls.

- Plannotator remains the rich Plan and code-review surface.
- Attached adapters should open or present the same review outcome rather than rebuild host-specific review products.
- Feedback and approval must return as structured workflow outcomes, not inferred from chat prose.
- The External Agent Host may summarize review progress, but RunWield remains the authority for the resulting lifecycle
  transition.

**Acceptance scenarios:**

- Given a host message claiming completion, when required checks or delivery evidence are missing, the Plan does not
  become Verified.
- When the user submits browser review feedback, Claude retrieves the durable Feedback and image paths, revises, and
  submits the next round into the same Plannotator page. Browser edits are saved once, not repeated by the Planner.
- Given an unchanged semantic Plan revision, approval records Core approval and readiness and leaves the Plan
  `ready_for_work`. A meaningful edit rejects a stale decision; formatting-only changes do not discard approval.
- Given process loss during review, `/runwield:plan-review` in a fresh Claude conversation restores the most recent open
  workflow. A pending round reopens; an applied outcome is retrieved without repeating transitions.
- When the user cancels or exits browser review, Claude receives a cancellation note. Closing a tab or losing the MCP
  process does not fabricate cancellation or abandon the workflow.
- When a host cannot satisfy a required verification condition, it exposes the limitation and a supported continuation
  or deliberate abandonment without weakening Verified or silently ending the workflow.

<a id="isolation-first-planned-execution"></a>

### Isolated implementation

**Scope and maturity:** The Claude FEATURE Preview implements approved execution handoff, durable non-Git consent,
worker recovery, and guarded implementation completion through Core. Automated real-Git and fresh-process tests cover
these coordination guarantees. Host-native worker dispatch is instructed by the plugin, not sandboxed. Live acceptance
on Claude Code 2.1.293 confirms automatic handoff after browser approval, coordinator-owned completion, and fresh-host
restoration of the same worker action and worktree. No wider host-version range is declared. Validation coordination now
has automated real-Git, fresh-process, and shared-engine coverage. Live Claude reviewer MCP access remains to be
confirmed. Publication remains later Preview scope (child 06). Other hosts, QUICK_FIX, and safe-handoff fallback beyond
non-Git consent remain targets.

**Requirement: Automatically hand approved work to its isolated implementer.**

- After approval and readiness, Claude immediately starts execution; no separate execution confirmation is required.
- Core prepares a RunWield-owned worktree, branch, baseline, and registered execution attempt through the same authority
  used by Core Sessions. Claude discloses the directory, branch, and RunWield-owned `.gitignore` block.
- The invoking checkout is preserved, including dirty and untracked user work, except that disclosed `.gitignore` block.
- The coordinating conversation dispatches a fresh host-native worker with the Plan path, execution directory, and
  current engineer or frontend-engineer instructions. All worker model calls belong to Claude. RunWield starts no model
  Session or execution backend.
- The worker uses the execution directory, not the invoking checkout. It returns a Markdown bullet report to the
  coordinator and makes no RunWield lifecycle calls. Role instructions are guidance, not a host tool sandbox.
- External hosts must not create competing worktree isolation. RunWield's registry owns the one-live-attempt invariant.

**Requirement: Obtain durable conversational consent for non-Git execution.**

- Without remembered Core consent, Claude asks the durable disclosure question in plain text. Proceeding edits current
  files directly and skips Git-only isolation and recovery. Core remembers explicit consent for planned Plan work.
- Declining leaves the Plan ready and the workflow open; Claude must not automatically restart or ask again.
- A Git handoff failure does not silently select in-place execution. Other fallback capabilities remain targets.

**Requirement: Accept only the issued structured implementation outcome.**

- The coordinating conversation submits `task_completed` with `actionId` and the Core bullet-point `message` report.
- Core checks workflow revision, action identity, live registry identity/path/branch, and the issued Plan identity and
  revision. A changed Plan body, missing worktree, stale action, or prose claim outside the operation cannot advance
  work.
- Shared Core finalization restores a deleted execution Plan from its recorded baseline, checkpoints implementation, and
  records `implemented`. Accepted operations replay without repeating effects.
- `implemented` means implementation is recorded, not validated, Verified, or published. The workflow stays open for
  validation and publication, under [Core recovery](runwield-core-prd.md#execution-validation-and-recovery).

**Requirement: Continue shared validation with fresh host-owned workers.**

- `start_validation` runs the shared Core attempt owner and validation engine without a Core Session or model turn. Core
  owns CI, semantic convergence, finding identities, recovery, and all gate predicates. These remain authoritative under
  [Core semantic review and repair](runwield-core-prd.md#semantic-review-and-repair).
- The Attached record persists each reviewer, repair, or user-decision request and its action identity. An outcome is
  saved before Core runs CI, outside the Attached record lock. A fresh process can restore the request or resume the
  saved outcome. Concurrent calls report that validation is running instead of starting competing host workers.
- A fresh Claude reviewer calls MCP `review_diff` directly. Core records returned byte ranges against that pending
  action. Listing does not count as inspection; host-supplied coverage is not accepted. The coordinating conversation
  submits the reviewer's structured outcome through `review_complete`. Core rejects incomplete coverage and stale
  candidates through its shared guards.
- A fresh repair worker receives the current focused repair instructions and existing execution checkout. It returns its
  per-item report; the coordinating conversation submits `task_completed`. A user-decision request is asked in Claude
  and returned through `validation_decision`, not guessed by the host.
- `/runwield:validate` restores this flow. An active MCP call sends progress every 30 seconds, stopping when it returns.
  The plugin sets a one-hour per-server timeout as a backup. Start Claude with `MCP_TOOL_TIMEOUT=600000` or a higher
  value suitable for the configured check (milliseconds).
- Passed validation stops at `reviewed` with `awaiting_delivery`. Publication is still a target in this Preview slice;
  validation does not claim Verified or close the workflow.

**Acceptance scenarios:**

- Given an approved ready Plan, Claude automatically starts execution, reports the isolation disclosure, and dispatches
  a fresh host worker with its role and Plan path. The invoking checkout stays intact except the managed ignore block.
- Given a non-Git project without remembered consent, a fresh conversation retrieves the same question. Proceed uses
  Core's consent memory and in-place preparation; decline makes no implementation handoff and does not trigger a
  restart.
- Given a returned worker report against the issued action and unchanged Plan, Core records implementation and a Git
  checkpoint. A repeated accepted operation advances nothing twice; changed authority rejects completion.
- Given a deleted execution Plan with a recorded baseline, Core restores it and completes through its shared guards.
- Given failing CI, Core issues a repair request. A fresh Claude repair worker fixes it and the coordinating
  conversation reports completion. Core reruns CI before issuing a fresh reviewer request.
- Given a reviewer that lists files but does not read every required diff byte, Core requests a correction instead of
  accepting approval. A stale action or changed candidate cannot advance review.
- Given a Core process lost during CI, another conversation reads status and resumes validation from durable claims. A
  live validation call does not block reading Attached status. Replaying an accepted completion repeats no effects.
- Given Core advances its checkpoint but the final Attached write is lost, retry reconciles the durable claim without
  reapplying the old outcome. Its original operation name and evidence remain available in the completion receipt.
- Given a final Attached write fails while the MCP process stays alive, the settled call releases its operation claim; a
  later validation call can recover without restarting that process.
- Given complete accepted review outcomes, the Plan reaches `reviewed` and Attached reports `awaiting_delivery`, never
  Verified. No publication effect runs at this boundary.
- Given worker or process loss, `/runwield:implement` restores the same directory, action, and current role
  instructions. A lost Attached write after preparation adopts the same Core attempt; a lost write after completion
  settles the result on retry. Proven settled preparation journals heal without a second live worktree.
- Given process loss before first Plan materialization or during completion settlement, retry uses
  [Core's shared preparation and completion authority](runwield-core-prd.md#execution-validation-and-recovery). A
  partial completion retains its issued action until Core saves the checkpoint and completes registry settlement.
- Given a Plan body edit while completion waits for Core's lock, the issued completion is rejected; it cannot accept a
  newer scope. Given Core archives the execution Plan, Attached status returns `plan_advanced_in_core`, not a worker
  handoff to a missing document.

<a id="structured-evidence-not-transcript-import"></a>

### Artifact privacy and records

**Scope and maturity:** Target for every Connect workflow; Core owns record semantics.

**Requirement: Record structured outcomes without importing host transcripts.**

- Ordinary host conversations remain completely outside RunWield.
- During an Attached Workflow, RunWield persists only the explicit request, structured workflow outcomes, canonical
  artifacts, review decisions, worktree evidence, validation evidence, and derived Work Records or Memories needed for
  the workflow.
- RunWield does not copy or index the raw External Agent Host conversation transcript.
- Raw host conversations remain private working space. Organizational knowledge continues to come from explicit durable
  artifacts and synthesis rather than chat-history ingestion.

Shared requirements: [Core Work records](runwield-core-prd.md#work-records) and
[capability-organized PRD authoring](runwield-core-prd.md#capability-organized-product-requirements). Attached planning
uses the same guidance within each user project’s own PRD structure.

**Acceptance scenarios:**

- When an attached change completes, eligible Work Records are synthesized from its explicit request, artifacts, and
  structured outcomes without importing the host transcript.
- Given ordinary host conversations outside RunWield, when project memory or record search runs, those conversations
  have not been passively ingested.

<a id="lazy-project-onboarding"></a>
<a id="local-on-demand-core"></a>
<a id="recovery-experience"></a>

### Lazy project setup and recovery

**Scope and maturity:** The Preview uses short Core operations for activation, Triage, planning, durable browser review,
and execution handoff. Activation and Triage write nothing to the repository. Plan submission previews required runtime
and ignore setup; execution discloses its worktree and branch. Fresh processes restore review decisions, consent
questions, implementation actions, and accepted results. No always-running service is required. Validation and
publication recovery remain later Preview scope, with Core requirements authoritative.

**Requirement: Start with necessary setup and preserve work after interruption.**

- A user must be able to run the first Attached Workflow in an uninitialized trusted repository.
- Full `wld init` is not an entrance requirement.
- RunWield creates only the artifacts required by the invoked workflow and clearly previews material repo-local changes.
- Richer context and memory seeding remain available through a namespaced host action such as `/runwield:init`.
- Supporting actions may be namespaced under RunWield, but internal lifecycle transitions must not become a cluttered
  command suite.

- The first Connect release does not require an always-running daemon or Session Host.
- The host adapter may invoke local RunWield Core capabilities on demand.
- Saved Plans, work, review outcomes, and recovery evidence must allow useful continuation or explicit retry after
  process loss.
- A persistent local service may be added later for performance or cross-client continuity, but it is not part of the
  acquisition prerequisite.

- Process loss must preserve Plans, implementation work, completed results, and useful recovery evidence.
- RunWield must distinguish safe continuation from uncertain external side effects.
- Recovery first reconciles partial effects from available evidence. RunWield automatically repairs its own locks,
  settings, storage, and Plan synchronization without asking users to operate that machinery. Only a remaining external
  prerequisite or consequential user choice requires input; uncertain external effects are never blindly repeated.
- Connect follows [Core execution and recovery](runwield-core-prd.md#execution-validation-and-recovery): publication or
  deliberate user abandonment are the only delivery conclusions. Host turn cancellation and retry limits preserve the
  workflow for continuation.
- RunWield Connect does not promise exact continuation at an interrupted token or exactly-once replay of arbitrary host
  tool calls.

**Acceptance scenarios:**

- Given a trusted uninitialized repository, when the user starts their first attached change, full `wld init` is
  optional and material required repository changes are previewed.
- When host or Core processes stop, saved Plans and work remain available for useful continuation or explicit retry.
  `/runwield:plan-review` restores browser review; `/runwield:implement` restores the execution handoff described in
  [Isolated implementation](#isolated-implementation), including the same registered worktree after worker loss.
- When an interrupted command may already have changed external state, recovery reconciles available evidence and asks
  for a user decision only if external uncertainty remains; it never blindly replays the command.

<a id="host-compatibility"></a>
<a id="product-constraints-and-compatibility"></a>
<a id="documentation-and-positioning"></a>

### Compatibility and honest availability

**Scope and maturity:** Target, assessed separately for each supported host/version.

**Requirement: Disclose tested host support and limitations.**

Each integration uses the host's reliable capabilities to deliver the same RunWield behavior. Unsupported actions and
weaker guarantees must be disclosed before users depend on them. A host's API list alone is not evidence that a RunWield
journey works there.

Connect keeps the external host responsible for every model call while RunWield supplies consistent planning,
validation, recovery, and records. ACP serves a different journey: an external client talks to a RunWield-executed
Session. Users must understand which mode they are choosing.

Before starting work, disclose whether the host can:

- run isolated implementation and independent review;
- use the required tools and review interactions;
- cancel and recover work reliably;
- install, update, disable, and remove the integration cleanly.

Role boundaries during an Attached Workflow come from RunWield's role instructions, as they do in Core. For example, the
Planner is told to write only Plan files; neither Core nor Connect blocks its other tools. Do not describe these
instructions as a hard restriction, and do not claim independent verification when review lacks independence. Preserve
the user's host permissions. A model's claim of completion cannot replace actual validation and delivery evidence.

Maintain tested host-version ranges and clear Preview or stable labels. Architecture and implementation Plans choose
transports, role dispatch, tool contracts, and host-specific hooks; this PRD defines the outcomes those choices support.

- The README must position RunWield as the planning, verification, and organizational-memory layer for AI software
  development and explain Connect, Core, and Workspace together.
- RunWield Connect must appear as a distinct plugin ecosystem, with current Preview or stable availability shown per
  External Agent Host.
- Host-specific guides must cover installation, `/runwield:request` activation, optional `/runwield:init`, review,
  permissions, local artifacts, privacy boundaries, recovery, updates, disablement, and uninstall.
- Documentation must distinguish available adapters from planned targets and must not imply parity based only on a
  host's listed APIs.
- Core and Workspace comparisons may explain genuine workflow, integration, and collaboration advantages without
  suggesting that Connect is an intentionally incomplete trial.

**Acceptance scenarios:**

- When a user chooses an adapter, its guide shows tested versions, Preview/stable availability, permission requirements,
  and unsupported interactions before they depend on them.
- When compatibility is presented, role instructions such as the Planner's Plan-only writes are not described as hard
  enforcement, and a host that cannot run independent review is not presented as providing it.
- When the user compares Connect with Core execution backends or ACP clients, documentation identifies who owns the
  conversation and makes model calls.

<a id="first-class-product-organic-conversion"></a>

### First-class Connect use

**Scope and maturity:** Lasting product commitment; delivery follows the adapter stages below.

**Requirement: Support users who choose to remain in their external host.**

- RunWield Connect is a supported destination for users who never adopt another RunWield surface.
- Connect journeys stay in the External Agent Host and its browser review surface. They must not require users to
  operate the `wld` CLI or TUI. The Claude Preview restores review through `/runwield:plan-review` and host tools.
- Primary product outcomes are successful verified work, retained use, and trustworthy recovery.
- Movement to direct Core use or Workspace is a secondary organic outcome.
- Product-family messaging may explain genuine integration and collaboration advantages but must not reserve feasible
  Connect capabilities solely to manufacture conversion pressure.

**Acceptance scenarios:**

- Given a user who stays permanently in their external host, when an applicable workflow is supported, they receive its
  full feasible behavior without being forced into Workspace or direct Core use.
- When adoption is evaluated, successful verified work, recovery, and retained use matter directly; conversion is not
  manufactured by removing feasible features.

## End-to-End Preview Acceptance Journey

The Claude Code Preview is complete only when a user can perform this bounded end-to-end journey:

1. Install the first-party Claude Code adapter and compatible local Core dependencies through one documented onboarding
   flow.
2. Start from a trusted but otherwise uninitialized Git repository.
3. Invoke RunWield for a FEATURE-sized User Request in an existing Claude Code conversation.
4. Have Claude perform RunWield Triage and plan under the RunWield Planner instructions.
5. Have Claude produce a canonical RunWield Plan and submit it through Core-owned lifecycle operations.
6. Receive Plannotator Feedback, revise the Plan in the same user-facing flow, and resubmit it.
7. Approve the Plan through Plannotator and pass the normal Readiness Gate.
8. Create or reuse a RunWield-owned execution worktree and capture the execution baseline.
9. Have a Claude-hosted implementation worker complete the approved Plan in the worktree.
10. Run the configured local validation command and independent Claude-hosted Semantic Code Review.
11. Return blocking Review Issues to a Claude-hosted repair worker and independently re-verify repairs under the normal
    bounded convergence policy.
12. Complete optional human review when configured.
13. Merge validated work back through RunWield's existing worktree safeguards and record the Plan as Verified only after
    merge-back succeeds.
14. Generate the canonical Work Record and eligible memory outcome without importing the Claude transcript.
15. Cancel, restart, or lose either host or Core processes at supported boundaries and recover or retry without blind
    replay or silent lifecycle corruption.
16. Continue using the same Claude Code installation normally for requests that do not invoke RunWield.

## Release Strategy

### Stage 1: RunWield Connect for Claude Code FEATURE Preview

Ship an explicitly labeled Preview after the complete FEATURE journey succeeds end to end. The Preview must include
truthful capability documentation and must not imply full Routing Intent parity.

Lighter Routing Intents may be included when they satisfy their normal semantics, but breadth must not delay proving the
FEATURE lifecycle.

### Stage 2: Stable RunWield Connect for Claude Code

RunWield Connect for Claude Code becomes stable only when:

- every canonical Routing Intent is supported or explicitly proven irrelevant to Connect;
- lifecycle, review, isolation, validation, recovery, Work Record, and memory behavior meet the shared RunWield
  semantics;
- supported Claude Code versions pass repeatable black-box integration coverage;
- upgrade, disable, uninstall, and stale-workflow recovery behavior are documented and tested.

### Stage 3: Additional External Agent Hosts

Add adapters sequentially:

1. Codex
2. OpenCode
3. Pi

Each adapter begins with a capability-disclosed Preview and reaches stable status only after meeting the same applicable
product semantics. Later adapters must reuse the host-neutral Core contract rather than copy the Claude implementation.

## Success Criteria

### Preview Acceptance

- A user can install RunWield Connect for Claude Code without configuring a second model provider or RunWield account.
- A normal Claude Code request made after installation but outside `/runwield:request` receives no RunWield prompt
  injection, restriction, or workflow state.
- A first `/runwield:request` FEATURE request works in an uninitialized trusted Git repository.
- No LLM call in the journey is made outside Claude Code.
- Plan review and Feedback use canonical RunWield artifacts and Plannotator.
- Implementation occurs in a RunWield-owned worktree and does not begin before approval and readiness.
- Workflow Validation uses the normal configured CI, semantic review, repair, optional human review, and merge-back
  semantics.
- The Plan becomes Verified only after all existing verification requirements pass.
- A Work Record is produced from structured evidence without copying the Claude transcript.
- At least one interrupted planning/review wait and one interrupted execution/validation boundary recover or require
  explicit retry safely in black-box tests.
- Disabling the Connect plugin leaves canonical Plans, Work Records, and recovery evidence intact while restoring
  ordinary host behavior.

### Stable Product Outcomes

Measure:

- successful installation and capability preflight rate;
- first Attached Workflow activation rate;
- time from installation to first reviewed Plan and first Verified Plan;
- Attached Workflow completion, failure, cancellation, and recovery rates;
- percentage of planned workflows that preserve worktree isolation;
- validation and semantic-review convergence outcomes;
- retained Connect use across Projects and time;
- frequency and cause of host-capability fallbacks;
- voluntary adoption of direct Core use or Workspace as a secondary metric.

Metrics must be privacy-safe and must not contain raw prompts, host transcripts, source content, secrets, or sensitive
paths. Adoption of other RunWield surfaces must not be optimized by reducing Connect capability.

## Risks and Mitigations

### Host API Churn

Plugin, hook, permission, worker, and worktree APIs may change independently. Maintain pinned compatibility ranges,
black-box adapter tests, explicit Preview labels, and fast-failing preflight diagnostics.

### False Enforcement Claims

Role boundaries are instructions, not sandboxes, in Connect as in Core. Do not describe them as enforcement. The
guarantees that matter are enforced where RunWield owns the fact: Plan Lifecycle guards, approval and readiness,
RunWield-owned worktrees, validation evidence, and merge safeguards.

### Split-Brain Workflow State

The host and Core may both appear to track plans or completion. Core must remain the sole Plan Lifecycle authority.
Users must see the current Plan and outcome consistently, and approval must apply to the version actually reviewed.

### Untrusted Host Assertions

A model may claim it planned, completed, repaired, or reviewed work without sufficient evidence. Core must validate
artifacts, lifecycle state, diffs, CI results, review-result consistency, and merge outcomes before recording durable
transitions.

### Worktree Handoff Failure

The parent host conversation may not be able to move safely into a RunWield worktree. Prefer host-native isolated
workers and tested worktree hooks. Use explicit in-place consent only when supported by existing Core semantics and
disclose the recovery trade-off.

### Permission and Trust Friction

Adapters contain executable local code. Use host-native install and trust review, disclose local Core access, keep hooks
inert outside Attached Workflows, never auto-loosen host permissions, and make disable/uninstall behavior clear.

### Workflow Deadlock

A host turn, browser review, local Core process, or worker may wait indefinitely for another surface. Show what is
waiting and why, support cancellation, and offer recovery when an interaction is interrupted without assuming uncertain
actions completed.

### Host Quota and Cost

Independent planning, implementation, review, repair, and recording roles consume the user's host quota. Use context
parsimony, bounded retries, and clear progress reporting. Do not hide the fact that stronger verification may require
multiple host model calls.

### Product and Control-Direction Confusion

Users may interpret Connect as RunWield secretly taking over Claude Code, as a weaker verification tier, or as the same
thing as Core invoking Claude as an Execution Backend. Documentation must consistently explain who makes model calls,
when RunWield is active, which system owns workflow truth, and why direct Core use or Workspace may offer a smoother
experience without changing Verified semantics.

## External Feasibility Evidence

The following research references informed the product direction. They are feasibility evidence, not a fresh
host-version compatibility audit:

- [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks-guide) can inject context, block tool use,
  continue stopped turns, participate in permission decisions, and package through plugins or active Skills. Hook
  denials can tighten policy even under permissive host modes.
- [Claude Code Skills](https://docs.anthropic.com/en/docs/skills),
  [plugins](https://docs.anthropic.com/en/docs/plugins), and [subagents](https://docs.anthropic.com/en/docs/sub-agents)
  provide first-party distribution and host-owned role or worker surfaces.
- [Codex customization](https://developers.openai.com/codex/customization/overview) supports Skills, plugins, MCP, and
  subagents. [Codex hooks](https://developers.openai.com/codex/hooks) can inject context and intercept many local tools,
  but official documentation warns that specialized paths may not use the default hook path.
- [OpenCode plugins](https://opencode.ai/docs/plugins/) provide event hooks, custom tools, SDK access, and npm or local
  distribution.
- [Pi extensions](https://pi.dev/docs/latest/extensions) and [Pi packages](https://pi.dev/docs/latest/packages) provide
  broad command, tool, event, UI, and package extension surfaces.

These are feasibility facts, not a guarantee of parity. Every supported host/version combination still requires tested
capability evidence.

## Out of Scope

- Replacing the External Agent Host's model, authentication, billing, or ordinary conversation experience.
- Running RunWield-owned LLM calls during an Attached Workflow.
- Passive inspection or governance of host requests that do not explicitly invoke RunWield.
- Importing raw Claude Code, Codex, OpenCode, or Pi conversation transcripts.
- Creating a weaker Attached-specific Plan Lifecycle or verification status.
- Rebuilding Plannotator review interactions independently inside every host.
- Requiring an always-running daemon or Session Host for the first release.
- Promising exactly-once replay of arbitrary interrupted host commands, model turns, or filesystem side effects.
- Tamper-proof enterprise enforcement when users or administrators can disable the adapter or its hooks.
- Shipping shallow simultaneous adapters for all External Agent Hosts before the Claude FEATURE vertical slice works.
- Withholding otherwise feasible Connect capabilities solely to encourage direct Core or Workspace adoption.
- Replacing External Work Sources or adding ticket lifecycle synchronization.

## Open Questions

- Which host versions can support the first complete journey, and what limitations need to be disclosed?
- What installation and update experience best fits each host while keeping compatible local Core dependencies easy to
  manage?

Transport, internal workflow contracts, and worker coordination belong in architecture and implementation planning.
