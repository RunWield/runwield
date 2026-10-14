# RunWield Domain Language

RunWield is collaborative software planning with AI. Its product family combines a local plan-by-default coding harness,
plugins for external agent hosts, and a collaborative SaaS Workspace. This glossary defines the project language used by
agents, docs, plans, and code. Entries cover RunWield-specific concepts, named tools and surfaces, and familiar words
whose meaning here needs disambiguation. Ordinary software terms need no separate entry unless RunWield gives them a
more specific meaning.

## Language

### Product and Runtime

**RunWield**: The umbrella product and public brand for collaborative software planning with AI. Its product family
includes RunWield Core, RunWield Connect, and RunWield Workspace. _Avoid_: RunWield Core when referring only to the
umbrella, Wield AI

**RunWield Core**: The free local plan-by-default coding harness and runtime, operated through the `wld` CLI and its
local interfaces. Core owns local workflow truth and may execute Agent turns through Pi or another Execution Backend.
_Avoid_: `wld` as a product name, Native Mode, Managed Mode

**RunWield Workspace**: The collaborative SaaS product for planning and records across Projects. _Avoid_: RunWield when
a distinction from Core or Connect is required, local Workspace UI

**External Agent Host**: A coding-agent product such as Claude Code, Codex, OpenCode, or Pi that owns the user
conversation and model access for an Attached Workflow. _Avoid_: Provider, Session Host, host harness

**RunWield Connect**: The public product name for RunWield's plugin ecosystem for External Agent Hosts, beginning with
first-party plugins. A Connect plugin lets users explicitly invoke RunWield workflows inside an External Agent Host
while that host retains the conversation and makes every model call. _Avoid_: Plugin mode, always-on RunWield, trial
mode

**Attached Mode**: The internal architecture underlying RunWield Connect, in which an External Agent Host makes every
model call and users invoke RunWield explicitly for individual user requests. Use RunWield Connect in customer-facing
product language. _Avoid_: Public product name, RunWield Execution Backend

**Attached Workflow**: The per-request RunWield workflow active inside an External Agent Host through RunWield Connect,
with RunWield governing durable workflow truth while the host performs agent reasoning and execution. _Avoid_: Attached
Mode, Managed Mode, RunWield Session

**Attached Workflow Coordinator**: The Core runtime that advances Attached Workflows through short `wld attached`
operations. It is a sibling of `SessionRuntime`: it loads the Attached Workflow Record, checks it, makes at most one
change, saves, and exits. It never creates a Session, calls a model, or stores a host transcript. _Avoid_: Attached
adapter, attached Session, host bridge

**Attached Workflow Record**: The durable file that holds one Attached Workflow's state, revision, pending host action,
accepted operation results, and binding evidence. It lives under `~/.wld/attached/`, keyed by the primary checkout root.
It references its Plan but does not own it. The same Plan can be opened and run with `wld`. _Avoid_: Attached Session,
host transcript, controller record

**Attached Review Round**: The durable pending-review identity on an Attached Workflow Record: round, action ID, actual
reviewed Plan revision, and waiting reason. It keeps a browser decision and its outcome recoverable across process loss.
Core Plan review remains the authority for approval, Feedback, and readiness. _Avoid_: review promise, session-scoped
review

**Attached Execution Handoff**: The durable handoff of a Core-prepared execution directory, Plan path, issued action,
and current implementer role instructions to an External Agent Host worker. The Attached Workflow Record references
RunWield's registry and baseline evidence; it does not own a second worktree lifecycle. The host worker returns a bullet
report to the coordinating conversation, which submits Core's `task_completed` contract. With remembered non-Git
consent, the directory is the current checkout rather than a worktree. _Avoid_: worker session, host worktree

**Attached Role Instructions**: The effective layered agent instructions Core returns with a pending host action. They
are resolved for each response from project, home, and bundled definitions and are not saved in the Attached Workflow
Record. _Avoid_: generated Skill, role contract copy

**Headless Mode**: The non-interactive RunWield execution surface that emits machine-readable Agent Session events for
external hosts. _Avoid_: TUI mode, batch wrapper, remote UI

**Agent Client Protocol (ACP)**: The editor-oriented JSON-RPC protocol RunWield implements for IDEs and external hosts.
_Avoid_: Agent Control Protocol, Agent Communication Protocol

**Terminal Auth**: An ACP Client-launched setup process that opens `wld login` in a terminal so the user can configure
model-provider credentials and choose a default model before the Client reconnects to `wld acp`. Credentials stay in
`~/.wld/auth.json`; Terminal Auth is not Agent Auth, does not use ACP `authenticate`, and does not move the coding
Session into the terminal. _Avoid_: Slash Login, ACP token exchange, provider login session

**Session Host**: The non-TUI runtime boundary that owns one or more live RunWield Sessions and exposes them to external
clients. _Avoid_: TUI backend, daemon, adapter

**Session**: A durable user-facing conversation and workflow thread within one Project. A Session has its own history
and Session Name, persists across Agent handoffs, contains one or more ordered Session Transcript Segments, and may
contain multiple Agent Sessions. RunWield catalogs every local Session automatically; Workspace Project registration is
a separate access decision. _Avoid_: Managed Session, unmanaged Session, Agent Session, HostedSession, Task, Work Item

**Archived Session**: A Session with durable, reversible archive state in its file-authoritative Session Manifest.
Ordinary Session history and TUI resume omit it, but its stable ID, Session Transcript Segments, Plan Associations, and
workflow remain intact. Associated Plans retain its link and archived status. Workspace Project settings > Archived
Sessions offers Unarchive; opening a direct link or continuing work does not silently unarchive it. ACP `session/delete`
archives; `session/close` only releases live resources. _Avoid_: Deleted transcript, completed Plan, closed workflow,
closed ACP Session

**Session Transcript**: The private raw message and event history of one Session. Its owner may resume or search it, but
it is not shared project knowledge or a source for cross-Session Agent retrieval. Pi persists completed tool calls and
interaction results as committed transcript history; a live unanswered interaction is not committed history until its
result is written. _Avoid_: Work Record, planning memory, shared conversation

**Execution Backend**: The model-selected runtime that executes one RunWield Agent turn, such as Pi AgentSession, Claude
CLI, or Antigravity CLI. It is distinct from a model provider and from an Agent Session object. Changing Execution
Backend does not transfer Session Transcript, Workflow Tool Event, Plan Lifecycle, or replay authority away from
RunWield.

**Session Transcript Segment**: An ordered durable portion of a Session Transcript that supplies one isolated
model-history context while remaining part of the Session's continuous user-visible history. _Avoid_: Sub-session, new
Session, Agent Session, JSONL file

**Session Transcript Segment Rollover**: The locked mutation that seals the current Session Transcript Segment, creates
its successor, moves the activation segment pointer, and publishes the successor's committed generation indivisibly. No
Aggregate Transcript Projection should observe a successor segment that no committed generation names. _Avoid_: Segment
switch, transcript swap, context reset

**Orphan Rollover Candidate**: A successor transcript file that carries Session Transcript Segment lineage but is not in
the committed Session manifest because the process stopped before rollover committed. It is invisible to readers and
discardable only while it contains no entries beyond its header, lineage marker, and continuation marker. _Avoid_:
Partial segment, dangling Session, recovery segment

**Session Writer Lock**: The exclusive operating-system file lock that permits one RunWield process to mutate a Session.
Core releases it when the active managed operation settles; the operating system also releases it on process exit. An
idle open TUI or browser does not retain it merely by remaining open. _Avoid_: Session lease, heartbeat takeover,
database lock

**Session Control**: The right of one attached client to submit user messages or answer process-local pending
interactions for a live Session; observation does not require control. Session Control is not mutation authority without
the Session Writer Lock. _Avoid_: Plan ownership, Session ownership, Agent ownership

**Session Manifest**: The atomic JSON record beside a Session's Pi transcripts that stores stable identity, ordered
segments, committed generation evidence, current writer state, and reversible archive state. Transcript-adjacent
recovery descriptors and Pi lineage can rebuild it without a Workspace database. It may carry projections of committed
transcript evidence, but the transcript remains the authority. _Avoid_: Session database, Workspace catalog authority

**Plan Association**: Append-only Session evidence that records that one Session worked on one Plan for one Association
Purpose. It uses the Plan's durable `planId`, the Plan name at the time of recording, and the current Session Transcript
Segment. RunWield writes it under the Session Writer Lock, and a Session generation commits it. The Session manifest
carries a read cache of committed Plan Associations, but the transcript entry is the authority. A Plan can have Plan
Associations in more than one Session, and a Session can have Plan Associations for more than one Plan. _Avoid_: Plan
owner Session, Session owner, planName link

**Association Purpose**: The reason a Plan Association was recorded: `planning`, `review`, `execution`, or `recovery`.
Only `planning` and `review` on an idle planning segment can make a Session a safe planning resume candidate. _Avoid_:
Plan status, Session status, ownership reason

**Session Name**: The persisted short human label for a Session, initially derived from Router Triage for fresh user
requests. It is distinct from the terminal window or tab title. _Avoid_: Tab title, conversation name

**Remote SSH connection**: A connected-only Core interaction started with `wld remote` for an existing directory on a
remote Linux host. The current connection prepares a matching runtime, mounts laptop personal files on the approved
Linux `sct` pilot, and opens a dormant remote TUI. An optional bounded native Pi bridge proof is not an ordinary user
turn; the normal connection does not create or resume a saved Session. Guarded Session history and remote project
workflows remain target behavior. _Avoid_: Personal Workspace, unattended worker, remote Session type

**Remote personal mount**: A connection-owned SSHFS view of the laptop’s full `~/.wld` at a fresh private remote path.
Personal file edits through it change laptop files directly, not a copied resource tree. The remote project’s `.wld`
stays on the server. The path is private for normal use, but standard SFTP permits broad laptop-account access by the
trusted remote host; this is not a sandbox. This mount is not the guarded operation-scoped Session writer mount. Direct
bidirectional Skill file access was verified on the approved Linux `sct` pilot before the connection-only view. This
does not qualify other hosts or saved Sessions. _Avoid_: Resource sync, copied profile, confined mount

**Project Runtime State**: Machine-owned RunWield state inside a Project checkout. The current reserved root is
`.wld/internal/`. User-derived `.wld/settings.json`, `.wld/agents/`, `.wld/skills/`, and `.wld/prompts/` are not Project
Runtime State. A Remote SSH connection can identify a remote checkout but does not enter or create its Project Runtime
State; future remote project work would keep that state with the remote checkout. _Avoid_: project settings, project
config, all of `.wld/`

**Project Runtime Entry**: The shared migration-or-verification operation that runs before normal Project Runtime State
access. It can adopt eligible legacy state, confirm the selected and primary checkout layout, or refuse access with a
retryable reason and safe paths. It is not Session activation, path resolution, Workspace registration, or a
command-only check. Doctor inspection can report pending adoption without performing Project Runtime Entry. _Avoid_:
startup, activation, registration, path getter

**Project Internal Root**: The `.wld/internal/` directory in the checkout that owns a Project Runtime State item. It is
a path contract only; it does not mean migration or writer cutover is complete. _Avoid_: `.wld`, runtime directory when
the selected or primary checkout matters

**Primary-Checkout Runtime State**: Project Runtime State shared through the primary checkout. It includes controller
Plan records, the worktree registry and its lock, registry migration reports, publication staging, the project
collaboration secret store at `.wld/internal/collaboration-secrets.json`, and the no-home fallback worktrees root. The
home-directory collaboration secret store stays under `~/.wld/` and is not Project Runtime State. _Avoid_: global
runtime state, selected-checkout locks

**Selected-Checkout Runtime State**: Project Runtime State owned by the selected checkout. It includes Plan locks, the
Plan catalog lock, transition journals, and Work Record supersession locks. _Avoid_: primary runtime state, shared
registry state

### Triage & Classification

**Triage**: Structured classification of a user request by workflow type and complexity, usually performed by the
Router.

**Triage Report**: The structured output of Triage containing routing intent, complexity, summary, and an optional
auto-generated Session Name. _Avoid_: Triage result, classification result

**Workflow Tool Event**: A RunWield-owned, typed, consume-once event published only after an accepted workflow Custom
Tool call. It carries the tool-call ID, owner, turn, workflow attempt or validation generation, semantic payload, and
accepted time. Workflow owners claim it once and settle it after a safe lifecycle or validation checkpoint. A Session
Transcript can show the same tool result for users, but it cannot route, approve, validate, or complete workflow state.

**Diagnostic Triage**: Read-only Triage for user-reported broken behavior that gathers enough evidence to estimate
likely blast radius without reproducing, instrumenting, or fixing the issue. _Avoid_: Diagnosis, debugging,
mini-debugger

**Routing Intent**: The Triage field selecting the workflow and Agent: `INQUIRY`, `IDEATION`, `OPERATION`, `QUICK_FIX`,
`PLANNED_CHANGE`, or `PROJECT`; legacy `FEATURE` normalizes to `PLANNED_CHANGE`. _Avoid_: Classification, route type,
request kind, category

**INQUIRY**: The fallback Routing Intent for non-materializing understanding work such as questions about repository
state, architecture, Plans, history, trade-offs, or casual discussion. _Avoid_: Question, investigation, research task

**IDEATION**: A Routing Intent for non-materializing product exploration where the user wants Socratic interviewing,
assumption stress-testing, current research, or PRD synthesis. _Avoid_: Inquiry, general help, planning workflow

**OPERATION**: A Routing Intent for direct repository or environment operations that do not require code implementation.
_Avoid_: QUICK_FIX, feature, coding task

**QUICK_FIX**: A Routing Intent for a bounded code implementation with no planning phase and no Plan file. _Avoid_:
Operational, hotfix, patch, feature

**PLANNED_CHANGE**: The Routing Intent and executable Plan Classification for material code work requiring a reviewed
Plan, independent of Work Kind. _Avoid_: FEATURE when referring to workflow, planned feature

**Work Kind**: The Plan front matter field describing requested work as `BUG_FIX`, `FEATURE`, `REFACTOR`, `MAINTENANCE`,
or `DOCUMENTATION`, independently from Plan Classification. `BUG_FIX` means restoring intended behavior; `FEATURE` means
adding or enhancing functionality. Neither determines whether work needs a Plan. _Avoid_: Routing Intent, Plan
Classification

**DOCUMENTATION Work Kind**: A Work Kind for planned executable work whose primary outcome is documentation creation or
substantial documentation updates. Use only after `PLANNED_CHANGE` routing has been selected; documentation questions
remain `INQUIRY`, direct repository/doc operations remain `OPERATION`, and bounded typo-level documentation edits can
remain `QUICK_FIX`. _Avoid_: INQUIRY, OPERATION, QUICK_FIX, Routing Intent

**Legacy FEATURE Classification**: The old Routing Intent and Plan Classification value that means PLANNED_CHANGE rather
than necessarily new functionality. _Avoid_: Enhancement, new feature

**PROJECT**: The Routing Intent for architectural planning, and the non-executable container Plan Classification.
`type: epic` (the default when absent) uses Architect and Slicer; `type: sequence` contains complete Planner-authored
child Plans reviewed together. _Avoid_: Initiative, refactor, task DAG

**Complexity**: A `LOW`, `MEDIUM`, or `HIGH` rating assigned during Triage. _Avoid_: Difficulty, effort, severity

**Affected Paths**: The ordered set of files a Plan's front matter lists as expected to change for that Plan.

**Vertical Slice**: A narrow, end-to-end trace through the codebase from entry point to boundary for one request.
_Avoid_: Cross-section, code path

### External Work Sources

**External Work Source**: A non-RunWield system that owns demand management for requested work. _Avoid_: RunWield
tracker, Plan store, execution system

**Ticket**: A demand-management item in an External Work Source that may relate to zero or more Plans without
participating in Plan Lifecycle. _Avoid_: Plan, user request, Task

**Ticket Reference**: A structured relation on a Plan or Work Record whose required URL links to a related Ticket
without synchronizing content, state, or lifecycle. _Avoid_: Ticket copy, status mapping, external Plan

### Forge Delivery

**Forge**: A repository collaboration system such as GitHub or GitLab that governs branch publication, code review,
repository policy, and remote merge outcomes. _Avoid_: External Work Source, Ticket system, RunWield lifecycle owner

**Forge Change Request**: A provider-owned proposal to merge a published branch into a target branch, called a pull
request by GitHub and a merge request by GitLab. _Avoid_: FEATURE, Plan, Ticket, change request

**Repository Participation Declaration**: An upstream-authored, version-controlled policy that explicitly permits
contributed RunWield artifacts. _Avoid_: RunWield installation detection, inferred consent, contributor preference

**Release Candidate**: A prerelease build for one product version, identified by an `-rc.N` release tag and used to
validate that version before Stable publication. It is not a Publication Candidate from Planned Change delivery.
_Avoid_: Publication Candidate, Stable release

**Release Branch**: The version-specific Git branch used to stabilize a new RunWield release series after RC1. Later
Release Candidates use its pushed tip so unrelated work on `main` does not enter the series. Review limits it to release
fixes, and fixes are explicitly forward-ported to `main`. _Avoid_: Feature branch, Stable channel, Publication Candidate

**Publication Candidate**: The exact locally validated revision RunWield intends to publish through a Forge Change
Request. _Avoid_: Release Candidate, Execution worktree, unvalidated branch, implementation draft

**Change Request Finalization**: The post-merge RunWield action that proves Forge delivery and records terminal Plan and
Work Record evidence in the canonical repository. _Avoid_: Forge merge, contributor synchronization, local-only status

**Direct Delivery**: The default delivery mode that assembles validated commits with the latest target branch outside
the user's checkout, publishes the exact result to that target, and verifies it without a Forge Change Request. _Avoid_:
Local review, unreviewed delivery

**Change Request Delivery**: An explicitly selected delivery mode that verifies the canonical Plan only after a proven
Forge merge of the validated Publication Candidate. _Avoid_: PR mode, remote merge-back, Direct Delivery

**Dual Review**: A Change Request Delivery policy that requires both RunWield Code Review and review on the Forge Change
Request. _Avoid_: Semantic Review, duplicate review

### Plans & Review

**Tutorial**: Optional TUI guidance around one small real Planned Change. It explains normal Plan Review, approved
execution, Workflow Validation, and delivery as their real events occur. It is not Init, a separate Plan lifecycle, a
sample project, or a substitute for validation. _Avoid_: Onboarding workflow, training Plan, Workspace tutorial

**Plan**: A markdown file in `docs/plans/` describing the implementation strategy for a user request. Its YAML front
matter records classification, complexity, status, timestamps, and origin. _Avoid_: Blueprint, spec, design doc

**Work Record**: A small repo-local markdown retrospective planning-memory artifact that distills what completed planned
work actually produced and what future planning should remember. _Avoid_: Review log, chat transcript, implementation
diary, duplicate Plan

**Draft Work Record**: An external, manual, or imported Work Record awaiting human review before default search and
Agent retrieval. _Avoid_: Approved record, generated internal record, memory

**Pending Verification Work Record**: An internal Work Record generated before a terminal Plan outcome and excluded from
default search or Agent retrieval until then. _Avoid_: Draft Work Record, approved record, review guide

**Superseded Work Record**: A Work Record whose planning guidance has been replaced by a confirmed successor Work
Record. The successor must exist, and the supersession relation must be confirmed. A pending Supersession Proposal does
not make the earlier record superseded. _Avoid_: Archived record, deleted record, draft record

**Supersession Proposal**: A Recorder-proposed relation in a successor Work Record's `supersessionProposal` front matter
that requires a separate user decision for each proposed predecessor. While pending, it has no effect on default search
or Agent retrieval. _Avoid_: Superseded Work Record, automatic replacement, confirmed supersession

**Archived Work Record**: A Work Record hidden from default human search and Agent retrieval while remaining available
by explicit request. _Avoid_: Superseded record, deleted record, draft record

**External Work Record**: A Work Record imported or manually created for work performed outside RunWield or recovered
after the original Plan was lost. _Avoid_: Draft record, ad hoc note, memory

**Work Record Provenance**: Source evidence for a Work Record, including source Plans when available and stable
file-level code evidence when constructed from existing code. _Avoid_: Line references, raw diff log, chat evidence

**Plan Classification**: The Plan front matter workflow shape, limited to `PLANNED_CHANGE` and `PROJECT`; legacy
`FEATURE` means `PLANNED_CHANGE`. _Avoid_: Routing intent, request type, work kind

**Plan Status**: The lifecycle state of a Plan: `draft`, `feedback`, `approved`, `ready_for_decomposition`,
`ready_for_work`, `in_progress`, `failed`, `implemented`, `verified`, `closed_without_verification`, or `on_hold`.
_Avoid_: Phase, stage

**Plan Lifecycle**: The state machine that decides how Plan Events change Plan Status and recovery metadata; see
`docs/plan-lifecycle.md`. _Avoid_: Status helper, plan status logic

**Plan Event**: A recorded workflow fact that the Plan Lifecycle uses to transition a Plan. _Avoid_: Next step, status
update

**Plan Action Evidence Check**: The action-time reload of selected Plan status, Plan revision, and worktree registry
evidence before a consequential Plan action runs under the Session Writer Lock. For a targeted Epic child, the selected
Plan can be in a planning worktree before execution starts. _Avoid_: Plan ownership, durable Plan lock, separate
ownership record

**Approved Plan**: A Plan whose Review Loop ended in user approval but whose pre-execution preparation may still be
unfinished. _Avoid_: Ready plan, executable plan

**Approve & Run**: A Plan review outcome that both approves the Plan and explicitly authorizes the current Session to
continue through readiness, execution, and Workflow Validation. _Avoid_: Approve, auto-run

**Approve for Later**: A Plan review outcome that approves and prepares the Plan as Ready For Work without authorizing
immediate execution. _Avoid_: Save draft, approve and run

**Ready For Work**: The Plan Status meaning execution prerequisites are satisfied; PLANNED_CHANGE Plans are executable,
while Epics expose their finalized child Plans but remain non-executable. _Avoid_: Approved, runnable

**Readiness Gate**: The classification-aware lifecycle step after approval that promotes PLANNED_CHANGE Plans to Ready
For Work and PROJECT Epics to Ready For Decomposition. _Avoid_: Slicer phase, execution check

**Failed Plan**: A Plan that reached Ready For Work but could not complete execution successfully, with a durable
failure explanation. _Avoid_: Rejected plan, invalid plan

**In-Progress Plan**: A Plan whose execution has started and whose worktree may contain partial implementation work. A
planning worktree for an Epic child does not make the Plan In Progress. _Avoid_: Running plan, active plan

**On-Hold Plan**: A deferred non-verified Plan that preserves its prior Plan Status and staleness baseline for a future
Resume Check. _Avoid_: Archived plan, canceled plan, completed plan

**Archived Plan**: A terminal or force-archived Plan moved under `docs/plans/archived/` as short-lived staging before
Archive Prune removes it after a Work Record exists and retention policy allows removal. _Avoid_: Current spec,
permanent knowledge source, Work Record

**Plan Archive Retention**: The repository-owned policy in `.wld/settings.json` that controls when archived Plans become
eligible for Archive Prune and how many recent eligible Plans stay spared. _Avoid_: User preference, global setting,
automatic deletion

**Archive Prune**: The explicit `wld plans prune` action that deletes eligible Archived Plans from the working tree for
reviewable commit. It never deletes a Plan without Work Record coverage. _Avoid_: Auto-cleanup, Work Record pruning,
archiving

**Resume Check**: The pre-resume inspection for an On-Hold Plan that checks staleness and worktree risk before restoring
the held Plan Status. _Avoid_: Workflow Validation, plan validation, verify-and-resume

**Plan Recovery**: Choosing how to continue an In-Progress Plan or Failed Plan from the current worktree state. _Avoid_:
Resume, restart

**Implemented Plan**: A Plan whose execution work finished and is ready for the Mechanical Validation phase of Workflow
Validation; CI or review repairs return here for fresh CI. _Avoid_: Completed plan, done plan

**CI-Validated Plan**: A Plan at `validated_ci`, meaning Mechanical Validation passed and the next validation call
resumes at Semantic Review. _Avoid_: Verified plan, implemented plan

**Reviewer-Validated Plan**: A Plan at `validated_reviewer`, meaning Semantic Review passed and the next validation call
handles Code Review and publication. _Avoid_: Verified plan, code-review status

**Verified Plan**: A Plan whose execution and Workflow Validation both finished successfully. _Avoid_: Completed plan,
done plan

**Closed Without Verification Plan**: A terminal Plan accepted without successful RunWield Workflow Validation. _Avoid_:
Verified plan, archived plan, on-hold plan

**Review Loop**: The cycle where a planning agent writes or revises a Plan and the user approves or returns it through
Plannotator. _Avoid_: Feedback loop, approval cycle

**Semantic Review**: The internal state-machine term for the automated Reviewer check during Workflow Validation. It
compares the approved Plan with the full proposed branch patch from the recorded target/execution common ancestor to the
current execution-worktree files. TUI and Workspace progress copy calls this **AI review**. _Avoid_: Code Review, Forge
review, automated tests

**Standalone Code Review**: Code Review of a PR, branch, or uncommitted changes without a Plan or Plan lifecycle.
Started with `wld review`. The gate **Code Review** still means the Plan validation gate.

**Review Worktree**: A worktree created on demand for Standalone Code Review, outside the Plan worktree registry.
RunWield preserves it when it holds uncommitted or unpushed work. An existing branch checkout can be reused but is not
owned or removed by Standalone Code Review.

**Code Review**: The optional RunWield gate where a person reviews the same full proposed branch patch used by Semantic
Review before delivery. Reload recomputes it from the recorded target, execution HEAD, and current worktree files. The
user approves the diff or sends feedback. Internal compatibility identifiers can still use `humanReview` or
`human_review`, but user-facing copy calls this **code review**. _Avoid_: Human Review, Semantic Review, Forge review,
Plan Review Loop

**Review Issue Ledger**: The temporary per-attempt record of requirement coverage, Review Issues, repair claims, and
Reviewer re-verification. _Avoid_: Review log, durable Plan history, Work Record

**Review Issue**: A blocking Semantic Review finding that shows the proposed implementation fails an unambiguous
approved Plan requirement. It must be repaired, or resolved by a user-confirmed Plan Deviation that replaces the
requirement, before approval. If later evidence proves the finding was attributed to unchanged target context,
independent review can confirm it as already satisfied without a file edit; its identity remains stable. _Avoid_: Review
Advisory, style note, suggestion

**Review Advisory**: A non-blocking Semantic Review finding that explains an ambiguity in the approved Plan without
preventing implementation approval. _Avoid_: Review Issue, warning, waived defect

**Review Override**: A proposed one-delivery user decision to accept a specific Review Issue without changing the Plan
requirement. It is not a Plan Deviation and does not become future Plan authority. _Avoid_: Plan Deviation, Review
Advisory, permanent waiver

**PRD**: An independent durable product-requirements artifact that may inform multiple Plans and Agent Sessions without
participating in Plan Lifecycle. _Avoid_: Plan, Work Item, chat transcript

**Plannotator**: The browser-based artifact review UI where users approve, return feedback, or annotate Plans, Work
Records, and code-review diffs. _Avoid_: Plan-only review UI, approval screen

**Guided Review**: A Plannotator explanation of a PR or local diff presented in conceptual order with supporting prose
and visual aids. _Avoid_: Guide, review summary, file-order review

**Guided Review Policy**: The validation-time setting that decides whether RunWield never, conditionally, or always
generates a Guided Review for a human code review. _Avoid_: Diff size setting, guide preference

**Guided Review Widget**: A sandboxed interactive visual aid used when prose, diagrams, and live diffs cannot adequately
explain a Guided Review. _Avoid_: Default review block, arbitrary app extension, generated production UI

**Plan Board**: A browser surface for inspecting and editing Plans while repository Plan files remain canonical.
_Avoid_: Remote plan database, hosted board, task board

**Workspace**: The browser environment for RunWield Sessions, workflows, and durable artifacts across registered
Projects while repository artifacts remain canonical. _Avoid_: Project root, browser IDE, database-only knowledge base,
replacement for Plans

**Project**: A trusted repository or directory registered in Workspace as a boundary for Sessions, artifacts, code, and
workflows, distinct from the uppercase `PROJECT` Routing Intent. _Avoid_: Workspace, workspace root, project space

**Attention Dashboard**: The Workspace surface aggregating work needing user judgment and active or recent workflow
state across Projects. It has Needs You, Ready to Continue, In Progress, and Recently Finished groups. _Avoid_: Project
grid, task board, notifications page

**Plan Home**: The existing Workspace Plan detail route that shows the readable Plan, workflow diagram, blocker, next
action, and proven working Session link. _Avoid_: Plan progress page, second Plan detail

**Workflow Sidebar**: The Session context tab that shows the same Plan workflow presentation used by Plan Home, adapted
for Workspace and TUI. It displays workflow facts; it does not own lifecycle transitions. _Avoid_: Progress page,
Session status mapper

**Code Surface**: The Workspace surface for inspecting or manually changing a Project's main checkout. _Avoid_:
Workspace shell, Plan worktree editor, Agent terminal

**RunWield Design System**: The shared tokens, components, and interaction language governing RunWield browser surfaces.
_Avoid_: Workspace styles, style guide, UI kit

**Plan Card**: A Plan Board representation of a top-level Plan or Epic and its lifecycle state. _Avoid_: Task card,
ticket

**Plan Editor**: The Plan Board surface for editing Plan markdown while workflow-critical front matter remains governed
by structured Plan Lifecycle actions. _Avoid_: Raw Plan file editor, front matter editor

**Plan UI Server**: The local server that backs Plan Board access to Plan files in the current checkout. _Avoid_: Hosted
collaboration service, daemon

**Feedback**: Structured user annotations returned when a Plan is denied or re-opened in Plannotator. _Avoid_: Comments,
notes

**Revision**: A single planning pass that updates a Plan in response to Feedback.

**Origin**: A Plan front matter value of `internal` for RunWield-created plans or `external` for imported markdown.
_Avoid_: Source, provenance

### Agents

**Agent**: A specialized LLM work owner and thinking mode with its own context boundary, Agent Definition, model
binding, and behavioral policy. _Avoid_: Bot, assistant, model, skill

**Router**: The default Agent Definition prompted to perform Triage and emit a Triage Report. _Avoid_: Dispatcher,
orchestrator, classifier, triager

**Operator**: The execution Agent for `OPERATION` work. _Avoid_: Executor, fixer, worker

**Planner**: The planning Agent for `PLANNED_CHANGE` work and complete PROJECT Sequences. _Avoid_: Designer, strategist

**Architect**: The planning Agent for PROJECT Epics. _Avoid_: Designer, lead

**Guide**: The read-mostly Agent for `INQUIRY` work that answers directly without materializing artifacts or running a
Socratic interview. _Avoid_: Explainer, investigator, researcher

**Ideator**: The strategic product and research Agent that conducts Socratic interviews to sharpen vague ideas before
planning or implementation. _Avoid_: General helper, explainer, guide

**Slicer**: The Agent that helps decompose an approved PROJECT Epic into child PLANNED_CHANGE Plans and can materialize
those plans under `docs/plans/<epic-name>/`. _Avoid_: Task planner, splitter

**Recorder**: The Agent that generates Work Records from completed planned work. _Avoid_: Reviewer, summarizer, auditor

**Work Record Search Tool**: The tool for retrieving relevant Work Records with their status notices. _Avoid_: Memory
recall, plan search, Engineer context tool

**Project Knowledge Search**: Deliberate Agent retrieval over durable artifacts within the active Project. _Avoid_:
Session Transcript search, automatic context injection, code search

**Workspace Search**: Owner-only browser retrieval across eligible durable artifacts in enabled registered Projects,
plus Session entry points from the committed Session Name and first user message. It uses a rebuildable index but
rechecks canonical sources before display and navigation. Session entry text helps the owner resume a Session; it is not
shared knowledge, full Session Transcript search, or cross-Session Agent retrieval. _Avoid_: Workspace Intelligence
Search, Project Knowledge Search, global code search, transcript search

**Possible test-seam risks**: The advisory `/test-seams` prompt result section for evidence-backed candidates where
representative project tests appear able to replace product-owned behavior. Each candidate stays speculative until the
user classifies it, and RunWield asks before it writes an issue or Plan for the risk. _Avoid_: seam check, clean test
architecture report, automatic refactor

**Engineer**: The selectable full-stack Agent for bounded no-plan QUICK_FIX code changes. Engineer can work in any layer
by loading the relevant Skills, including browser UI Skills, but does not execute approved Plans. _Avoid_: Plan
Engineer, Coder, implementer, developer

**Plan Engineer**: The workflow-only execution Agent for approved PLANNED_CHANGE Plans whose dominant concern is not
browser-rendered UI. Plan Engineer is activated by Plan execution and stays through implementation, validation repairs,
and recovery. _Avoid_: Engineer, hidden subagent, Quick Fix Engineer

**Frontend Engineer**: The workflow-only execution Agent for approved Plans whose dominant concern is browser-rendered
UI and client-side behavior, with browser-first and design-system-aware work policy. It is not a QUICK_FIX Agent.
_Avoid_: Frontend mode, UI Engineer, Engineer with frontend Skill

**Tester**: The fresh-context verification Agent for behavioral QA, UI QA, PRD conformance testing, and adversarial
bug-finding. _Avoid_: Unit test writer, test framework specialist

**Agent Definition**: A markdown file with YAML front matter defining an Agent's display name, model, tools, and system
prompt. An optional `bashAllowedCommands` list limits RunWield-managed bash and background shell starts without granting
bash. Layered definitions inherit an omitted field, merge non-empty lists without duplicate entries, deny all with `[]`, or reset the definition's
inherited list with `null`; an absent list means unrestricted bash. This best-effort filter is not a sandbox and does
not limit external CLI native shells. _Avoid_: Agent def, agent prompt, agent config

**Skill**: A reusable instruction package an Agent can load for a specialized technique without changing work owner or
Agent Session. _Avoid_: Agent, workflow role, sub-agent

**Testing Skill**: A bundled, language- and framework-agnostic Skill that guides an Agent in writing or maintaining
tests for a specific testing style or installed project stack. _Avoid_: Tester agent, QA role, bundled stack policy

**QA Intervention Policy**: A user or project preference that controls whether the Tester reports findings only, adds
regression tests, or fixes defects during verification. _Avoid_: Tester mode, QA setting

**Documentation Skill**: The Skill that guides an Agent when creating or updating project documentation. _Avoid_:
documentation agent, documenter

**Agent Name**: The internal identifier for an Agent, derived from its Agent Definition filename without `.md`. _Avoid_:
Display name, label

**Agent Display Name**: The human-readable name in Agent Definition front matter used when rendering agent messages.
_Avoid_: Agent name, file name

**Agent Session**: One invocation of an Agent with merged Agent Definition data, bound tools, extensions, and message
history. _Avoid_: Run, interaction, conversation

**Steering Message**: A user message submitted while an Agent Session is streaming or during an Agent Handoff. It is
routed to the current foreground steerable Agent Session, or held for the replacement Agent, and injected at the next
safe boundary. The current tool is allowed to finish, but later pending tool calls can be skipped so the Agent can
reconsider with the user's input. _Avoid_: Provider-stream interruption, mid-tool cancellation

**Agent Handoff**: The change from one active root Agent Session to its replacement after an accepted workflow event.
The outgoing turn settles before replacement provider work starts. Pending Steering Messages transfer to the replacement
without becoming consumed during transfer. _Avoid_: Agent reload, message replay

**Agent Handler**: The runtime handler that runs an active Agent Session turn and interprets workflow Custom Tool
outcomes. _Avoid_: Agent-specific handler, special agent handler

### Execution & Tools

**Workflow Orchestrator**: The runtime coordinator that consumes workflow Custom Tool outcomes and starts the next Agent
Session. _Avoid_: Router, dispatcher agent

**Workflow Decision**: An ephemeral semantic instruction telling workflow callers what to do next without directly
changing Plan Status. _Avoid_: Workflow Outcome, status update, lifecycle event

**Delegated Agent Session**: A disposable context-isolated Agent Session that receives a bounded brief from a parent
Agent Session and returns only its result. Its bash tool access is narrowed by the parent and its effective read or
write role; any command list is the intersection of parent and child limits. Neither omitted nor `null` child policy
clears a parent limit. Read delegates default to inspection commands, while write delegates have no default command
list. A read-only delegation may run as a Background Task; a write delegation may not. Guide's explicitly requested
ordinary Markdown writing is a separate docs-only capability, not delegated shell authority. _Avoid_: Context-free
session, Task worker, workflow handoff

**Background Task**: A Session-local, host-process-owned shell command or read-only Delegated Agent Session started
without blocking the parent Agent. Its task ID permits status and cancellation in that same live Session owner. Core
sends its finished result to the parent Agent through steering or a later generated turn, not as a user Steering Message
or workflow Task Completion. Up to five may be active per Session in one process. A task may outlive a normal Agent turn
but does not survive process exit or replay on Session resume. Accepted Task Completion suppresses pending and queued
results; normal turn end does not. _Avoid_: Durable job, workflow Task Completion, user Steering Message, detached
`bash` command, validation evidence from cancellation

**Delegated Agent Role**: An optional specialization a parent selects on `delegate_agent`, composing a prompt overlay
onto the base delegated prompt and declaring an authority ceiling that can reduce the requested delegation mode.
Omitting it yields the unspecialized `general` role. _Avoid_: Subagent type, delegated persona, Agent subtype

**Verification Adversary**: The read-only Delegated Agent Role (`verification-adversary`) that receives a draft Plan and
looks for ways an implementation could satisfy its outcomes, steps, and verification claims without achieving the
intended behavior. Recommended for structural or high-risk Plans; never a required gate. _Avoid_: Plan reviewer,
Reviewer, red team, adversarial validation

**Epic**: A PROJECT Plan with `type: epic` or no type, containing design and decomposition context. Its approval action
is Approve & Slice. A new Epic has an **Epic Branch**, which owns current child progress. _Avoid_: Initiative, umbrella
task

**Plan Branch**: The landing branch for a standalone Planned Change when `plans.autoMergeIntoTargetBranch` is off (the
default). RunWield creates `plan/<plan-name>` from the Plan's `targetBranch`, or reuses it without resetting it.
`targetBranch` keeps the source and intended destination; `deliveryBranch` records the landing. With no authored target,
RunWield records the repository default branch. RunWield delivers to the Plan Branch but does not merge it onward; the
user merges it or opens a pull request. _Avoid_: Feature branch, Epic Branch

**Epic Branch**: The branch an Epic starts and ends on, recorded as the Epic's `targetBranch` (default
`epic/<epic-name>`). RunWield creates it from the latest primary branch when the Epic first needs it, records that
commit as `epicBaseCommit`, and puts child drafts on it. Children deliver to it. RunWield never merges it into the
primary branch; the user merges it or opens a pull request. _Avoid_: Release branch, feature branch

**Integration Notes**: What a child's Semantic Reviewer leaves for the **Integration Gate**: checks that only the
assembled Epic can show, such as an assumption about a sibling's work. RunWield keeps them in a managed
`### Integration Notes` subsection of the Epic's Verification Plan. They are places to look, not requirements, and they
never block the child. _Avoid_: Integration requirements, deferred findings

**Integration Gate**: The check that finishes an Epic with an **Epic Branch** once every included child is delivered to
it. It runs the project's checks, an integration review of the whole Epic diff, and Code Review per the `codereview`
setting, on the exact branch head. A pass makes the Epic `validated` for that commit; findings become a draft repair
child that Planner starts from. _Avoid_: Epic validation run, final review

**Sequence**: A PROJECT Plan with `type: sequence` whose brief context and complete child Plans are authored by Planner
and reviewed together. Approve & Execute starts the first child; normal PROJECT continuation runs subsequent children in
order. Each child retains its own validation and delivery. A Sequence is lightweight on purpose: it has no aggregate
validation or **Integration Gate**, and it gets a branch only when the user asks for one. _Avoid_: Epic, separate chain
manifest

**Child PLANNED_CHANGE Plan**: An executable PLANNED_CHANGE Plan linked to a PROJECT container through `parentPlan`.
Targeted Epic children can have a planning worktree before execution; approval promotes that same checkout to execution.
_Avoid_: Child FEATURE Plan, subtask, ticket, DAG node

**Epic Artifact**: A reserved non-Plan Markdown file stored beside an Epic's Child PLANNED_CHANGE Plans:
`docs/plans/<epic>/manual-qa.md` and the latest failing **Integration Gate** report,
`docs/plans/<epic>/integration-report.md`. It is ordinary user-owned Markdown, has no Plan Lifecycle, and has no
verification, dependency, delivery, or Epic completion authority. _Avoid_: QA tracker, child Plan, artifact lifecycle

**Task Completion**: The `task_completed` signal an execution Agent emits when its assigned work is complete. The first
eligible call with running Background Tasks is rejected with their IDs and kinds; the next eligible call cancels any
remaining tasks and accepts completion. Every accepted call suppresses pending and queued Background Task results, even
with no running tasks. Cancellation is not successful test evidence; later work may start new tasks. An Agent that is
blocked ends its turn in plain text instead, and the workflow pauses. _Avoid_: Done message, final response, Background
Task result, cancelled task as passing test evidence

**Scope Escalation**: A conversational boundary where the active Agent states a concrete role or tool limit and offers
the user explicit options, such as a suitable `/agent <name>`, an in-role alternative, or returning to the prior
request. Only the user transitions control. _Avoid_: Surprise return, silent reroute

**Workflow Validation**: RunWield's independent validation pass after a completed executable Plan loop. One supervisor
reloads the primary Plan, worktree record, and Git facts before each run. _Avoid_: Agent self-check, final summary

**Validation Checkpoint**: A small, versioned Plan field that owns the current validation attempt, next step, repair
generation, consume-once completion receipt, and attempt-scoped Review Issue state that Plan Status alone cannot
express. Plan Status still selects the validation phase. Session workflow state only projects the checkpoint. It is
cleared when validation ends, review reopens, or the implementation attempt is replaced. _Avoid_: Second status, Session
state

**Session-Independent Validation Engine**: Workflow Validation sequencing, convergence policy, and gate predicates run
on the shared engine (`src/shared/workflow/validation-engine.ts` and its phase modules). Its supervisor and local CI
command runner also work without a Session. Core's `validation.ts` builds `ValidationSessionPort` over HostedSession;
`validation-host-turn.ts` uses the same supervisor and engine but returns typed reviewer, repair, and decision requests
instead of in-process waits. Request-bound outcomes resume from the Validation Checkpoint through the existing gates.
Host-turn validation stops at `reviewed`, before delivery. _Avoid_: Second validation implementation, session-coupled
engine

**Mechanical Validation**: RunWield's automated command validation loop. In no-plan QUICK_FIX work it runs local CI only
without semantic review or Plan status transitions; inside Workflow Validation for executable Plans it runs the
repository's configured CI before Semantic Review. _Avoid_: Workflow Validation, Reviewer review, agent self-check

**Plan Amendment**: A retired name for a broad automatic gate that tried to adopt execution-worktree Plan edits during
Workflow Validation. The active validation path does not show an automatic Plan Amendment approval gate and does not
silently adopt Plan body or definition edits from the execution worktree. Plan Status, worktree metadata, Delivery
Evidence, validation counters, and other lifecycle fields remain RunWield-owned. _Avoid_: active validation gate, silent
worktree Plan edit, lifecycle edit

**Plan Deviation**: An explicit user-confirmed replacement for an effective Plan requirement during Plan execution, in
autonomous or Pair style, including restored Sessions and validation repairs. The execution Agent proposes the
superseded requirement, replacement requirement, and optional reason through `record_plan_deviation`; a typed user
confirmation writes it to the authoritative execution Plan. Confirmed Plan Deviations supersede conflicting original
Plan text for execution, Semantic Code Review, and Work Records. Ordinary Pair feedback, transcript text, metrics,
arbitrary Plan-file edits, and one-delivery Review Overrides are not Plan Deviations. _Avoid_: automatic Plan Amendment,
checkpoint feedback, review waiver, silent Plan edit

**Pair Execution**: A user-steered Plan execution style where Plan Engineer or Frontend Engineer delivers coherent
observable increments and pauses through ordinary Session conversation. It is a collaboration style, not validation
evidence. If user feedback conflicts with the effective Plan, it becomes authority only through a confirmed Plan
Deviation. _Avoid_: Live pair-design, frontend mode, Manual QA

**Pair Checkpoint**: A durable Pair Execution report and its later typed resolution. The report ends the Agent turn so
the user can discuss the increment in normal conversation. Only a later accepted user turn can authorize continue,
revision, autonomous work, Stop, or final completion. _Avoid_: Checkpoint form, approval phrase, validation evidence

**Toolset**: A named bundle of tool names granted to an Agent Session. _Avoid_: Tool list, capabilities

**Custom Tool**: A RunWield-defined tool registered alongside built-in pi tools. _Avoid_: Internal tool, RunWield tool

**Web Tools**: The RunWield-owned Custom Tool family for web access: `web_search`, `web_fetch`, `web_code_search`, and
`web_docs_search`. RunWield pins every helper backend and reads the user `ketch` config for credentials only, so the
same Agent request uses the same web surface on each model backend. _Avoid_: Ketch Skill, native web tools,
backend-specific web access

**Web-Search Tool**: The `web_search` Custom Tool that searches the public web with the pinned search backend and can
optionally return fetched page content with each result. _Avoid_: Native WebSearch, code search, docs search

**Web-Fetch Tool**: The `web_fetch` Custom Tool that fetches one URL and returns Markdown from the page. _Avoid_: Web
search, scraper skill, crawl tool

**Web-Code-Search Tool**: The `web_code_search` Custom Tool that searches public internet repositories. It is separate
from Cymbal `code_*` tools, which search the current checkout. _Avoid_: Project code search, Cymbal search, local symbol
search

**Web-Docs-Search Tool**: The `web_docs_search` Custom Tool that searches current library and framework documentation
with the pinned docs backend. If credentials are missing, it returns setup guidance from the helper. _Avoid_: General
web search, local docs grep, package install lookup

**MCP Server Configuration**: A trusted server declaration in `~/.wld/mcp.json`, project `.wld/mcp.json`, or an ACP
Session request. RunWield starts stdio MCP servers from this configuration and exposes their tools to root Agents only.
_Avoid_: settings key, Custom Tool definition

**MCP Tool**: A tool discovered from a trusted MCP server. Pi gives it a stable `mcp__<server>__<tool>` name and keeps
the original server and tool names in the tool metadata. _Avoid_: RunWield built-in tool, Custom Tool

**Bridged Tool**: A RunWield Tool exposed to an eligible external CLI Execution Backend turn over an authenticated MCP
bridge. Claude CLI and Antigravity CLI are the current examples. Lifecycle Bridged Tools can advance workflow state.
`pair_checkpoint` keeps its internal name and a terminating report ends the external backend turn. Other lifecycle tools
keep the shared external `runwield_` aliases for `plan_written`, `task_completed`, and `review_complete`; Claude CLI
also keeps its existing `runwield_triage_report` alias. Capability Bridged Tools do memory, Cymbal code intelligence,
web access, Work Record, interview, edit, MCP, or caller-supplied work and use their internal names, avoiding new
aliases such as `runwield_memory` or `runwield_code_search`. A Session Transcript can display and audit the tool
exchange, but a Workflow Tool Event remains the workflow authority. _Avoid_: CLI native tool, MCP plugin

**Memory Tool**: The `memory` Custom Tool that recalls, stores, or deletes Mnemoteca memories through an explicit
`action`. `action: "recall"` searches project and global memories together and labels each result group.
`action: "store"` defaults to project scope and uses `scope: "global"` only for cross-project memories.
`action: "delete"` requires `scope` and refuses an ID that is not safely tied to one scope. _Avoid_: Separate memory
recall, store, or delete tools

**Triage-Report Tool**: The `triage_report` Custom Tool that emits a Triage Report and ends the current Agent turn.
_Avoid_: Classification tool, triage result tool

**Plan-Written Tool**: The `plan_written` Custom Tool that starts the Review Loop and returns the Plan outcome. _Avoid_:
Review tool, approval tool

**User-Interview Tool**: The `user_interview` Custom Tool for structured clarification questions. _Avoid_: Question
tool, clarification form

**Vision Fallback**: A configured vision-capable model used only when the active Agent model is text-only and needs a
textual description of an attached image. _Avoid_: Image mode, multimodal router, vision agent

**See-Image Tool**: The `see_image` Custom Tool that returns a Vision Fallback description of a retained image to a
text-only Agent. _Avoid_: Screenshot plugin, image reader, OCR tool

**Code-Batch Tool**: The Custom Tool that batches bounded Cymbal `show` and `outline` reads. _Avoid_: Multi-search tool,
smart project snapshot

### Memory & Persistence

**Mnemoteca**: The external semantic memory system for project and global memories. _Avoid_: Memory layer, memory store

**Memory**: Current durable understanding stored in Mnemoteca for future retrieval: a fact, decision, preference,
constraint, rationale, or reusable lesson. Ordinary Memories provide useful context, not authority over the user,
current project docs, the applicable Plan, or code as evidence of implemented behavior. _Avoid_: Note, record, entry

**Local Memory**: A project Memory retained only in its owner's local Mnemoteca collection. _Avoid_: Private memory,
personal memory

**Team Memory Candidate**: A Local Memory classified as stable, repository-safe, and useful to teammates but not yet
trusted as shared project context. _Avoid_: Shareable memory, pending memory

**Team Memory**: A project Memory whose canonical human-readable form is versioned in the repository and whose local
Mnemoteca copies are derived from trusted text. _Avoid_: Shared memory, synchronized memory

**Core Memory**: A Memory tagged `core` that is injected into every Agent Session independently of whether it is Local
or Team. It provides strong guidance within the same authority limits as other Memories; injection does not turn it into
project truth or permission. _Avoid_: Critical memory, pinned memory, shared memory

**Global Memory**: A Memory stored in the cross-project collection. _Avoid_: Shared memory, universal memory

**Trusted Branch**: A configured repository branch whose reviewed Team Memories may become active local Mnemoteca
context. _Avoid_: Main branch, safe branch

**Sleep**: A maintenance workflow that exports, analyzes, and improves the Mnemoteca collection. _Avoid_: Memory
cleanup, memory maintenance

**Project Name**: The basename of the working directory used as the Mnemoteca collection identifier. _Avoid_:
Collection, namespace

**Cymbal**: The external code indexing and search system exposed to agents as codebase tools. _Avoid_: Search layer,
indexer

**Snip**: The external command-output compression proxy RunWield uses as an optional, fail-open runtime optimization for
eligible agent shell commands. _Avoid_: Required tool, agent tool, search tool

**Prompt Template**: A layered markdown template that defines a Core-owned named invocation available in TUI, Workspace,
and ACP Sessions. It renders into an ordinary user message. Its front matter can select persistent Session Agent, model,
and thinking settings; omitted settings inherit the Session, with Operator defaults for an unconfigured new Session.
_Avoid_: TUI command definition, prompt command

**Named Invocation**: A raw user slash request that Core resolves to a Prompt Template or Skill. RunWield displays the
rendered Prompt Template or compact Skill command and stores the exact resolved expansion for resume and model context.
_Avoid_: TUI expansion, client-side dispatch

**Sealed Session Transcript Segment**: A Session Transcript Segment that is no longer writable and has recorded byte
length, digest, and terminal-entry evidence for its final JSONL contents. _Avoid_: Archived transcript, old session,
closed file

**Aggregate Transcript Projection**: A read-only projection that renders verified sealed segments plus the committed
prefix of the current segment as one ordered Session timeline, including completed Pi tool calls and interaction
results. _Avoid_: Concatenated transcript, merged session, segment hydration

**Pending Structured Interaction**: A live in-process wait for a user answer, such as `user_interview` or Plan review
input. In a no-form ACP interview, each question ends one ACP request while the original Runtime operation and tool wait
remain live; the next request answers that wait. Pending interactions are process-local. The interaction becomes durable
only when Pi writes the completed tool result; if the owner process is lost first, the user asks the Agent to retry. A
Pair Checkpoint is not a Pending Structured Interaction; its report and resolution records are durable Session data.
_Avoid_: Durable prompt, recoverable continuation, database interaction record

## Relationships

- A **Remote SSH connection** uses Core to display a remote TUI for an existing directory; the connection itself is not
  a saved **Session** and does not yet start ordinary project execution or open **Project Runtime State**. Its **Remote
  personal mount** gives direct access to laptop personal files on the approved `sct` pilot, while the project’s `.wld`
  stays remote. The optional native Pi bridge proof is not an ordinary turn. Target remote Sessions add a separate
  guarded writer for saved history and local authenticated model execution.
- A **Tutorial** explains one real **Planned Change** through normal **Plan Review** and **Workflow Validation**. It
  does not replace **Init** or own Plan lifecycle state.
- One **Attached Workflow** governs one user request inside one **External Agent Host**.
- During an **Attached Workflow**, the **External Agent Host** owns model calls while RunWield owns durable workflow
  truth, review, validation, recovery evidence, Work Records, and organizational memory.
- An **Attached Workflow** persists structured evidence and durable artifacts without copying the host conversation into
  a **Session Transcript**.
- One **Attached Workflow Record** exists for each **Attached Workflow**. It is not a **Session**. Only the **Attached
  Workflow Coordinator** writes it.
- An **Attached Workflow Record** references **Plan** and worktree truth and never copies it.
- An **Aggregate Transcript Projection** emits no part of a generation until every included **Sealed Session Transcript
  Segment** and the current committed segment prefix have verified.
- A **Verified Plan** has the same meaning in **RunWield Connect** and **RunWield Core**, regardless of which
  **Execution Backend** Core uses.
- An **External Work Source** owns **Tickets** and demand management; RunWield owns planning, execution, **Plan
  Lifecycle**, and delivery truth.
- A **Forge** owns **Forge Change Requests**, repository review policy, branch publication, and remote merge outcomes.
- **Tickets** and **Plans** have a many-to-many relationship expressed through **Ticket References**.
- A **Ticket Reference** provides provenance and navigation without synchronizing either system's content, state, or
  lifecycle.
- A completed **Plan** carries its **Ticket References** into its **Work Record**; an Epic Work Record also aggregates
  Ticket References from its child Plans.
- A contributed Plan requires a **Repository Participation Declaration** before RunWield artifacts enter the
  **Publication Candidate**.
- Planned work uses either **Direct Delivery** or explicitly selected **Change Request Delivery**.
- **Change Request Delivery** can produce a **Verified Plan** only after a proven Forge merge of a revision covered by
  **Workflow Validation**.
- **Dual Review** adds **Code Review** to Forge review without replacing **Semantic Review**.
- One user request produces exactly one **Triage Report**.
- A **Triage Report** contains one **Routing Intent**, one **Complexity**, and one summary.
- A **Plan** lists zero or more **Affected Paths** in its front matter; a directory with no meaningful project files
  therefore produces none.
- **Diagnostic Triage** remains read-only and produces a normal **Routing Intent**.
- An **OPERATION** belongs to the **Operator** and creates no **Plan**.
- A **PLANNED_CHANGE** is planned by the **Planner**, reviewed through a **Review Loop**, and executed after approval by
  **Plan Engineer** or **Frontend Engineer**.
- A **PROJECT** produces one **Epic**, which the **Slicer** decomposes into zero or more **Child PLANNED_CHANGE Plans**.
- **Work Kind** describes the nature of planned work independently from **Routing Intent** and **Plan Classification**.
- A **Plan** has exactly one **Plan Status**, one **Origin**, and one YAML front matter block.
- A **Plan Event** is the only input that asks the **Plan Lifecycle** to change **Plan Status**.
- A **Plan Action Evidence Check** reloads canonical **Plan Status**, Plan revision, and worktree evidence before any
  consequential Plan action mutates lifecycle or worktree state.
- **Session Control** may let a client submit an answer, but the **Session Writer Lock** is required before the owning
  process mutates Session history.
- An **Approved Plan** passes through the **Readiness Gate** before becoming **Ready For Work**.
- **Approve & Run** authorizes the current Session to continue after readiness; **Approve for Later** stops at Ready For
  Work until a separate Run action.
- Only a non-Epic Plan at **Ready For Work** can proceed to implementation.
- An **Epic** contains decomposition context; its **Child PLANNED_CHANGE Plans** are the independently executable units.
- An **Epic** with an **Epic Branch** is implemented when every included child is delivered to that branch, not when
  every child shows a finished status, and is validated only by a passing **Integration Gate** on the current head.
- An **Implemented Plan** must pass **Workflow Validation** before becoming a **Verified Plan**.
- An **In-Progress Plan** or **Failed Plan** may require **Plan Recovery** before workflow can continue safely.
- A **Verified Plan** or **Closed Without Verification Plan** may produce a **Work Record**. A Plan accumulates zero or
  more Work Records over its lifetime, of which at most one is the current retrievable record; the rest are **Superseded
  Work Records** or **Archived Work Records**.
- Every **Work Record** has **Work Record Provenance**.
- A **Draft Work Record** requires human approval before default Agent retrieval.
- A **Pending Verification Work Record** requires a terminal Plan outcome before default Agent retrieval.
- A correcting approved **Plan** can declare confirmed predecessor Work Record IDs in `supersedes`. Work Record
  generation applies these declarations when the successor Work Record exists.
- If the correction becomes clear only during execution or review, the **Recorder** can create a **Supersession
  Proposal**. RunWield asks for a separate decision for each proposed predecessor in the interactive TUI and after
  interactive backfill.
- Headless completion leaves each **Supersession Proposal** pending and reports `wld wr supersede
<successorRecordId>`
  for later confirmation or rejection. The command also lists pending proposals and their reasons.
- **Superseded Work Records** and **Archived Work Records** remain durable but are excluded from default planning
  retrieval. Supersession does not change a Work Record's completion mode or remove its applicable confidence notices
  from explicit retrieval.
- One implementation attempt has at most one temporary **Review Issue Ledger**.
- A **Review Issue** blocks Semantic Review approval until repaired, independently confirmed as already satisfied from
  unchanged target context, or resolved by a confirmed Plan Deviation.
- A **Review Advisory** does not block approval.
- A proposed **Review Override** applies to one delivery only and does not change Plan authority.
- Denied Plan review produces **Feedback**, and each response to Feedback produces one **Revision**.
- A **PRD** may inform multiple Plans without participating in Plan Lifecycle.
- A **Workspace** contains zero or more registered **Projects** and may host live Sessions across them.
- A **Project** is the parent boundary for its Sessions, Plans, PRDs, ADRs, Work Records, and code access.
- A **Session** contains one user-facing history and one or more sequential or delegated **Agent Sessions**.
- A **Session Transcript** contains one or more ordered **Session Transcript Segments** while presenting one continuous
  user-visible history.
- A root Agent Session receives model history from only the active Session Transcript Segment.
- A live Session may have multiple observers, one holder of **Session Control**, and only one active mutation owner
  holding the **Session Writer Lock**.
- A Session Transcript is private to its owner and excluded from **Project Knowledge Search**. **Workspace Search** can
  use only the committed Session Name and first user message as an owner-only entry point; later messages, tool output,
  and reasoning remain excluded.
- A fresh Session receives prior conclusions through explicitly referenced durable artifacts, not another Session's
  transcript.
- Starting from a PRD, Plan, or Work Record creates a fresh Session; resuming re-enters the existing Session.
- Once a Session produces a Plan, the Plan becomes its primary durable workflow anchor.
- **Approve & Run** first passes **Plan Action Evidence Check**, readiness, and preparation, then activates a fresh
  execution Session Transcript Segment; **Approve for Later** creates no execution segment.
- The execution segment receives the approved Plan, approval annotations, and execution state without inheriting
  planning messages.
- The Plan execution Agent remains the runtime owner through Workflow Validation, repairs, recovery, and successful
  validation. The durable Plan owner remains `engineer` or `frontend-engineer`.
- **Project Knowledge Search** retrieves durable artifacts within one Project.
- The **RunWield Design System** governs **Workspace**, **Plan Board**, and **Plannotator** browser surfaces.
- Every **Agent Session** loads exactly one merged **Agent Definition**.
- An **Agent** may load one or more **Skills** without changing work ownership or Agent Session identity.
- A **Delegated Agent Session** receives a bounded brief without inheriting its parent's conversation history.
- A **Delegated Agent Role**'s authority ceiling bounds the requested delegation mode; the **Verification Adversary**
  runs read-only and advises Planner without gating any Plan Status transition.
- An execution Agent Session emits **Task Completion** before validation can begin.
- **OPERATION** work ends after Operator self-verification; **QUICK_FIX** work receives **Mechanical Validation**;
  executable Plan work receives Workflow Validation.
- **Engineer** owns QUICK_FIX work. **Plan Engineer** and **Frontend Engineer** own approved Plan execution. **Pair
  Execution** is an optional Plan execution style, not a validation substitute.
- **Scope Escalation** states a concrete limit and offers user-owned transition options; it never changes control by
  itself.
- The **See-Image Tool** uses **Vision Fallback** only for a text-only active model.
- Every project **Memory** is either a **Local Memory** or a **Team Memory**; **Core Memory** independently controls
  always-on injection.
- A **Team Memory Candidate** begins as Local Memory and becomes Team Memory only after its canonical text is trusted
  through the repository workflow.
- A Team Memory has one canonical repository representation and zero or more derived local **Mnemoteca** copies.
- Only Team Memories accepted through a **Trusted Branch** may become active shared context.
- Core Memories are injected into every Agent Session.

[Mnemoteca]: https://github.com/gandazgul/mnemoteca
