# Product Requirements Document (PRD): RunWield Core

**Document role: Living central PRD.** Shared local workflow principles and lasting Core product requirements.

This PRD defines the user needs and outcomes for **RunWield Core**: local planning, execution, conversation, validation,
and recovery. [Domain language](../domain-language.md) defines the shared product terms. Architectural choices belong in
ADRs, implementation steps and remaining work in Plans, and delivery evidence in Work Records. Fold lasting requirements
from completed feature PRDs into this document.

Each capability states its scope and maturity. A listed capability does not establish that every journey using it is
complete.

## Vision & Strategy

**RunWield Core** is an opinionated, local-first coding harness for AI-partnered software planning and execution. It
replaces "chat-and-hope" AI with Plan-by-Default work: requests go to specialized Agents, project and Session context
persist, implementation work is validated, and durable Plan artifacts stay in the repository.

Core is the free local engine behind the broader RunWield product:

- local `wld` CLI
- interactive TUI
- local browser Workspace client
- Plan lifecycle and validation workflows
- local Markdown Plans, PRDs, ADRs, and Work Records
- Agent definitions, skills, tools, and model configuration
- consistent Sessions and workflows across TUI, ACP, and Workspace

Core stays compatible with `@earendil-works/pi-coding-agent` conventions, APIs, Session behavior, model and provider
configuration, and skill and tool ecosystem expectations. RunWield diverges only where its planning, lifecycle,
validation, memory, or Workspace goals need a distinct product surface.

## Core Philosophies

- **Plan-by-Default:** Material work becomes a reviewed Plan unless it is an `INQUIRY`, an `OPERATION`, or a `QUICK_FIX`.
- **Right ceremony for the request:** Router matches the workflow to the request, so simple tasks stay light and large
  work gets a complete specification.
- **Artifacts over vibes:** Plans, PRDs, ADRs, and Work Records are durable project memory.
- **Session continuity:** Fresh Sessions start with Router. Follow-up messages stay with the specialist that owns the
  topic until the user starts fresh or returns to Router.
- **Work protection:** RunWield preserves user work and asks before any action that could destroy it.
- **Tool-driven workflow:** Agents declare intent with workflow tools; orchestration code owns lifecycle transitions,
  execution, validation, and recovery.
- **Local-first control:** Core provides an independently useful local workflow.
- **Context parsimony:** Agents use targeted project context, memory recall, code intelligence, and Plan artifacts.
- **Pi compatibility by default:** RunWield follows Pi Coding Agent conventions where its product vision allows.
- **Extensible but guarded:** Users customize Agents, skills, prompt templates, and tools; protected workflow tools keep
  Core workflows intact.
- **Two workflow conclusions:** A delivery workflow ends with confirmed publication or the user's deliberate
  abandonment. RunWield repairs its own machinery. See
  [Workflow completion and automatic recovery](#workflow-completion-and-automatic-recovery).

## Capability Requirements

Each capability below owns its named requirements and acceptance scenarios. Scope labels record product commitments;
they are not a release audit. Other capabilities and surfaces link to these requirements and add only their own
behavior.

- [TUI conversation](#tui-conversation)
- [Agent mascots](#agent-mascots)
- [Request routing](#request-routing)
- [Plan review](#plan-review)
- [Plan authoring and external adoption](#plan-authoring-and-external-adoption)
- [Plan lifecycle](#plan-lifecycle)
- [Epic decomposition and hold](#epic-decomposition-and-hold)
- [Execution, validation, and recovery](#execution-validation-and-recovery)
- [Semantic review and repair](#semantic-review-and-repair)
- [Standalone code review](#standalone-code-review)
- [Frontend engineering and pair execution](#frontend-engineering-and-pair-execution)
- [Theme selection](#theme-selection)
- [Project context and initialization](#project-context-and-initialization)
- [Tutorial](#tutorial)
- [Compaction and image context](#compaction-and-image-context)
- [Image generation](#image-generation)
- [Work records](#work-records)
- [Agent and skill customization](#agent-and-skill-customization)
- [Models and providers](#models-and-providers)
- [Installation and updates](#installation-and-updates)
- [Remote connection](#remote-connection)
- [Work protection](#work-protection)
- [Session continuity](#session-continuity)
- [Capability-organized product requirements](#capability-organized-product-requirements)
- [Usage measurement and export](#usage-measurement-and-export)

### TUI conversation

**Scope and maturity:** Current baseline. The TUI is the primary interactive Core client. Core owns command meaning;
each surface owns which commands it offers and how it presents questions.

**Requirement: Keep follow-ups with the active specialist.** New Sessions start with **Router**. After Router hands off
to a specialist, that specialist stays the active root Agent for follow-up messages. Accepted task completion settles
the Agent turn and its transcript writes before Core releases the Session, so the next message is accepted on its first
submission.

Users can:

- use `/new` to start a fresh routed Session;
- use `/agent router` to route the next message in the same Session;
- use `/resume` to resume a chat Session;
- use `/load-plan <plan>` to resume a Plan workflow.

**Requirement: Agent selection replaces active instructions.** Switching Agents keeps the conversation history and
gives the model the selected Agent's system instructions and tools. Earlier Agents' instructions remain history only,
including after Session resume. A successful change to a different Agent produces one conversation notice.

**Requirement: Preserve steering through an Agent handoff.** When a workflow event starts a handoff, Core settles the
outgoing Agent turn before the replacement Agent starts provider work. Steering Messages sent from that point go to the
replacement Agent once, in order, with their text, images, and notification destination intact. Core reports a message
as consumed when the replacement Agent receives it. If replacement setup fails, the previous Agent stays active and
keeps the pending messages. Canceling the Session clears pending messages and ends the handoff.

**Requirement: Commands are commands.** A leading slash that resolves to an available command runs that command.
Disabled or unknown commands fail visibly. A fully typed `/load-plan <plan>` opens that exact Plan with one Enter;
partial names stay discoverable through completion. Background Task results reach the Agent as information: they keep
the unsent draft and the active specialist unchanged and never run as commands.

**Requirement: Restore complete saved conversation history.** Resuming a Session renders its committed history in
order through the final saved message, once per event, across any number of replay pages. Replay shows the transcript
without running saved requests or tools. Each Session's replay delivers only its own history.

**Requirement: Show workflow progress in the sidebar through delivery and resume.** The sidebar follows planning,
clarification, Plan review, implementation, the **Verification Command**, AI review, repair, Code Review, publication,
and completion. Each stage shows its status once. A running repair stays the current stage, with its failed check
visible. **Answer agent** and its question detail appear while a question is
pending and clear as soon as the user answers or cancels it on any surface. TUI shortcuts reopen review or resume saved
work.

Validation progress and the latest settled checkpoint survive panel dismissal and Session reopening. Newer phases and
confirmed completion always take precedence over older checkpoints. A new workflow starts with fresh progress. Confirmed
delivery to the configured target completes the sidebar; the onward merge or PR is the owner's responsibility.

Delivery cards label the automatic review **AI Code Review**, the user's review **Code Review**, the configured check
**Verification Command**, integration **Merge worktree**, and the owner's manual check **User verification**.

**Requirement: Offer the next Session action after delivery.** After confirmed Plan publication, the TUI removes the
review and publishing panel and keeps the outcome in the conversation. When the workflow settles, a focused selection
offers **Start a new session**, **Load a Plan**, or **Quit**. Load a Plan opens a fresh Session with the Plan picker.
Escape keeps the current Session for follow-up. The menu appears only for live, successful completion.

**Requirement: Open mentioned Project documents.** In hyperlink-capable terminals, Agent messages link existing
Project-relative Markdown files to a read-only local reader, with their visible labels intact. The reader shows the
current file with its title, type, and path, supports several tabs, and serves only the current Session's Project.
Other terminals show the plain paths.

**Requirement: Keep the terminal responsive.**

- Returning focus to the terminal or pressing Ctrl+L repaints the screen and keeps the draft, scroll position, active
  interaction, and running turn.
- Ctrl+O toggles the tool groups in the current viewport. Each expanded block shows up to 500 lines, keeping the start
  and end and counting the omitted middle lines.
- Long conversations stay responsive during live updates. Scrolling moves the viewport while the Agent works, and
  Escape interrupts the turn.
- After a Session replacement, the view follows the new Session from its next frame.
- The busy activity string stays stable through one busy period, changes with the Agent, and falls back to
  `Working...`.
- Exiting the TUI restores the shell without leaving the input or its borders behind. Existing shell history stays
  intact.

**Acceptance scenarios:**

- Given a new conversation, when the user submits a request, Router triages it; after a handoff, follow-ups stay with
  the specialist.
- Given Operator reports accepted task completion, when the user sends a follow-up, Operator receives it once on the
  first submission.
- Given a Session handled by Router and Ideator, when the user selects Engineer, the model receives Engineer's
  instructions and tools with the conversation intact, including after resume.
- Given Router has emitted a Triage Report, when the user sends messages before the specialist is ready, the specialist
  receives each message once, in order.
- Given a fully typed Plan name that is a prefix of a longer Plan name, one Enter opens the typed Plan.
- Given more than 200 saved events, terminal resume shows the final response.
- Given a pending question, when the user answers it on either surface, **Answer agent** disappears at once; a new
  question restores it. A running shell command shows progress without **Answer agent**.
- Given a canceled Code Review, the sidebar shows review as paused and its continuation reopens review without
  repeating completed checks.
- Given finished delivery, when the user dismisses the panel and reopens the Session, completion is intact. For older
  Sessions, the sidebar reads confirmed completion from the current Plan.
- Given an Agent cites an existing file as a path, inline code, or relative Markdown link, clicking opens the current
  file; links from a replaced Session stop working.
- Given erased terminal contents, returning focus or pressing Ctrl+L restores the input and conversation.
- Given tool groups inside and outside the viewport, Ctrl+O toggles only the visible groups.
- Given a visible input, quitting or interrupting the TUI restores the shell without copying the input or its borders
  into terminal history.

### Agent mascots

**Scope and maturity:** Current TUI and Workspace baseline.

**Requirement: Recognizable Agent activity across surfaces.** TUI and Workspace show the same monochrome W mascot with
role animations:

- Init and Router use Base. Custom named Agents use Base.
- Guide carries the direction sign; Operator rocks a lever; Architect builds three blocks; Reviewer reads a scroll.
- Slicer uses Planner; all Engineer variants use Engineer.
- Delegated Agents use their parent's mascot, including through nested delegation.
- Recorder and Tester stay invisible.

Mascots animate during live busy work, pause for owner input or idle, and hold an answering pose when assistant text
arrives. Ideator's filled bulb means an observed answer. The written Agent identity and status stay visible. Reduced
motion, hidden tabs, unmounting, and terminal disposal stop the animation. The TUI centers the mascot in the sidebar
above the Agent label; short or narrow terminals show a compact still face.

**Requirement: Owner-controlled visibility.** The `mascot` setting is on by default; `mascot: false` hides it in TUI
and Workspace, with project settings taking precedence. The TUI `/settings` menu toggles the global setting at once;
manual edits apply after `/reload`. Hiding the mascot keeps the written identity, conversation, and input.

**Acceptance scenarios:**

- Given an Agent change, the mascot changes to that Agent's prop; a delegated invocation keeps its parent's mascot.
- Given a busy turn, the mascot animates until an answer, an owner wait, or settlement, and restarts when work resumes.
- Given Code Review approval or skip, publication clears the selected Agent. The TUI shows Base and the default
  working text, not the previous repair Agent. A real publication repair turn shows its own Agent while it runs.
- Given a terminal resize, the mascot stays centered and the conversation and composer stay usable.
- Given `mascot: false`, the rail, compact dock, and Workspace composer show no mascot; toggling back restores it.

### Request routing

**Scope and maturity:** Current baseline.

**Requirement: Match planning and checks to the request.** Router emits one **Routing Intent**:

- `INQUIRY`: Guide answers. Guide saves the answer as a Markdown document when the user asks for it.
- `IDEATION`: Ideator explores and shapes product direction.
- `OPERATION`: Operator performs a direct non-code repository or environment task.
- `QUICK_FIX`: Engineer implements bounded code work with Mechanical Validation.
- `PLANNED_CHANGE`: Planner prepares planned executable work. Work Kind (`BUG_FIX`, `FEATURE`, `REFACTOR`,
  `MAINTENANCE`, `DOCUMENTATION`) records its nature.
- `PROJECT`: Architect and Slicer shape Epic-scale work.

Only `PLANNED_CHANGE` and `PROJECT` produce Plans. After enough discovery, Router explains the chosen type of work, its
complexity, and its rationale, then hands off once to the responsible specialist.

**Requirement: Evaluate routing against fixed repository context.** Router benchmark rows can pin a full commit hash.
Each pinned row sees that commit's files in a temporary worktree that the run removes at the end; the owner's checkout
stays as it is. Rows without a pin use the current checkout. An invalid pin records a row error, and later valid rows
still run. Result files keep the pin, and resume evaluates a row again when its pin changes. A pin fixes tracked files;
conversation history, global settings, memory, and external sources are separate evaluation inputs.

**Acceptance scenarios:**

- When the user asks how code works, Guide answers; when they ask for bounded code work, Engineer implements it with
  Mechanical Validation.
- When a request needs planned implementation, Planner prepares a Planned Change; when it needs coordinated independent
  deliveries, Architect and Slicer shape an Epic. A planned bug keeps the `BUG_FIX` Work Kind.
- Given rows pinned to different commits, Router sees each row's committed files, and the dirty checkout stays
  unchanged, including after row failures or timeouts.

### Plan review

**Scope and maturity:** Current baseline.

**Requirement: Apply the user's review decision to the saved Plan.** Planner or Architect presents a saved Plan for
review. Users can approve and run, approve for later, discuss the Plan, or cancel. Epics offer Approve & Slice.
Approval leads to a readiness check; a Plan that needs repair explains what blocks it. Formatting-only changes during
review keep the decision valid. Changes to Plan meaning, code, execution policy, or workflow evidence require review of
the current Plan.

**Requirement: Reply or revise in Plan review.** Planner or Architect replies in chat to explain, clarify, or ask back.
It revises the Plan and calls `plan_written` when the answer changes scope, behavior, a decision, or verification; when
in doubt, it revises. A reply-only turn writes nothing to the Plan file. RunWield keeps the same review and conversation
open after the turn without requiring another tool call. A long turn has no review timeout. These rules apply to
initial, direct saved-Plan, `/plan-review`, Epic, and Sequence reviews.

Opening review or discussing a Plan preserves its status. A meaningful revision by the Agent or a saved owner edit
returns an `approved`, `ready_for_work`, or `ready_for_decomposition` Plan to `draft`. Formatting-only changes preserve
its status. An Agent error or canceled turn appears in chat and RunWield restores the review. Explicit review
cancellation, including Escape while the Agent works, ends the review without reopening it.

**Requirement: Keep approval context.** Review input still queued at approval goes to the execution Agent or Slicer.
The browser queue and approval warning follow
[Workspace Browser Plan review](runwield-workspace-prd.md#browser-plan-review-and-workflow). Send Annotations is not a
review action when chat is available. A standalone surface without chat retains that feedback action.

**Requirement: Settle embedded Plan Questions on approval.** Browser approval replaces each valid `wld-question`
block in the reviewed Plan with its question and answer in place. An owner answer is marked “answered in review”. An
unanswered question uses its recommended default, marked “recommended; not answered in review”. Without a default, it
records “Not answered. Engineer decides.” This happens before the approved Plan is saved, for both approval actions.
Feedback leaves question blocks available for the planning conversation. Invalid blocks stay unchanged. The bundled
Agents do not write these blocks; local Planner instructions can opt in. Sequence approval applies the same settlement
rules to each reviewed document, including child Plans.

**Requirement: Discuss an Epic with Architect during review.** While an Epic is open for review, the user can chat with
Architect on the review page across rounds in the same live Session. Architect can reply without editing or revise
the Epic on the same page. Only approval or cancellation ends the conversational review. A model turn starts when the
user sends a message.

**Requirement: Open saved Plans directly for review.** Loading a draft, approved, or ready-for-work Plan with
a valid execution policy offers direct Plan Review. Users inspect and annotate the saved Plan, and the decision follows
the normal review flow.

**Requirement: Return to the most recent Plan review.** `/plan-review` returns the link to the Session's live review.
When the Session is idle, it opens the Session's most recently presented Plan for a new decision after checking its
identity and review eligibility. A Session with no earlier review, a busy Session, or a changed Plan receives an
explanation.

**Requirement: Keep long review waits responsive.** Plan Review can stay open for a long time. The waiting Session
stays light, terminal animations pause during human input, and the decision continues the same Session.

**Acceptance scenarios:**

- Given an Epic open for review, the user exchanges two messages with Architect and both replies stay on the review
  page; the review stays open until an explicit review action.
- Given a draft, approved, or ready Plan in review, when the owner asks a question and the Agent only replies, the
  Plan file and status stay unchanged, and approval remains available on the same page.
- Given an approved, ready-for-work, or ready-for-decomposition Plan, a meaningful Agent revision or saved owner edit
  returns it to draft. Formatting-only changes preserve the status.
- Given a conversation turn that finishes without `plan_written`, including an Agent error or canceled turn, RunWield
  restores the review with the same conversation and shows any error. Explicitly canceling the review does not restore it.
- Given a direct saved-Plan, Epic, or Sequence review, reply-only turns keep review available and approval keeps its
  existing readiness, group decision, and Agent handoff behavior.
- Given queued review input at approval, the next Agent receives that context.
- Given two valid Plan Questions, one answered and one open with a default, browser approval saves the owner answer and
  the recommended answer with their labels, with no raw question fences. Approval still rejects a changed Plan and
  applies a repeated decision only once.
- Given a Plan Question without an owner answer or default, approval records that Engineer decides. Feedback instead
  keeps the block in the saved Plan.
- When the user approves for later, the Plan waits; when they approve and run, readiness is checked first.
- Given an open review, when a commit hook reformats the Plan, the decision still applies; a change to instructions,
  code, links, or execution policy requires a new decision.
- Given a ready-for-work Plan, when the user loads it and chooses **Review plan**, the saved Plan opens for review
  directly.
- Given an earlier review and an idle Session, `/plan-review` opens the current saved Plan for a new decision.
- Given a Sequence saved in its planning worktree, reopening its review checks the group against that worktree.
- Given Plan Review open in a browser for a long time, returning to submit a decision continues the same Session.

### Plan authoring and external adoption

**Scope and maturity:** Current baseline. The
[Plan lifecycle reference](../plan-lifecycle.md#plan-body-ownership-and-external-adoption) describes the mechanics.

**Requirement: The user owns the Plan body.** Users edit Plan prose with any tool, at any time, in any style. RunWield
owns the lifecycle metadata and keeps the user's current body intact through metadata repair, failed transitions, and
rollback. Saving content protects edits made since that content was opened. Changes to the intended work follow normal
Plan review.

**Requirement: External Markdown Plans are first-class.** A plain Markdown file in `docs/plans/` is a valid draft.
Listing, browsing, and inspecting it leave its bytes as they are. Deliberate `/load-plan` adoption adds identity and
defaults and keeps the body and the file's original age. Loading an adopted Plan again keeps its lifecycle and
decisions.

**Requirement: Generated Plans are easy to read.** Planner starts each section with its main point, keeps one idea per
short paragraph, and uses lists for separate points. Implementation Steps and the Verification Plan stay exact. Planner
can mark the few points a reader must not miss with a WARNING, NOTE, or TIP callout. Callouts are optional authoring
guidance; Plans in any style stay valid. New Plan filenames and headings are descriptive, without ordinal prefixes.
Child sequence belongs in Front Matter `order`. Reordering keeps filenames, Plan IDs, and dependency references stable;
existing numbered filenames remain valid. Top-level menus keep status/type priority. Child menus and child-filtered
completions use numeric `order`, independent of filenames and status. Display fallbacks for missing or equal orders do
not authorize automatic execution.

**Requirement: Domain reasoning fits the user's project.** For changes that affect domain behavior, Architect and
Planner identify the relevant concepts, identities, rules, owners, consistency needs, and external translations in the
project's own language and conventions. Architect sets the relationships and trade-offs; Planner carries the affected
rules into implementation and verification. The depth follows the change's needs and risk. This works for any
software type and language with the project's existing artifacts and architecture.

**Requirement: Architectural commitments are supported by evidence.** During Epic design, Architect explains each
consequential commitment, the cost of changing direction later, and the assumptions that could invalidate it. It
recommends a path from available evidence and focused experiments, justifies added flexibility, and records the
conditions for reconsideration. Routine choices receive brief treatment; individual ADRs follow the project's policy.

**Acceptance scenarios:**

- Given an external Plan without metadata, a listing or board shows it unchanged; loading it adopts it with its prose
  intact.
- Given `/load-plan` without an argument, the picker lists local Plan documents; Cancel leaves everything as it was.
  Selecting a Plan starts its load and recovery flow.
- Given a body edit during a metadata transition that fails, the latest body remains.
- Given malformed lifecycle metadata, recovery repairs RunWield's own state and keeps the user's prose.
- Given an adopted Plan, loading it again keeps its age, identity, and decisions.
- Given a new Plan from Planner, each section leads with its point, the key risk is easy to find, and every step and
  verification item is exact.
- Given new child Plans, their filenames have no generated ordinal prefix; changing only `order` changes child menu
  position without changing their paths, Plan IDs, or prerequisite references.
- Given an existing numbered child draft, regeneration keeps its path when it is the unique legacy name match;
  ambiguous matches and attempts to regenerate non-draft children are rejected before writes. Filename digits never
  supply missing order metadata.
- Given top-level Plans with explicit orders, their menus retain status/type priority; child-filtered completions use
  child order instead.
- Given a change to domain rules, the Epic or Plan names their owners and consistency needs and carries them into
  verification in the project's conventions.
- Given a consequential architectural choice, the Epic names affected dependencies, lasting effects, and what changing
  direction would involve. A proposed experiment states its observable result, its effect on the recommendation, and
  whether its code is disposable.

### Plan lifecycle

**Scope and maturity:** Current baseline. A status is not evidence that every validation journey succeeds. The
[Plan lifecycle reference](../plan-lifecycle.md) defines each technical status.

**Requirement: Distinguish readiness, validation, delivery, and manual acceptance.** Plan status tells users whether
work needs review, can start, is running, needs recovery, or is complete. Users can tell apart drafts,
approval, readiness, work in progress, implementation, review, delivery, manual acceptance, failure, and hold. UI, CLI,
Plan documents, dependencies, and Work Records use the same meanings.

The ordinary lifecycle is `draft → approved → ready_for_work → implemented → reviewed → verified`:

- **Implemented** means the work is done and validation is in progress or pending.
- **Reviewed** means review passed and delivery is pending.
- **Verified** means the reviewed work reached its recorded landing branch, or passed verification in place in a
  non-Git project.

Lifecycle rules:

- Planned Change Plans reach `ready_for_work` after approval and readiness.
- PROJECT Epics reach `ready_for_decomposition` after approval; Slicer finalization moves them to `ready_for_work` for
  child selection. Epics are containers; their child Plans execute and validate independently.
- `on_hold` pauses work and resumes from the previous stage.
- Board actions follow the same rules as CLI and TUI actions.

**Requirement: Conversation is not a Plan Status.** Review chat alone does not change status or write Plan front
matter. Legacy `feedback` and `in_review` Plans read as `draft` in every surface, including Epic, Sequence, dependency,
and load-plan paths. No user migration is needed. A later write uses `draft`. The board has no Feedback column or
manual `feedback` target. Review revisions follow [Plan review](#plan-review).

**Requirement: Record the owner's acceptance as User Verified.** Users can mark a Plan `user_verified` with a
verification note. This satisfies dependencies and Epic completion and stays visibly distinct from RunWield
verification. User Verification ends the execution workflow and carries the accepted Plan and note to the primary
checkout. RunWield asks before it removes the execution worktree; declining keeps the checkout, and Archive asks again.
Unmerged branch commits stay recoverable. A User Verified Plan can be archived when no recoverable work would be lost.
User Verified and RunWield Verified Plans share one terminal menu: Archive, Re-open for review, View, and Cancel.

**Requirement: Archive without blocking the conversation.** After required confirmations, Load Plan runs Plan and
Epic archive writes and retention checks in the background. It reopens the Load Plan menu with pending archives
excluded, so the user can select another Plan without waiting. If no Plans remain, it returns to chat. It reports
completion or failure in the conversation. A repeat request for the same pending archive does not start a second archive.

**Requirement: Deliberate closure.** Users can mark an Epic done enough, with a summary, when its delivered children
meet the goal; this records a done-enough completion. `closed_without_verification` records the user's deliberate
abandonment of the remaining work. Both outcomes keep unfinished work available and are labeled as distinct from
verification.

**Acceptance scenarios:**

- Given a saved `feedback` or `in_review` Plan, the board and load-plan show and handle it as draft without changing
  its bytes on read. A later write saves draft.
- Given five reply-only review turns, the Plan file and status are unchanged.
- Given implemented work whose delivery failed, the Plan shows validation and publication as separate outcomes and
  offers a recovery action.
- Given a Plan marked User Verified with a note, dependency and Epic checks accept it, and every view labels it
  distinctly from RunWield verification.
- Given a Plan in an execution worktree, User Verification saves the Plan and note in the primary checkout, asks to
  remove the worktree, and generates the Work Record. Reloading offers the shared terminal menu.
- Given the user declines worktree removal, the execution files stay; Archive asks again.
- Given a confirmed Plan or Epic archive waiting for storage, Load Plan reopens its menu before the write completes,
  excludes pending archives, and reports the result later. If no Plans remain, it returns to chat. A repeat request
  reports that the archive is already running.
- Given a background archive that fails, the conversation reports the failure and does not claim completion.
- Given the user closes a Plan without verification, the Plan records that outcome and its reason.
- Given an unpublished workflow, User Verification labels it unpublished, and a canceled turn keeps the workflow open.

### Epic decomposition and hold

**Scope and maturity:** Current baseline. Automatic Epic publication is target scope in
[Epic Branch Publication Workflow](../plans/epic-branch-publication-workflow.md).

**Requirement: Deliver independent children and preserve paused work.** An Epic is a larger outcome whose child Plans
ship independently. After Epic approval, Slicer discusses boundaries, dependencies, priorities, and a useful MVP with
the user. **Write a draft** saves reviewable children; finalization makes child selection available. Each child gets its
own review and approval. The conversation can pause and resume. `load-plan` offers the right planning, decomposition,
child selection, execution, or recovery action and explains unfinished dependencies. `wld plans` shows Epic progress and
child status separately from standalone Plans. While a child's publication is pending, loading the parent Epic shows
that state and offers the child's publication continuation. Changed child scope after an Epic revision needs the user's
review.

**Requirement: Every Epic starts and ends on its own branch.** Architect names an Epic branch, by default
`epic/<epic-name>`. Children deliver to it, so the primary branch receives the Epic only when it is ready. When the Epic
first needs the branch, RunWield creates it from the latest primary branch, records that start, and puts the child
drafts on it while the user's checkout stays as it is. An existing branch keeps its history. Epics whose children
started before Epic branches existed keep their earlier behavior.

**Requirement: Load children from the Epic branch.** Once the Epic branch exists, `/load-plan` uses it for child
membership, names, and published content, not the current checkout. This includes an existing default Epic branch when
its name is not yet recorded on the Epic, even if children have already started. Loading does not publish stale
checkout drafts. A published rename keeps the child's stable identity and compatible saved planning edits. Active
execution keeps its own document authority. If a child has no Plan ID when its session starts, Core creates one during
worktree preparation and saves it in the child's planning document. Later sessions reuse that identity and worktree.
Before successful worktree creation, the Epic branch or primary checkout owns the Plan document. After creation, the
worktree owns the document, even if the source copy changes or is removed. The registry owns attempt metadata keyed by
Plan ID; it does not replace document content. A failed creation that was rolled back does not transfer document
ownership.

**Requirement: Child selection reflects the authoritative document.** When the primary checkout is on the Epic target
branch, child discovery and selection include its local edits and valid untracked child Plans. On any other branch,
checkout files do not enter the target family. Registered planning and execution documents retain their content,
lifecycle, and order authority; a saved planning document does not restore a child removed from the target catalog.
The picker shows distinct child-relative paths without repeating the Epic parent prefix and orders children by explicit
Front Matter `order`, never filename prefixes. Mixed numbered and descriptive child names follow that same rule,
including when statuses differ. Generated integration repairs take their next order from child metadata, including
children available only on the target branch, not from filename digits.
Missing or duplicate order blocks the next-child shortcut and automatic continuation with a clear explanation; manual
selection and reading remain available.

**Requirement: Each child starts with the preceding children's published code.** Before the next child is prepared,
Core fetches the latest Epic branch. The child's planning worktree starts from, or imports, that commit while keeping
its saved scope and status. The refreshed commit is the child's baseline. If the Epic history was rewritten, Core
carries only the child's planning changes onto the current target and retains the old planning head for recovery.
Committed files that already match the published target do not block refresh. Unpublished implementation changes are
never discarded. A failed fetch keeps continuation recoverable.

**Requirement: A child worktree starts only with a session.** Core creates a child's planning worktree only when
planning, review, re-review, execution, or automatic continuation starts a session in that child. It starts from the
latest fetched Epic branch. Plan location lookups are pure. Loading, selecting, viewing, canceling, pushing, or sharing
never creates a child worktree. A session-less write to an unstarted child without a worktree is refused: start planning
first, with no changes to the Plan or Git state. All Plans use the same session-start preparation, including standalone
Plans with a recorded delivery branch. Existing planning worktrees are reused and refreshed; no automatic cleanup
removes worktrees created earlier.

**Requirement: Children are slices, and their boundaries can move.** A child moves the Epic forward; it need not be a
finished feature by itself. Planner plans each child just before it runs and can reshape any unstarted sibling: move
scope in or out, or split a new draft. A reshaped sibling that was approved returns to draft. Started and validated
children keep their scope. Core carries compatible edits into an unstarted sibling's planning worktree; only
conflicting requirements or started work need the user's decision.

Each child's review judges that child's own correctness, with the Epic as context. A reviewer can leave Integration
Notes for the later integration review in the Epic's `### Integration Notes` subsection. The saved-note message names
the parent Epic and states that the notes guide its integration review. Integration Notes and confirmed child deviation
blocks are written in the child's execution checkout and travel with its delivery to the Epic branch, not through a
write to the primary checkout.

**Requirement: An Epic finishes through its integration gate.** The Epic is implemented when every included child is
delivered to the Epic branch. The integration gate then checks the exact branch head as one change: the project's
checks, an integration review of the whole Epic diff, and Code Review per the user's `codereview` setting. Before
checks or review, the temporary checkout initializes submodules recursively and runs the configured
`worktree_setup_command`. Both reviews use the Epic document from that exact branch head, not the primary checkout.
Missing branch requirements or failed checkout setup pause the gate without creating a repair child. A pass
marks the Epic reviewed for that commit. Integration review treats confirmed child deviations as user-approved
replacements: a gap caused only by a deviation is not a finding. It names each affected Epic outcome and source child
in an advisory. Defects unrelated to the deviation, and work its replacement requires, remain findings.

The gate keeps a persistent Review Issue Ledger with stable finding IDs. Its first tracked review checks the whole
Epic; later reviews confirm or reject open IDs and check only changes since the last checked commit for regressions.
Reports and repair children retain those IDs and rejection reasons. Before the third review, findings create a draft
repair child that the user reviews like any child. From the third review onward, RunWield asks the user to plan another
repair, review the whole Epic in Code Review, or stop. Code Review takeover requires passing project checks. Approval
records the user's decision, not AI approval; open AI findings remain in the ledger. Code Review change requests create
a repair child without another limit prompt. An unanswered prompt pauses with the report and ledger saved. Existing
Epics without saved review state count their earlier integration repair children toward the limit; their first tracked
review still checks the whole Epic to establish the ledger.

A later commit on the Epic branch returns the Epic to implemented. The ledger and round count persist, and the next
review verifies findings and the new changes. The user merges the reviewed Epic branch or opens a pull request. Child
manual checks are collected in an advisory [Manual QA checklist](#manual-qa-checklist) for the Epic.

If an implemented Epic is blocked only by gate-created repair children still in draft, its load-plan menu offers
**Retry the integration gate** and names the drafts and report. A passing retry closes all open repair drafts without
verification, with a reason that names the checked commit; it does not delete them. New findings replace the newest
draft's Findings and checked commit while preserving its identity and other sections. A pause leaves drafts unchanged.
A started repair or any undelivered non-repair child blocks retry. The automatic gate still requires every child to be
settled; it does not skip repair drafts.

**Requirement: Hold and resume.** **On hold** means paused and resumable. A held Plan keeps its previous stage and an
optional reason. **Resume from hold** checks for relevant changes or missing work, then resumes, warns, or offers
recovery choices. **Reset status to draft** keeps the Plan body and offers to keep unmerged work; deleting work needs
confirmation. Holding an Epic pauses access to its children and keeps their statuses; resume the parent before working
on a child. A child held on its own stays held after the parent resumes. Holding one child leaves its parent and
siblings active. Listings show held work separately from active and finished work.

**Acceptance scenarios:**

- Given a new Epic without its branch, starting the first child creates the branch from the latest primary branch with
  the Epic requirements and child drafts on it; the user's checkout is unchanged. Branch preparation adds a missing Epic
  document but does not replace requirements already on the branch with a primary-checkout copy.
- Given Planner renumbers children on the Epic branch, `/load-plan` lists the new names, excludes removed names, and
  opens the selected branch Plan without restoring stale checkout drafts. A renamed child's saved planning edits stay
  in its planning worktree.
- Given an existing default Epic branch and completed children, but no recorded Epic target, `/load-plan` lists that
  branch's current children and opens its next child, not a stale primary-checkout name.
- Given the primary checkout on the Epic target branch, a local child order edit and an untracked new child appear in
  the picker and selection opens those same documents. A known older remote snapshot does not hide them. First Resume
  planning transfers only the selected Plan to its registered planning worktree, assigns a missing ID on the copy, and
  uses the latest target snapshot for code. Source files and the target branch are unchanged; no draft is published.
- Given nested children `epic/frontend/setup` and `epic/backend/setup`, the picker shows `frontend/setup` and
  `backend/setup`, not identical `setup` labels or the repeated Epic prefix.
- Given missing or duplicate child order, the picker explains the ambiguity and offers no next-child shortcut;
  automatic continuation blocks, while viewing an individual child still works. Filename numbers never resolve the tie.
- Given an unstarted child, loading, selecting, viewing, or canceling creates no worktree and changes no Git refs.
- Given completed Slicer decomposition, resuming a draft child in the same Session opens its planning worktree with
  Planner active. The handoff does not reload or restore the Epic-scoped Slicer as a selectable Agent.
- Given a target-branch child without a Plan ID, starting its session creates a durable identity and planning worktree.
  Repeated or concurrent session preparation reuses both without changing the primary checkout or publishing to the Epic
  branch.
- Given an unstarted child without a worktree, holding or pushing it without starting a session says to start planning
  first and changes nothing.
- Given a failed creation that removed its worktree before it saved an identified Plan, session start retries from the source
  automatically. A stale ownership reference from that failed creation does not block the retry.
- Given an established planning document, loading keeps its saved contents and identity even when its source copy is
  removed. A missing established document is not replaced by an older source copy.
- Given AI review rejects a child and repair then passes validation, continuation opens the next child once. A reply
  that completes the repair succeeds and returns the replacement Session, without retrying the closed child Session.
  Direct validation also continues once.
- Given a child published from another checkout, preparing the next child includes that publication.
- Given the next child already has a planning worktree with saved edits, continuation imports the published code and
  keeps those edits.
- Given the Epic branch was rewritten after the next child's planning worktree was created, continuation moves that
  worktree onto the new Epic branch, keeps saved scope and status, and does not merge the replaced code history. A retry
  settles the same refresh.
- Given saved committed changes whose files already match the published Epic branch, continuation imports publication
  and keeps saved Plan edits instead of reporting implementation changes.
- Given unpublished implementation changes in that child worktree, continuation preserves them and refuses the planning refresh.
- Given conflicting saved scope, continuation preserves both versions without leaving an unfinished merge.
- Given a last child that has validated but not finished publishing, the Epic is not yet implemented.
- Given all children delivered, a passing integration gate marks the Epic reviewed for that branch head; the primary
  branch is unchanged.
- Given a fresh gate checkout with submodules and a configured setup command, submodules are initialized before setup,
  and setup completes before checks or review. Setup failure pauses the gate and removes the temporary checkout.
- Given different Epic requirements in the primary checkout and checked branch, review uses the checked branch document.
  If that document is missing, the gate pauses instead of using the primary copy.
- Given gate findings before the third review, the report and draft repair child list stable IDs; delivery runs a
  verify-only review that confirms or rejects those IDs and checks the repair delta for regressions.
- Given a verify result that omits an open ID, the gate requests a verdict on that ID instead of accepting the result.
- Given findings at or after the third review, no child is created before the user chooses. Another repair creates one
  child or updates the newest open repair draft; stop or no answer pauses with the report and ledger saved.
- Given passing checks at the review limit, the user can approve the whole Epic in Code Review. The Epic becomes
  reviewed with human takeover evidence, not AI approval. Failing checks exclude that choice.
- Given Code Review changes at any round, a repair child carries them without another limit prompt.
- Given an Epic with two earlier integration repair children and no saved review state, its first tracked full review
  counts as round three and findings require a user decision.
- Given an implemented Epic blocked only by an unstarted gate repair draft, including a draft only in the primary
  checkout, load-plan offers **Retry the integration gate** and names the draft and report. A passing retry marks the
  Epic reviewed and closes the draft without verification with a reason that names the checked commit.
- Given new findings on a retry, the newest open repair draft receives the findings and checked commit without a new
  child. Its Plan ID, order, status, target, and other sections stay unchanged. A paused retry changes no draft.
- Given a started repair child or an undelivered ordinary child, no retry option is offered. An open repair draft still
  blocks the automatic gate.
- Given Planner moves scope into an approved, unstarted sibling, the sibling returns to draft with the change.
- Given a child review with Integration Notes, the notes appear in the execution checkout's Epic subsection, travel
  with child delivery, and reach the branch-head integration review; the primary copy is unchanged.
- Given a delivered child deviation that removes an Epic outcome, integration review reports the outcome and source
  child as an advisory, not a finding. Other integration defects still block approval.
- Given an approved Epic, saved draft children stay drafts until finalization and their own approval.
- Given an independently held child, holding and resuming the parent leaves it held.
- Given enough delivered children to meet the goal, the user marks the Epic done enough and the remaining children stay
  visible.

### Execution, validation, and recovery

**Scope and maturity:** Current execution and validation baseline, with the owner's completion and automatic recovery
requirements. These requirements are the target for every failure path; they do not certify that every current path
already meets them. QUICK_FIX keeps its lighter behavior: Engineer implements without a Plan and RunWield runs
Mechanical Validation. The two-conclusion rule applies to delivery workflows; answering a question is a conversation.

```mermaid
graph TD
    A[ready_for_work] --> B[Isolated worktree]
    B --> C[Implementation]
    C --> D[Verification Command]
    D --> E[AI review]
    E --> F[Code Review]
    F -->|approve or skip| G[Publication]
    G --> H[verified]
    D -->|fails| R[Repair]
    E -->|findings| R
    F -->|patch changed| HR[Owner-requested repair]
    HR --> HC[Verification Command]
    HC --> F
    HC -->|fails| HR
    F -->|reply only| F
    R --> D
```

#### Workflow completion and automatic recovery

**Requirement: Publish successfully or end only by deliberate user abandonment.** RunWield carries an accepted delivery
workflow to confirmed publication unless the user chooses to abandon it. Failed checks, retry limits, internal errors,
canceled turns, waiting for a decision, and hold are recoverable intermediate conditions. Through all of them the
workflow, its work, and its continuation path stay available. A pause for approval, an external prerequisite, or a
user-requested hold keeps the same work and its next step.

**Requirement: RunWield repairs its own machinery automatically.** Locks, settings, storage, lifecycle metadata,
registries, and Plan synchronization are RunWield's responsibility. RunWield diagnoses, reconciles, repairs, and
continues automatically and out of the user's view. Detailed diagnostics stay available for deliberate support
inspection. Automatic repair keeps user content, truthful validation, real permissions, and user decisions intact. It
confirms the outcome of an uncertain external action before it repeats that action.

**Requirement: Treat an unknown state as live.** Automatic repair keeps a lock, run, worktree, Session, or publication
attempt when it cannot get a positive answer about that item. An empty, unreadable, timed-out, truncated, or unknown
result means "could not tell". It does not mean "dead", "finished", "clean", or "passed". RunWield never releases,
reaps, takes over, or retries an item because a query was empty or failed. It never reports success on that basis.

**Requirement: Test success requires current execution evidence.** RunWield's own isolated test runner counts a file
as passing only after a successful process exit and a fresh report of executed tests. Missing or empty evidence fails
validation; explicitly skipped tests remain skipped. Reusing a report directory cannot reuse evidence from an earlier
invocation, including for files that fail-fast leaves unexecuted.

**Requirement: Ask only for an outcome-level decision or a genuine external prerequisite.** When the user must act,
RunWield explains what happened, what it is protecting, what is missing, the action the user can take, what Retry will
continue, and what each choice means. It offers deliberate abandonment with work preserved at the safest recoverable
point. Commands are copy-ready with real values. Waiting for the user's action stays part of the open workflow.

**Acceptance scenarios:**

- Given two Plans and a missing execution document for one, catalog reads and validation identity preparation for the
  other succeed. Neither operation changes the missing Plan's primary copy or registry entry.
- Given that missing document, loading its Plan reports the exact execution path and does not use the primary copy.
- Given a new Plan, identity assignment does not reuse the registered ID of a Plan whose execution document is missing.
- Given a same-name catalog copy and another Plan sharing its registered ID, authority replacement or removal selects
  the same-name copy regardless of filesystem order. With available authority, identity preparation and explicit
  backfill reject the collision without changing either document. Missing or archived authority hides only its own
  copy. Renamed Plans retain identity-based discovery when no same-name copy exists.
  **Requirement: Continue Attached delivery through the shared completion authority.**

After accepted semantic review, Attached validation continues automatically into configured Code Review, recording, and
publication, as Core execution does. It does not stop at `awaiting_delivery`. Saved child 05 `reviewed` records resume
the same delivery flow. Shared publication owns sealing, landing-branch proof, lifecycle settlement, and cleanup;
Attached coordination does not create a second publication authority.

Git Verified and Attached `delivered` closure require shared publication proof. Passed local checks, staged metadata,
host prose, or a successful subprocess alone are not proof. Non-Git work keeps consented shared in-place completion, not
Git publication; its host recording runs before Verified. An interruption retains Plans, work, records, and useful
recovery evidence. Recovery reconciles uncertain effects and does not repeat accepted work. Failed publication, retry
limits, cancellation, and quota loss leave continuation available, not automatic abandonment.

Attached delivery starts no Core model turns and needs no RunWield model preset. The external host owns Recorder and
repair reasoning. Core keeps its existing Recorder and Manual QA turns. Attached skips Core Manual QA, including the
Epic-child checklist artifact; its host can suggest checks after delivery without saving them or claiming they ran.
[Connect](runwield-connect-prd.md#shared-plan-and-verification-outcomes) owns the host interaction requirements.

**Attached delivery maturity:** Automated real-Git and fresh-process checks cover shared delivery and recovery. The
integrated Claude headless result, tested source identity, permissions limits, and Preview release boundary are owned by
[Connect Preview Acceptance](runwield-connect-prd.md#preview-acceptance). Attached review chat uses the host
conversation and restores pending turns after process loss; see
[Connect review experience](runwield-connect-prd.md#shared-plan-and-verification-outcomes). Core review chat keeps its
existing repair Agent behavior.

**Acceptance scenarios: Attached completion and recovery.**

- **Shared automatic continuation:** Given accepted semantic review or a saved child 05 `reviewed` record, Attached
  continues into Core's configured delivery gates without an `awaiting_delivery` stop or a separate delivery command.
- **Proven Git closure:** Given no publication proof, Attached cannot report Verified or close as `delivered`. Shared
  proof of landing permits both outcomes; it does not claim an onward merge from a Plan Branch.
- **Non-Git completion:** Given consented non-Git work, host recording precedes shared in-place completion and Verified.
  The result makes no Git publication claim.
- **Saved-point recovery:** Given interruption at Code Review, recording, accepted sections, sealing, publication, or
  cleanup, a fresh process resumes from durable evidence without repeating accepted effects. Uncertain publication is
  reconciled before retry. Recoverable work and artifacts stay available.
- **No hidden model turn:** Given Attached delivery without RunWield presets, all repair and Recorder calls use the
  external host. No Core Recorder or Manual QA turn starts, and no Attached checklist artifact is saved. Core execution
  retains its own post-verification turns.
- Given stale locks, inconsistent settings or storage, or mismatched Plan bookkeeping, RunWield restores its own state
  and continues.
- Given a restarted process or a reused PID, validation compares process birth evidence with its saved owner and
  resumes the preserved checkpoint when the original owner is provably gone. A live matching owner still excludes
  another validation run; unavailable process identity evidence never authorizes takeover.
- Given a lock whose run status query returns an empty or unreadable result, recovery keeps the lock and the work
  continues.
- Given a freshness or status check whose fetch fails or times out, RunWield does not report the checkout as current
  and does not act on that result.
- Given a previously passing test file replaced by an early successful exit or no tests, the next test run fails
  and does not retain the previous passing report.
- Given a file containing only explicitly skipped tests, the runner reports it as skipped rather than passed.
- Given exhausted automatic attempts, the same workflow stays open and recoverable.
- Given a genuine external prerequisite, the user receives a specific action plus Retry and abandonment choices; Retry
  continues the preserved workflow.
- Given a partially completed external operation, recovery establishes its outcome before retrying and reports only
  proven rollback or publication.
- Given publication pauses after automatic recovery, the Session shows the failure once with its cause, the preserved
  work, and a relevant next action.
- When the user deliberately abandons, RunWield ends the workflow with that outcome and keeps unmerged work unless
  loss-free cleanup is proven or the user authorizes deletion.

#### Execution worktrees and preparation

**Requirement: Execute approved work in isolation.** Executable Plan work starts from `ready_for_work` in an isolated
worktree. The user's checkout changes stay as they are, and execution keeps a useful recovery point.

**Requirement: Prepare the worktree before Agent work.** RunWield runs the project's `worktree_setup_command`, or a
command the user confirms, before the first commit that runs the project's Git hooks. When hooks exist and no command
is configured, RunWield asks for a setup command or confirmation that fresh worktrees need no setup. Confirmed
answers and retry corrections are saved in project `.wld/settings.json` beside `verification_command`. An empty
`worktree_setup_command` means no setup is needed. The project default applies when a checkout has no explicit
override. Agent work starts after setup succeeds. A failed or canceled setup leaves the Plan ready, keeps the worktree and its output for retry, and keeps
setup output out of the preparation commit. Completed setup runs once per worktree, across Session resumes.
Unrelated working-file and staging changes, including partial staging, count as implementation work and stay out of
the preparation commit.

**Requirement: New worktrees carry the project's setup context.** New planning, execution, and Tutorial worktrees
receive the primary checkout's uncommitted `.wld/settings.json`, `docs/domain-language.md`, and RunWield's managed
`.gitignore` block. RunWield merges compatible target-branch changes to those files and reports conflicts before it
creates the worktree. Reused worktrees keep their own copies. Later edits to these files count as implementation work.
At publication, unchanged Init output and RunWield's own settings writes land with the Plan; unrelated user edits stay
protected. If local publication fails or is interrupted before integration, RunWield restores the original setup
files and staging for retry.

**Requirement: Planning uses relevant pending changes.** Planner and Architect inspect pending changes, use relevant
evidence, and leave unrelated edits out of discussion and Plans. A dirty checkout is ordinary context.

**Requirement: Planning work carries into execution.** Draft Plans, parent Epic edits, and metadata updates made in a
reused planning worktree carry into execution as part of its starting baseline. Planning checkpoints and target refreshes
do not run project Git hooks or require dependency setup. This exception applies only to planning; execution preparation
and implementation commits still run the project's hooks.

**Acceptance scenarios:**

- Given a confirmed setup answer or retry correction, project settings retain it for future worktrees without changing
  the verification command or unrelated settings. A checkout-specific setup override wins over the project default.
- Given Init discovery, the user confirms verification and setup independently or together; the same save tool preserves
  omitted commands. Canceling either choice leaves Init incomplete, and older projects can rerun Init to supply a
  missing setup choice.
- Given a fresh planning worktree with dependency-backed Git hooks, opening a child without a Plan ID saves its new
  identity without installing dependencies or running hooks. Refreshing the target preserves saved planning edits under
  the same rule. Normal commits still run the hooks.
- Given a dependency-backed Git hook and an approved setup command, setup runs before the first execution preparation
  commit, the hook passes, and one execution preparation commit precedes Agent work.
- Given failed setup, the Plan stays ready and the worktree and diagnostics remain; a corrected retry continues that
  attempt.
- Given a prepared worktree, resuming keeps its baseline without a second setup or preparation commit.
- Given completed Init with uncommitted settings, glossary, and ignore rules, a new execution worktree contains them
  before Engineer starts, and Mechanical Validation uses the confirmed command.
- Given uncommitted Init output in the primary checkout, local delivery lands the validated versions with the Plan and
  keeps unrelated user edits.
- Given conflicting context edits on the target branch, worktree creation stops and both versions remain.
- Given existing checkout edits, starting execution isolates the approved work and keeps those edits.
- Given a reused planning worktree with Epic edits and draft Plans, execution preparation keeps them and starts.

#### Plan deviations

**Requirement: Plan deviations are always available during execution.** Plan Engineer, Frontend Engineer, and the
Validation Repair Engineer can record a Plan deviation in every collaboration style and Execution Backend, including
after Session restore, compaction, segment handoff, and validation repair. Recording requires an active execution Plan
and checkout. Execution ownership starts with the first execution turn and survives restore; an explicit clear, pause,
or Stop also survives.

**Requirement: Deviations need explicit confirmation.** A Plan requirement changes after dedicated user confirmation
records the superseded requirement, its replacement, and an optional reason in the execution Plan. Confirmed
deviations survive reload and take precedence over the original text in execution, Semantic Review, and Work Records.
Retrying the same call returns the saved entry. Ordinary feedback and direct Plan edits remain ordinary input.
Canceled, unsupported, or stale confirmation leaves the requirement as it was; a changed Plan revision or execution
identity invalidates a pending confirmation. A host without confirmation support keeps the work and stops the turn.

**Requirement: Epic readers see child deviations.** A confirmed deviation in an Epic child also appears in a managed
`### Child Plan Deviations` subsection under the Epic's Objective. Each child has one replaceable block. The child
Plan's `planDeviations` remains authoritative; neither the Epic's own deviation front matter nor Work Record aggregation
uses that projection as a second source. Recording and same-call retries synchronize the block in the execution
checkout. Publication retries synchronization before its checkpoints. A projection error does not revoke the saved
child entry. Missing or collaboration-locked parents are left unchanged. Standalone and Sequence Plans keep ordinary
recording without an Epic projection.

**Acceptance scenarios:**

- Given Pair or autonomous execution, when the user requests a conflicting requirement, the Agent asks for explicit
  confirmation, and acceptance records the replacement.
- Given a restored, compacted, or repair Session, the Agent records an accepted replacement in the active execution
  Plan.
- Given execution interrupted before its first checkpoint, resuming records a confirmed replacement in the execution
  checkout.
- Given a recorded replacement, reload, independent review, and the Work Record keep it.
- Given canceled confirmation or a changed Plan revision, the effective requirement stays as it was.
- Given an Epic child and accepted confirmation, both the child entry and its Epic block contain the exact superseded
  requirement, replacement, optional reason, and approval time; the Epic's front matter is unchanged.
- Given the same call retried after interruption, one child entry and one Epic block remain. A missing projection is
  restored before publication sealing.
- Given deviations from two children, replacing one block preserves the other and user-owned Objective text.
- Given canceled, unsupported, or stale confirmation, the Epic stays byte-identical.
- Given a standalone Plan or Sequence child, recording changes only the execution Plan.
- Given child delivery, its Epic block reaches the branch-head integration review and the Epic Work Record lists the
  child deviation once.

#### Validation

**Requirement: Validate the change against its checks and its Plan.** Workflow Validation runs the project's configured
checks, then reviews the change against the approved Plan. It distinguishes finished implementation from successful
validation. Failed checks and review findings are repaired in the execution worktree by a repair Agent that receives
the relevant findings and instructions. See [Semantic review and repair](#semantic-review-and-repair).

**Requirement: Confirm the Verification Command once.** Validation reuses the command confirmed during Init or an
earlier validation across execution worktrees, repairs, and resumed Sessions. RunWield asks when neither the execution
checkout nor the project has a command, then saves the answer as a project preference and in the execution checkout.
An explicit full-project command given during planning is kept with the Plan. A deliberate user selection replaces a
saved command; discovery fills only missing configuration. Exact shell syntax and checkout-specific repairs are kept.

**Requirement: One full validation run per handoff.** During managed implementation and repair, Agents run focused tests
and acceptance checks. RunWield runs the complete Verification Command after task completion, including after each
repair. Diagnosis and explicit user requests can call for earlier full runs. Standalone work keeps the Agent's own full
validation. Reports separate completed focused checks from pending full validation. Only the runtime gate permits
publication.

**Requirement: Required checks fail closed.** A required check returns failure when its checker or prerequisites cannot
load, as well as when diagnostics fail. Workspace checking resolves its project root consistently under the pinned Bun
runtime and cannot report success without running the Astro checker.

**Requirement: Validation progress is accurate.** Interrupted validation shows as paused and keeps its continuation.
Passed checks are recorded, so a restart resumes at the next phase; a code repair runs the checks again. The final
progress display comes from the confirmed validation and publication results of the current attempt.

**Acceptance scenarios:**

- Given a missing or unloadable Workspace checker dependency, `workspace:check` exits nonzero with a recovery message.
- Given an intentional Astro type error, `workspace:check` executes checking and exits nonzero with its diagnostic.
- Given no configured command, validation asks once; repair and resumed validation reuse the saved command, and the
  project keeps it after worktree removal.
- Given a managed repair, after the Agent's focused checks, RunWield runs the full command against the repair checkout;
  a failure keeps the workflow in repair.
- Given passed checks and a process restart, the Plan stays implemented and resumes semantic review.
- Given a Session that shows failed checks from an earlier attempt, a resumed delivery that publishes successfully
  reports completion with current results.
- Given failed checks or review, the user sees repair progress or a concrete recovery choice.

#### Manual QA checklist

**Scope and maturity:** Current advisory checklist generation. Automated Tester execution and QA Environment Profiles
remain deferred in the [Automated QA proposal](automated-qa-prd.md).

**Requirement: Give the owner concrete manual checks.** Checklist generation is part of the normal workflow; a
configurable QA mode remains proposed. After Mechanical Validation passes, a QUICK_FIX receives a short unchecked
checklist. Standalone Planned Changes receive it during publication preparation, after automated validation and the
applicable Code Review decision. Use the Plan's explicit manual checks first; otherwise infer the smallest observable
checks from the supplied context, aiming for one to six unchecked actions. The checklist contains manual user actions
rather than automated test, lint, type-check, or build commands. It appears in the Session and stays available in saved
history.

**Requirement: Keep Epic checks together.** Each child contributes a section to the Epic's durable Manual QA artifact
before delivery. Retries reuse its existing section and preserve user edits and checked boxes. The artifact stays with
the Epic through archive and restore.

**Requirement: Keep advice separate from proof.** The checklist describes checks for the owner to perform; generation
is not evidence that they ran. Publication proceeds without requiring completion of its items. A standalone generation
failure shows a warning and preserves successful validation. Operational failures during Epic checklist preparation
use normal publication recovery; their pause remains distinct from a failed implementation check.

**Acceptance scenarios:**

- Given a QUICK_FIX whose checks pass, RunWield shows and saves an unchecked checklist. If generation fails, it reports
  a warning while retaining the successful Mechanical Validation result.
- Given a standalone Planned Change with explicit manual checks, publication preparation turns them into a user
  checklist; the items are unchecked rather than presented as executed proof, and publication can continue.
- Given an Epic child whose checklist contains user edits and checked boxes, a publication retry keeps that section
  intact instead of replacing it or adding a duplicate.

#### Code Review gate

**Requirement: Offer Code Review before publication.** Code Review defaults to asking after automated validation
(`codereview: ask`). Explicit `none`, `ask`, and `always` settings and recorded review decisions stay authoritative.
Users can open the review, skip it, or close the offer to come back later. Closing keeps the review pending and the
implementation intact; continuing validation through `load-plan` offers the choice again.

**Requirement: Canceling a review leaves it pending.** Canceling an open Code Review, including with Escape, leaves
approval pending and records no decision or revision. The UI states that review is pending and offers Retry or Plan
resume; reopening presents a working review link. Completed checks and the implementation stay available.

**Requirement: Let the reviewed patch decide whether chat requests changes.** Engineer can answer, edit code, or both.
For Git execution, RunWield compares the full reviewed patch before and after each Code Review conversation turn, after
its own metadata writes. The patch itself decides, not the Agent's report:

- **Unchanged patch:** the conversation continues and Code Review reopens immediately with the same diff. No CI run
  starts. The review decision and timestamp, Delivery Evidence, Plan Status (`reviewed`), and CI results stay unchanged.
- **Changed patch:** RunWield records “Changes requested”, invalidates the prior approval and timestamp, records
  `changes_requested`, and returns the Plan to `implemented`. Once repair completes, RunWield records completed repair
  evidence, runs CI, skips automatic AI review, and reopens Code Review with the fresh diff and the same conversation.
  An edit that stops on a blocker keeps the repair pending; it does not reopen review over unfinished work.

A non-Git in-place project has no patch identity: every conversation turn uses the repair-and-check flow, even a
question. Non-conversation feedback from a no-chat surface also keeps that flow. Standalone Code Review (`wld review`)
is unchanged; see [Standalone code review](#standalone-code-review).

**Requirement: Scope changes need confirmed Plan authority.** If Code Review chat agrees to change the Plan's scope,
Engineer proposes a [Plan Deviation](#plan-deviations). Only dedicated owner confirmation makes the replacement
authoritative for execution, AI review, and Work Records. Agreement in chat alone does not replace the requirement.

**Requirement: Reach the live review from the terminal.** From launch until a decision arrives, the TUI shows
“Waiting for Code Review”. When the review surface is ready, the card also shows a clickable live review URL,
including for resumed and direct reviews and when the browser does not open automatically. The normal message input
is hidden during Plan review and Code Review. It returns with its draft text when review ends, including on approval,
cancellation, or failure. During Code Review, the validation progress and results card is also hidden so the review
message and live link stay visible. The card returns with its current results when review ends. The settled review
card shows the outcome.

**Requirement: Edit review policies in settings.** The `/settings` menu edits the Code Review and Guided Review policies
at project or global scope, with clear project-override behavior, and the global default project trust preference.
Guided Review keeps its `auto` option; stored review `none` is labeled **Never**.

**Acceptance scenarios:**

- Given a fresh project, the code-review offer appears before publication; explicit skip continues, no answer pauses,
  and `always` requires review.
- Given the user chooses Close and come back later, the Plan stays `reviewed`; a later `load-plan` continuation asks
  again.
- Given repeated terminal cancellation, the Plan stays `reviewed` with no recorded decision; Retry presents a working
  link, and approval records one decision.
- Given a Git-backed Plan in Code Review, when the owner asks why a change was made and Engineer only replies, review
  reopens with the same patch and approval remains available. No CI starts, no Delivery Evidence changes, the decision
  and timestamp stay unchanged, and the Plan stays `reviewed`.
- Given Engineer reports a fix without changing the patch, the turn has the same reply-only result. An edit reverted
  within the turn also leaves the patch unchanged.
- Given the owner requests a fix and Engineer completes an edit, RunWield records “Changes requested” and completed
  repair evidence, invalidates approval, runs CI, skips AI review, and reopens Code Review with the new diff and earlier
  conversation.
- Given a non-Git in-place project, a chat question still starts repair and CI because patch identity is unavailable.
- Given a no-chat review surface, submitted feedback still starts repair, checks, and another Code Review.
- Given chat agreement to drop a Plan requirement, the original requirement remains authoritative until the owner
  confirms a Plan Deviation. Canceling confirmation leaves it unchanged.
- Given policy edits, they survive reload; a global edit leaves an explicit project override in place.

#### Delivery and publication

**Requirement: Deliver validated work to its target and confirm it.** RunWield delivers validated work to its
configured target and confirms the outcome before it reports delivery. The execution Plan's current target applies to
every validation phase and to publication. The committed Plan records the validated commit and the actual target
branch, so delivery stays recognizable from Git. In non-Git projects, the completed status is enough.

**Requirement: Keep standalone Plan delivery separate from the onward merge.** `plans.autoMergeIntoTargetBranch` is off
by default; project settings take precedence, and users choose Off or On in `wld settings`. For standalone
PLANNED_CHANGE Plans, `targetBranch` is the source and intended destination; an untargeted Plan records the repository
default branch.

- **Off:** RunWield creates or reuses `plan/<plan-name>`, records it as `deliveryBranch`, and delivers there. The
  completion report says **Ready for your merge/PR**, names that branch, and points to the intended target.
- **On:** RunWield delivers to `targetBranch`.

A recorded attempt keeps its landing branch through setting changes and retries. Confirmed publication to the landing
branch makes the Plan Verified. Epic and Sequence children deliver to their parent's branch; PROJECT, QUICK_FIX, and
non-Git execution keep their existing delivery behavior.

**Requirement: Identify publication blockers.** When local publication pauses for tracked or staged user changes, the
recovery notice lists the blocking paths and keeps those changes. The paths stay visible through retries. Before moving
a local target ref for delivery metadata, RunWield finds the checkout that holds that branch and checks its index and
files. User edits pause publication before the ref moves. If RunWield cannot read the checkout list, it keeps the ref
unchanged. After publication, it refreshes the checkout that holds the target branch, even in another worktree.

**Requirement: Publication conflicts resolve inside publication.** A publication-conflict repair belongs to the
publication attempt. When the repair Agent's completion is accepted, Git verification and publication continue
automatically, whether the Agent staged or committed the resolutions.

**Requirement: Continue in the right place after publication.** After a Plan publishes, follow-up messages go to
Engineer in the primary checkout, including after a Session restart. When a published child has an active parent Epic
continuation, the Epic continuation selects the next Agent.

**Requirement: Clean up after confirmed publication.** Cleanup finishes when the target branch still contains the
published commits, even after later commits and after temporary checkouts are gone. Leftover checkout files are saved
in a named folder that RunWield reports. When RunWield cannot confirm the published commits on the target, it keeps
the remaining files. Loading a Plan opens its picker or action menu; worktree and branch removal
after publication is an explicit user choice.

**Acceptance scenarios:**

- Given an untargeted standalone Plan with the setting Off, RunWield records the default branch as the target, creates
  a Plan Branch, delivers there, and names both branches in the report.
- Given the setting On, delivery goes to the default branch; an explicit `targetBranch` takes precedence with either
  value.
- Given dirty unrelated files in the primary checkout, publication to an unchecked-out Plan Branch keeps them, confirms
  delivery, generates the Work Record, and cleans up the worktree.
- Given an Epic or Sequence child, delivery reaches the parent's branch.
- Given a dirty tracked file that blocks local publication, the recovery prompt names that file and its contents and
  the target branch stay as they were.
- Given staged or unstaged edits to delivery metadata in the target checkout, publication pauses before moving the
  target ref, lists the blocking paths, and keeps the index and files unchanged.
- Given the target branch checked out in another worktree, metadata publication refreshes that worktree's index and
  files to the new commit without creating staged reversions.
- Given an execution Plan edited to target `release/next` after the Session loaded it, validation and publication use
  `release/next`.
- Given a Plan targeting `main` while Git config points `main` at another upstream, publication updates and verifies
  remote `main`.
- Given a completed Plan without workflow records, loading it recognizes delivery when Git shows its validated commit
  on its target branch.
- Given a reviewed Epic that the user merged, reload verifies its checked commit on the final target before marking it
  verified.
- Given publication succeeded and leftover files have lost their Git registration, cleanup saves the whole directory to
  a named folder and reports it.
- Given a delivered Plan whose worktree is gone, restarting its Session continues follow-ups in the primary checkout.

#### Recovery actions

**Requirement: Recover interrupted and failed work.** Loading an `in_progress`, `failed`, or `implemented` Plan opens a
recovery path. Users can continue, reset to baseline, re-open for review, retry validation, or address merge-back
failures. Failed Plans leave failure through these recovery actions. Interrupted validation resumes with its completed
work. Users confirm before RunWield deletes unmerged work or resets working changes. Messages are short and plain, with
detailed diagnostics available separately.

**Requirement: Replanning preserves the existing implementation.** Returning to Planner or reopening review keeps the
execution attempt. Approve & Run continues in the same worktree with its commits, staged changes, and untracked files,
under the newly approved Plan. Reapproval resets validation evidence. An explicit reset or abandonment retires the
attempt.

**Requirement: Rewritten candidates are validated again.** Before integration, a rewritten source history or changed
sealed files restart validation against the current execution checkout. Old review approvals and the validation stamp
are reset, and earlier publication evidence and repairs are kept. An unchanged candidate resumes its publication. An
integration that may already be pushed keeps its publication proof. A publication retry recovers unstaged
formatting-only Plan drift and keeps changed definitions, body text, and staged or committed changes.

Acceptance scenarios:

- Given an implemented Plan with review findings and committed and uncommitted repairs, when the user revises and
  approves it again, execution continues in the same worktree with the approved revision and all repairs intact.
- Given a restarted Session without cached execution details, approval finds the existing attempt in the registry
  instead of creating a replacement. The primary checkout's unrelated edits remain unchanged.
- Given an explicitly abandoned attempt, approval does not reactivate it or discard its preserved files.

**Requirement: RunWield repairs its own machinery automatically.**

Internal inconsistencies involving locks, settings, storage, lifecycle metadata, registries, or Plan synchronization are
RunWield's responsibility. It diagnoses, reconciles, repairs, and continues automatically without requiring the user to
inspect files, choose storage strategies, run internal repair commands, or understand bookkeeping. These repairs stay
out of the ordinary user experience. Detailed diagnostics remain available for deliberate support/developer inspection;
an explanatory error message alone does not satisfy recovery.

Automatic repair preserves user content, truthful validation, and real permissions. It must not guess that work was
published, overwrite user decisions, repeat uncertain external side effects, or destroy work to make internal state
consistent. A broken internal state never removes the obligation to retain and recover the workflow.

**Requirement: Settle implementation effects before accepting completion.**

Shared completion holds the Plan and attempt locks while it checks issued document evidence, restores a missing
execution Plan from its recorded baseline, and settles lifecycle, Git checkpoint, journal, and registry effects. A
recorded `implementation_finished` event alone does not prove that checkpoint settlement finished. Retry completes
remaining effects without repeating the lifecycle event. Carriers may require the issued Plan revision and body;
ordinary Session completion does not acquire that extra requirement.

**Acceptance scenarios (current shared execution preparation and completion):**

- Given remembered planned-work consent in a non-Git project and process loss after preparation, when preparation is
  retried against the same `in_progress` Plan, Core continues in the same files without repeating the execution-start
  lifecycle transition. It reconciles proven settled preparation journals before retry. The Attached carrier uses this
  same authority; its host journey is owned by
  [Connect isolated implementation](runwield-connect-prd.md#isolated-implementation).
- Given process loss after a first Git worktree is registered but before its Plan is materialized, retry reconciles the
  original source preparation evidence before document selection and continues the same attempt. It still requires the
  approved source revision and the existing worktree safety checks.
- Given process loss after `implementation_finished` but before the Git checkpoint or registry settlement, completion
  retry saves the worker changes, settles the journal and registry, and only then accepts implementation.
- Given completion bound to an issued Plan and a body edit while completion waits for the Plan lock, Core rejects the
  stale completion without recording implementation. Baseline restoration and replay after complete Core settlement
  still work when the issued body is unchanged.

**Requirement: Ask only for an outcome-level decision or a genuine external prerequisite.**

When the user genuinely must act, explain what happened, what RunWield is protecting, the specific missing evidence or
external prerequisite, the action they can take, what Retry will continue, and what each choice means. Offer deliberate
abandonment with work preserved at the safest recoverable point. Commands are copy-ready with real values when an
external action actually requires a command; never substitute internal labels, hashes, or a generic "restore from
backup" instruction. Waiting for that action remains part of the open workflow. Do not make repetitive retry clicks the
normal way to repair RunWield-owned inconsistencies.

**Requirement: Universal Plan Deviation availability.**

Plan Engineer and Frontend Engineer always have `record_plan_deviation` during Plan execution, independent of
collaboration style or Execution Backend. Availability remains intact after Session restore, compaction, segment
handoff, and validation repair. The focused Validation Repair Engineer also has this capability. Tool availability does
not grant authority to write without an active execution Plan and checkout, or after execution pauses or stops.
Execution ownership is durable from the first execution turn, before any Pair checkpoint. The next writable turn
restores it automatically under the Session Writer Lock. An explicit clear, pause, or Stop survives restore and
compaction; missing cached state must not undo those decisions.

**Requirement: Explicit Plan Deviation confirmation and durability.**

An effective Plan requirement changes only after dedicated user confirmation records the exact superseded requirement,
replacement requirement, and optional reason in the authoritative execution Plan. Confirmed entries survive reload and
supersede conflicting original text in execution, Semantic Review, and Work Records. Retrying a committed tool-call ID
returns the saved entry without another write or transcript approval replay. Ordinary feedback and direct Plan-file
edits are not confirmed deviations. Canceled, unsupported, blocked, or stale confirmation leaves the requirement
unchanged. A changed execution identity or Plan revision invalidates pending confirmation. Unsupported confirmation
preserves work and stops the turn without creating Pair checkpoint state in autonomous execution.
**Requirement: Missing execution documents stay contained.** When one Plan's execution document is missing, other
Plans' catalog reads and validation continue. Loading the affected Plan reports the exact missing path and keeps all
work, runtime state, and its Plan ID.

**Requirement: Continuation evidence does not wait on unrelated remotes.** Catalog and Plan action evidence reads use
existing local Git snapshots and registered execution documents without fetching Epic branches. Remote refresh stays
with the selected Epic's workflow preparation; continuing an existing implementation does not refresh other Epics.

**Acceptance scenarios:**

- Given an implemented Plan with committed and uncommitted repairs, revising and approving it again continues in the
  same worktree with all repairs.
- Given a restarted Session, approval finds the existing attempt; an explicitly abandoned attempt stays retired.
- Given a rewritten unpublished candidate, validation checks the current files, then creates new publication evidence;
  a restart during this recovery finishes the same reset.
- Given a reviewed candidate whose push failed, the source Plan stays reviewed and recovery proves the published Plan
  and Work Record before cleanup.
- Given a paused Validation Repair Engineer conversation, a reply after compaction continues the same Session and
  repair worktree.
- Given execution started from a fresh Session, an interrupted repair accepts the next message in that worktree,
  including after compaction or reload.
- Given a committed archived Plan with no active attempt, Doctor reports no publication problem; an archived Plan with
  an unfinished attempt receives the normal recovery check.
- Given two Plans and a missing execution document for one, the other Plan's reads and validation succeed, and loading
  the affected Plan names the missing path.
- Given an in-progress Plan and unrelated Epics with remote branches, choosing Continue and Proceed loads execution
  evidence without fetching those branches and preserves the selected Plan's worktree authority.

### Semantic review and repair

**Scope and maturity:** Current baseline. The Code Review offer and cancellation rules are in the
[Code Review gate](#code-review-gate).

**Requirement: Resolve concrete findings through independent review.** AI review evaluates the change against the
approved Plan and finds concrete correctness, regression, and security defects. It inspects the actual change, covers
the material requirements, and reports every supported blocker. Reasonable interpretations of ambiguous requirements
pass with an advisory. Maintainability and style observations stay advisory.

Review also judges whether the change's tests would catch a plausible wrong implementation: whether assertions pin
behavior, whether the named boundaries are exercised, and whether a fake bypasses the product-owned code path. A
finding names the concrete wrong implementation that would still pass. Mechanical validation proves that tests ran. A
repair that weakens a test to resolve a finding is a repair-introduced regression.

**Requirement: Review one proposed branch patch.** For Git execution, review sees the branch's proposed change relative
to its recorded target branch: committed, staged, unstaged, and untracked work, with target-only changes excluded. The
same patch supplies AI review, repair context, and Code Review, including after reload. Before-file text uses the same
comparison base. Review follows the publication target's selected remote, not a stale local branch; local-only delivery
uses the local target. A recorded remote target cannot silently become a local comparison if its remote is unavailable.
A missing target, missing execution commit, or unrelated history is a recoverable comparison failure.
Review patches use one fixed format, independent of user Git settings for prefixes, colors, external diff programs, and relative paths.

**Requirement: Read the change before deciding.** The Reviewer receives the approved Plan. Rounds one and two read the
complete diff of every changed file; round two also verifies earlier findings. Round three onward reads the complete
repair diff and assesses every open issue. An approval or rejection with unread parts returns those parts and the
instructions to read them, in the same review. A non-empty patch with no readable file headers stops the review with a
clear reason before a Reviewer runs; it does not count as an empty change and cannot receive approval.

**Requirement: Distinguish repair claims from confirmed fixes.** Issue states are `new`, `fix claimed`,
`fix confirmed`, and `fix rejected`. Each finding keeps its identity across rounds, with open and resolved items
visible. Repair completion claims a fix for each supplied issue; independent review confirms or rejects each claim
with a reason. Only confirmed fixes close issues. States and reasons survive recovery. Metrics separate first-round
findings, defects missed earlier, repair-introduced defects, and issues still open.

**Requirement: Focused repair.** Semantic and Code Review repairs run with focused, fresh context in the same Session
and Plan workflow, including for Frontend Engineer work. Feedback, annotations, images, and prior Code Review
conversation reach the Agent; unclear references lead to a clarification question. A Git-backed Code Review conversation
turn can end with a plain-text reply without a repair completion signal. It records no repair-start evidence. The
[Code Review gate](#code-review-gate) uses patch identity to distinguish a reply from a repair and requires a confirmed
[Plan Deviation](#plan-deviations) for scope changes; non-Git in-place turns always use repair.

**Requirement: Hand the decision to the user after automatic rounds.** After three automatic rounds and their repairs
and checks, users choose another verification round or Code Review. In Git-backed Code Review, only a conversation
turn that changes the reviewed patch returns to checks; a reply-only turn keeps the decision, evidence, status, and CI
results. After an owner-requested repair, CI runs and Code Review reopens in the same conversation without another AI
review. Non-conversation feedback and non-Git in-place turns retain repair and checks. User rounds have no automatic
limit. Users can nudge a stalled Reviewer or repair Agent in its existing conversation. Every pause explains what
continuing will do. The round limit bounds automatic effort; the workflow continues under
[Workflow completion](#workflow-completion-and-automatic-recovery).

**Requirement: Useful advisories.** Final nonblocking advisories go with the delivered Plan as labeled
post-validation context, once. Review quality is judged by useful convergence and escaped defects.

**Acceptance scenarios:**

- Given a missing Plan requirement, the finding stays visible through repair until the Reviewer confirms the fix.
- Given user Git settings that change diff prefixes, colors, external diff output, or relative paths, review lists every
  changed file with its repository path and requires reading it.
- Given a non-empty review patch with no readable file headers, the review round stops with a clear reason and no
  Reviewer approval is recorded.
- Given an unread diff chunk, a verdict attempt returns its path and read command; the review continues and completes
  after every required chunk is read.
- Given a round-one rejection, round two checks the whole implementation and earlier findings; later rounds check open
  issues and repair regressions, including in a fresh process.
- Given an incomplete fix, review records `fix rejected` with a reason under the same issue; a later confirmed fix
  closes it.
- Given a finding about unchanged target content, repair reports it as already satisfied with evidence, and review can
  confirm it.
- Given a test that would pass with a plausible wrong implementation, review reports a blocking finding that names it;
  weak but honest assertions stay advisory.
- Given target work imported after execution started, the patch shows only the branch's own changes.
- Given a retained worktree and a local target behind the selected remote target, all review surfaces exclude work already
  delivered to that remote and retain every committed and uncommitted proposal. Before-file text matches that patch.
- Given a missing required remote target, a missing target branch, or unrelated histories, review stops with a recoverable
  comparison failure instead of substituting a stale local branch.
- After the automatic rounds, when the user chooses Code Review and Engineer completes a requested patch change,
  checks run and the same Code Review conversation reopens; automatic AI review does not resume.
- Given a Git-backed Code Review question, a plain-text answer with no patch change reopens review without repair
  evidence or another CI run, as specified by the [Code Review gate](#code-review-gate).
- Given an edit that stops on a blocker, the prior approval is invalidated and the repair stays pending with its blocker;
  review does not reopen over unfinished work.

**Requirement: Suggest code by editing the diff.**

The Reviewer receives the actual approved Plan content. Rounds one and two must read the complete diff for every changed
file. Round three onward must read the complete repair diff and assess every open issue; those rounds do not rediscover
unrelated defects in the original change. Both approving and rejecting require complete coverage of the relevant diff.
An incomplete decision returns the unread file chunks and instructions for reading them, in the same review context.
Listing files, rereading one chunk, or reading the wrong diff scope cannot satisfy coverage. Coverage proves that the
code was supplied to the Reviewer, not that the judgment is correct.

**Requirement: Bind saved human approval to the current candidate.**

Attached Code Review uses the shared page and the project's `codeReview` mode (`none`, `ask`, or `always`). Core saves
its pending wait with the candidate diff hash. Approval must match the current hash; changed code cannot use stale
approval. In Core and Attached, a saved reviewed candidate that changes before approval returns to Mechanical
Validation, configured CI, and Semantic Review before a new Code Review. Older checkpoints without candidate identity
keep their existing continuation behavior until the next Semantic Review. Submitted Feedback becomes a `human_feedback`
repair action for a fresh host worker. Core reruns configured re-verification before a new human review round. The host
owns repair reasoning, not review gates.

**Acceptance scenarios: Saved Attached Code Review.**

- **Diff-bound approval:** Given a saved human review and a changed candidate, Core rejects the old approval and does
  not publish. A fresh process restores the pending review without inventing a decision.
- **Changed candidate re-verification:** Given a reviewed candidate that changes before approval, the next validation
  run reruns Mechanical Validation, configured CI, and Semantic Review before presenting a new Code Review, in Core
  and Attached.
- **Feedback re-verification:** Given submitted human Feedback, a fresh host worker repairs it. Core reruns configured
  re-verification, then presents the repaired diff in a new Code Review round before publication.

**Requirement: Distinguish repair claims from confirmed fixes.**

Issue states are `new`, `fix claimed`, `fix confirmed`, and `fix rejected`. Accepted repair completion claims a fix for
each supplied open issue. Independent review confirms or rejects each claim; rejection retains the issue identity and
explains what is still wrong. Only confirmed fixes close issues. These states and rejection reasons survive recovery.
Metrics separately distinguish first-round findings, defects missed in the original change, repair-introduced defects,
and existing issues still open. Origin is Reviewer attribution for diagnosis, not a new issue state or proof of cause.

Semantic and human-feedback repairs receive focused, fresh context in the same user-visible Session and Plan workflow.
Human feedback, annotations, and images must survive the handoff. Unclear references require clarification, not guesses.
Repair is about correctness; it does not introduce Pair design checkpoints.

After three automatic rounds and their repair/checks, users choose another verification round or Human Code Review.
Choosing human review transfers the decision to the user: feedback triggers repair and CI, then returns to human review.
No automatic round limit ends a human-driven review. A stalled Reviewer or repair Agent can be nudged in its existing
conversation with progress preserved; every pause explains what continuing will do.

When Code Review is offered, users can open it, skip it, or close the prompt to come back later. Closing keeps the
review pending and preserves the Plan and its implementation without publishing. Loading the Plan again with `load-plan`
and continuing validation offers the same choice again. If the reviewed code changed, validation runs again first.

Canceling an open Code Review, including Escape in the terminal, leaves approval pending. Cancellation status text and
unsubmitted draft fields never become revision feedback, approval, or counted review/revision receipts. The UI clearly
states that review is pending and offers Retry or Plan resume; reopening presents a current working review link.
Previously completed checks and the implementation remain available. Explicitly submitted feedback still starts repair
and records the corresponding review decision and revision, followed by checks and another Code Review.

The round limit bounds automatic review effort, not workflow life. The user can continue toward publication or
deliberately abandon; an exhausted or stalled review cannot become an automatic terminal outcome. Internal dispatch,
lock, and bookkeeping failures use [automatic workflow recovery](#execution-validation-and-recovery), not another review
decision for the user.

Final nonblocking advisories may accompany the delivered Plan as clearly labeled post-validation context, never new
approved requirements or a full review diary. Revalidation must not duplicate them. Review quality is judged by useful
convergence without more escaped defects, not approval rate alone.
Code Review settings provide an experimental **Edit code to suggest** switch, off by default. There is no announcement
or first-run prompt. When enabled, Edit is available in the all-files diff on both standalone and Workspace review
pages, one file at a time, but not in Guided Review. Finished edits become suggestion annotations in the feedback. The
browser never writes project files. The before text comes from the shared proposed-branch comparison; Workspace reads
the execution worktree, not the primary checkout.

**Acceptance scenarios:**

- Given the switch is off, opening Code Review shows no Edit control or announcement dialog.
- Given the switch is on, editing a modified or added file and clicking Suggest creates an annotation per changed
  region. Feedback includes the suggested code and the project files remain unchanged.
- Given a comment made on selected text during editing, discarding the edit keeps the comment and restores the diff.
- Given a Workspace review whose worktree differs from the primary checkout, the editor shows the worktree text.
- Given Guided Review, its diffs have no Edit control. Plan Review settings do not show the switch.
- Given an unavailable review comparison, the diff still renders and Edit shows its unavailable reason.

### Standalone code review

**Scope and maturity:** Current local CLI behavior. Standalone Code Review works without a Plan and leaves Plan
lifecycle and Delivery Evidence as they are. The validation gate is owned by
[Execution, validation, and recovery](#execution-validation-and-recovery).

**Requirement: Review three local sources.**

- `wld review` compares HEAD with staged, unstaged, and untracked changes.
- `wld review <branch>` compares a local branch with its merge base against the current checkout.
- `wld review <PR or MR URL>` compares the fetched head with the merge base of its target branch. The URL must match a
  remote of the current checkout. A missing or signed-out Forge CLI produces the `gh auth login` or `glab auth login`
  command.

**Requirement: Discuss and edit without a Plan.** The Code Review page provides Guided Review and chat with Engineer.
One saved Engineer Session serves the review and can be resumed. Branch and PR reviews create or reuse a review
worktree at the first Engineer request; uncommitted review uses the current checkout. Users direct Engineer commits and
pushes.

**Requirement: Source-specific actions.**

- **PR or MR review:** Post comments submits a neutral review; Approve submits annotations and approval. Global notes
  become the review body; file and line comments keep their scope and side. A partial GitLab submission reports the
  failed comments and leaves the submitted ones as they are. Posting is available while local edits
  match the PR head. When the remote head moves, the review refreshes, clears old annotations, and marks Guided Review
  prose stale. A clean review worktree fast-forwards to the new head; local work and rewritten history are kept with a
  recovery reason.
- **Branch review:** Engineer feedback.
- **Uncommitted review:** Approve & Commit. Operator follows the bundled commit rules, commits, and pushes, setting
  `origin HEAD` as upstream when needed. RunWield confirms a clean tree, a new HEAD, and upstream equality. A failed
  push keeps the commit; a retry publishes it without another commit. Detached HEAD disables the action.

**Requirement: Draft annotations with AI review.** Standalone Code Review offers a manual **Run AI Review** control
beside Guided Review. It discloses the additional LLM call, supports cancellation, and shows elapsed time, model,
usage, and cost when available. It runs the bundled `review` skill (including project overrides), not Semantic Review,
with sequential Standards, Spec, and Tests passes. It finds the spec without asking; without a spec, it grades no
invented requirements. Findings become ordinary editable, deletable annotations labeled **AI review**, with their axis
and blocking or advisory severity in the text. Line annotations must fit a diff hunk on the cited side; other findings
fall back to file or general annotations and retain their cited location. Completion shows per-axis counts and the spec
source, or reports no issues. Reruns replace only unedited AI annotations. Results from an older patch add nothing.
Validation-time Code Review does not offer this control.

**Requirement: Protect review work.** Closing the review publishes nothing. On completion, cancellation, or
interruption, RunWield closes its Sessions and removes only its own clean worktrees whose HEAD equals upstream. Dirty
or unpushed work stays, and RunWield reports its path and branch. Engineer starts after checkout setup completes. The
terminal prints the review link, progress, result, cleanup outcome, and Engineer Session ID.

**Acceptance scenarios:**

- Given staged, unstaged, and untracked edits, `wld review` shows all three. Guided Review starts only when the
  owner clicks its toolbar button, not when review opens or the diff refreshes, regardless of diff size.
- Given a local branch, review opens without a worktree; an Engineer request creates one and the next diff includes its
  edits.
- Given a PR in a matching remote, Post comments and Approve reach the Forge; a foreign repository is rejected.
  In a checkout or linked worktree, a repository mismatch prints a concise error and exits with code 1, without a
  stack trace or runtime-crash recovery advice.
- Given a moved remote head, posting refreshes the review and marks Guided Review stale; local edits and commits stay
  protected.
- Given failed checkout setup, an unchanged unused worktree is removed and the next Engineer request retries; changes
  made during the failed setup stay protected.
- Given a review worktree created after the page opened, later Guided Review jobs use that worktree.
- Given uncommitted work, Approve & Commit succeeds after the commit and upstream checks pass; a push retry completes
  approval with the existing commit.
- Given review exit, clean created checkouts at upstream are removed, and dirty, unpushed, reused, and primary
  checkouts remain.
- Given an AI finding on a changed line, its annotation keeps the file, line range, and old or new side. A cited line
  outside the hunks becomes a file annotation; an unchanged file becomes a general annotation with the cited location.
- Given generated annotations, the owner can edit or delete them. Post comments and Approve keep their text, position,
  and side; Send to Engineer includes the remaining annotation text, including axis and severity.
- Given a rerun, owner annotations and edited AI annotations remain; unedited AI annotations are replaced.
- Given a patch change during a run, completion reports an older diff and adds no annotations.
- Given no discoverable spec, AI review reports no spec and makes no Spec findings against invented requirements.
- Given a compiled review command and a different `wld` installation on PATH, AI review and Guided Review use the
  running executable, not the other installation. Explicit provider command overrides remain available.
- Given malformed output or provider failure, the job reports an error and the owner can rerun it.
- Given validation-time Code Review, Run AI Review is absent; existing validation and Guided Review remain available.

### Frontend engineering and pair execution

**Scope and maturity:** Current baseline across TUI, Workspace, and ACP.

**Requirement: Let the user steer visible increments.** Frontend Engineer owns work whose main outcome is visual or
interactive, including supporting backend changes in the same slice. Users can configure its model separately. Planner
sets outcomes, behavior, key states, accessibility, responsive expectations, and design references, and leaves visual
treatment open when user taste is part of the work.

Pairing is optional. The Plan's recommendation and the host's capability select Pair or autonomous work;
noninteractive hosts work autonomously. In Pair mode, the execution Agent implements a coherent observable increment,
reports it in the normal conversation, and ends the turn. The user can ask questions while implementation stays
paused, request a revision, continue,
switch to autonomous work, or stop with work preserved, through the normal composer. Iteration keeps the same
workflow, execution Agent, worktree, tools, attempt, and conversation. A checkpoint does not switch Plan Engineer to
the Quick Fix Engineer.

**Requirement: Readable checkpoint reports.** Reports use Markdown with bold section titles and blank lines between
sections, with evidence, diagnostics, and proposed next increments in separate sections. The TUI shows reports
rendered and expanded.

**Requirement: Only a later user turn resolves a checkpoint.** A typed checkpoint resolution based on a later genuine
user turn resumes implementation or authorizes completion. Final approval uses the same report-and-reply flow. Reload
and compaction keep the active checkpoint. Material scope changes return to planning; ordinary refinements continue.

**Requirement: Validation stays in force.** Both styles verify in a real browser when one is available and follow the
project's existing tests. A new browser test framework needs an explicit Plan decision. Workflow Validation runs after
Pair feedback as usual. Passive metrics measure revision cycles, completion, and checkpoint fatigue without screenshots
or feedback text.

**Acceptance scenarios:**

- Given Pair on TUI, Workspace, or ACP, when an increment is ready, its report ends the turn and the conversation
  accepts questions, revisions, continuation, autonomous switching, or Stop.
- Given a report with evidence, diagnostics, and a next increment, the TUI shows it rendered and expanded.
- Given a Plan Engineer checkpoint, Plan Engineer stays active while waiting for feedback and after continuation.
- Given an open checkpoint, only a later accepted user turn resolves it.
- Given a final increment, Workflow Validation starts after the user accepts it and the Agent submits completion again.
- Given a stopped Pair execution, work and workflow state stay available for a later resume.
- Given a noninteractive host, the same Plan runs autonomously and validates normally.

### Theme selection

**Scope and maturity:** Current baseline.

**Requirement: Preview safely and keep the confirmed theme.** Users install or remove themes from npm, Git, or local
packages, preview them live in `/theme`, and confirm a choice that persists across Sessions. Previewing keeps the saved
choice. The built-in `catppuccin-mocha` theme takes over when a selected theme is missing or invalid. Installing a
theme activates only its theme content. See the [theme reference](../user-documentation/themes.md).

**Acceptance scenarios:**

- When the user previews a theme and cancels, the saved theme stays unchanged; confirming persists the choice for later
  Sessions.
- When a saved theme becomes invalid, the built-in fallback remains usable without activating unrelated executable
  extensions.
- Given a newly installed package with compatible extensions, when the consent prompt opens, the saved registration
  already has `extensions: []`. Refusal, EOF, a prompt error, or an interrupted install keeps executable code disabled
  while themes and prompts remain available.
- Given acceptance of that prompt, the saved filter enables exactly the compatible candidates before success is
  reported, and a later Session loads them. A failed settings save reports failure instead of enabled code.
- Given an existing registration, reinstalling through an equivalent relative or absolute path preserves its enabled,
  disabled, and filtered choices, unrelated packages, and other settings without another code-extension prompt.

<a id="61-current"></a>
<a id="62-future--open"></a>

### Project context and initialization

**Scope and maturity:** Current baseline. A compressed Project Brief and further code-intelligence improvements are
target scope.

**Requirement: Confirm home and system folder use.**

Before local project CLI dispatch or direct TUI startup, RunWield warns “System or home folder detected. Continue?” with
the selected path and Continue/Quit choices. Quit is the default; cancellation stops before project work or Session
creation. The policy matches the current account home, filesystem roots, and a fixed cross-platform system-directory
list by exact normalized or canonical equality. Symlink aliases match; ordinary descendants and similarly named folders
do not. Consent applies only to the same inspected directory in this invocation, not a persistent trusted-folder
setting.

Noninteractive project commands refuse with nonzero status and stderr guidance unless a leading
`--allow-system-directory` flag acknowledges the directory. This flag does not consume piped request input, change
`--continue`, or bypass Init's file consent. Help, version, global commands, Workspace services, ACP, MCP, and remote
connections retain their existing behavior. This warning is consent, not a security sandbox or universal unsafe-path
detector.

**Acceptance scenarios:**

- Given an exact home or listed system directory, when project startup begins, no project work starts before Continue.
  Quit, Escape, Ctrl-C, and cancellation stop startup. A later process asks again.
- Given Continue, automatic Init, Tutorial, and empty-folder starter offers are absent and their stored markers are
  unchanged. Explicit Init and Onboard remain available with their normal consent.
- Given an ordinary descendant such as `~/projects/app`, `/opt/app`, or `/tmp/app`, startup keeps its normal offers.
- Given piped `guided-review` input at home, startup refuses before reading it unless the leading acknowledgement is
  supplied.

**Requirement: Preserve useful project facts and retrieve relevant context.**

- **Mnemoteca:** project and global persistent memory for preferences, project facts, and critical context.
- **Init:** `wld init` and `/init` explore the project, confirm verification and fresh-worktree setup commands, write
  project context, store memories, and record initialization.
- **Sleep:** `wld sleep` and `/sleep` clean up memory and context.
- **Cymbal:** semantic and structural code intelligence for search, symbol lookup, impact analysis, and tracing.
- **Snip:** optional, fail-open filtering of command output into compact diagnostics. RunWield wraps only an eligible
  leading plain command, preserving shell syntax, exit status, and output destinations under the Snip filtering contract.
  Unsupported constructs, live expansions, and stderr redirections pass through unchanged.
- **Project context:** `docs/domain-language.md`, memories, settings, and Plan files hold durable project knowledge.

**Requirement: Discover and retain both project commands during Init.** Init discovers repository-supported verification
and fresh-worktree setup candidates, asks the user to confirm each (including no setup required), and saves them in
`.wld/settings.json` through one tool that accepts either command or both. Omitted commands remain unchanged. Discovery
must not run installers. Init cannot claim completion until both choices are saved. Explicit `/init` may run again for
an older initialized project whose setup command is missing.

**Requirement: Init asks before it writes project files.** Before Init starts its Agent or writes files, it asks
permission and lists `.wld/settings.json` (project settings, Verification Command, and worktree setup command),
`docs/domain-language.md`
(project glossary), and `.gitignore` (managed runtime ignore rules), and discloses internal state, indexing, and
project memories. This applies to CLI Init, `/init`, startup, and Tutorial entry. Init runs on surfaces that can show
this confirmation; elsewhere it stops and explains. Accepting continues. Declining or
canceling stops Init with its files as they were and tells the user to run `/init` later.

**Requirement: Keep memory current and subordinate to project authority.** Agent memory keeps current durable
decisions, preferences, constraints, rationale, and reusable lessons. Agents store a durable lesson when one exists and
keep routine bookkeeping such as release dates, commit hashes, PR inventories, test counts, and completion receipts out
of memory. Historical detail stays when it explains a current decision. Proposed work stays labeled as proposed.

Core Memories are strong guidance; other Memories are useful, non-authoritative context. Neither overrides the user,
current project documentation, the applicable Plan, or code as evidence of implemented behavior. The user decides
intent, docs and Plans define requirements and scope, and code shows what is implemented. Agents resolve memory
conflicts against those authorities and treat current implementation as context for requested changes, not a veto.

Sleep applies the same policy: it corrects outdated guidance, removes routine bookkeeping, and keeps useful decisions
and lessons, stating the current rule directly. Cleanup keeps a backup and deletion manifest, verifies replacements
before it removes source memories, and leaves unrelated memories unchanged.

**Requirement: Glossaries follow the project.** A project can keep one glossary for several contexts or a map of
separate glossaries. Agents discover model boundaries from behavior, terminology, and ownership.

**Requirement: Efficient, accurate code tools.** Failed edits report the underlying error, and Agents retrieve the
source they need. Agents can request up to five known source or outline reads at once; results keep request order and
each reports its own success, failure, and truncation within a shared response limit. Agents request narrower reads
for truncated content. Failed code queries report failure; a successful empty query reports success.

**Acceptance scenarios:**

- Given an existing project, when Init completes, the glossary and saved facts provide terminology and context for
  later work.
- Given a fresh project, Init lists the three files and their purposes before it writes or starts a model turn.
  Declining leaves the files as they were and suggests `/init`.
- Given a routine release or successful test run, the Agent stores at most a reusable lesson from it.
- Given a Memory that conflicts with the user, current docs, the Plan, or code, the Agent follows the authority and
  corrects the memory.
- Given a superseded or mixed Memory, Sleep keeps a verified current lesson and the backup keeps the old record.
- Given a glossary map, Agents follow its links regardless of code layout.
- Given batched reads where one target is missing, the successful results stay visible in request order.
- Given a shell loop, conditional, function, group, heredoc, or stderr redirection, Snip leaves the command unchanged.
- Given an eligible leading command followed by a pipeline or `&&`/`||` chain, Snip wraps only that command, runs it
  once, preserves its exit status and output destinations, and leaves the rest of the shell program unchanged.

**Target: concise project briefing.** Compressed project context where it is useful, without filling every prompt.
Future code-intelligence work addresses demonstrated gaps in finding code, understanding dependencies, and assessing
change impact.

### Tutorial

**Scope and maturity:** Current TUI baseline. Workspace-native Tutorial controls are deferred.

Home and classified system folders are not eligible for automatic offers, even after Continue.

**Requirement: Offer an optional guided first change.** On one eligible new TUI Session, RunWield offers a Tutorial
after model setup and the Init decision. The offer shows the current project and states that starting makes a real
project change, uses the configured model, needs Plan Review, and keeps normal checks and delivery approvals. Start and
Skip are explicit choices. The offer and Skip use no model and save no Session, Plan, or file; a separately accepted
Init writes its own files. Skip or cancellation turns off automatic offers for this user in all projects. `/onboard`
and interactive `wld onboard` stay available and show the same consent first; non-interactive `wld onboard` exits
without work. An Empty Project Directory receives the
same offer after model setup.

**Requirement: Teach through a real workflow.** After Start, Planner inspects a bounded area and suggests up to three
small changes; in an Empty Project Directory, up to three small starter projects. The selected change uses the normal
Plan Review, execution, checks, AI review, optional Code Review, delivery, and Work Record generation. Teaching messages
follow real workflow events and have no workflow authority. A RunWield Verified and published change receives the
Tutorial recap; other outcomes keep their own labels. At the Plan Review checkpoint, the user can continue with
guidance, continue without it, or cancel. Guidance state survives execution and repair transcript rollover; on resume,
RunWield asks before it restores guidance.

**Acceptance scenarios:**

- Given an eligible new TUI Session, the offer shows the warning and project path; Skip returns to ordinary input and
  ends automatic offers everywhere.
- Given a permanent Skip, `/onboard` still shows the warning before setup, Init, or model work.
- Given an Empty Project Directory, Start leads Planner to offer up to three starter projects before any Plan or file.
- Given Start and a selected improvement, one draft Plan enters Plan Review with its normal meanings.
- Given Init's placeholder Verification Command, teaching identifies it as a placeholder.
- Given confirmed RunWield Verified publication, the recap uses the Plan, Work Record, and review artifacts; reopening
  the Session restores the recap from delivery evidence.
- Given a completed Tutorial, the [next-step menu](#tui-conversation) appears at the input area.

### Compaction and image context

**Scope and maturity:** Current baseline. Long-run resilience is target scope in
[Session Context Resilience](session-context-resilience-prd.md).

**Requirement: Keep useful conversation context.** `/compact` summarizes a growing conversation, with optional emphasis
instructions. Automatic compaction relieves context pressure. Engineer-family Agents compact early, at 60% of the
context window or 120,000 tokens, whichever comes first; other Agents use the configured threshold. Users see progress,
completion, failure, and whether input is needed; Escape cancels. Compaction keeps the goal, constraints, decisions,
progress, relevant file context, recent activity, and saved [Named Invocation](#agent-and-skill-customization)
expansions. Failed or canceled compaction leaves the work available and reports its real outcome.

**Requirement: Images reach the model.** Vision-capable models receive images directly. With a text-only model, users
can select a vision fallback globally or in a model preset; the preset takes precedence. Users see which model describes
the image. Missing fallback setup explains the fix and keeps typed text and image previews, including after a model
change before Send. Standalone releases resize images cleanly. See [vision fallback
settings](../user-documentation/settings.md#visionfallback).

**Requirement: Paste clipboard images on demand.** In the TUI, Ctrl-V reads a clipboard image only when the user presses
it. RunWield does not read or watch the clipboard while idle, including across focus changes, Session replacement,
and concurrent Sessions. If an explicit paste finds no image, the composer shows "No image in clipboard" until the next
input or a successful image paste. A clipboard read that finishes after view disposal adds no preview or attachment and
requests no render. Keyboard help lists Ctrl-V for image paste.

**Requirement: Agents can inspect images.** The Agent can ask `see_image` about a saved Session attachment or a
referenced project image. Descriptions include readable text, visual state, and uncertainty. Resumed Sessions keep
access to their own attachments. **Target:** deleting a Session also removes its images.

**Acceptance scenarios:**

- Given an Engineer-family Agent with a 128,000-token window, its early threshold is 76,800 tokens; with 200,000 tokens
  or more, it is 120,000.
- Given a successful compaction, the resumed Session keeps its goal, decisions, constraints, Named Invocation expansion,
  and progress, and Pair checkpoints stay available.
- Given a text-only model and no fallback, sending an image shows setup guidance and keeps the message and preview.
- Given a resumed Session with saved images, its own attachments stay available.
- Given a standalone release, resizing an image produces a valid image at the requested size.
- Given several idle TUI Sessions on macOS, no clipboard process starts until the user presses Ctrl-V.
- Given Ctrl-V with no image available, the composer shows "No image in clipboard"; the next input clears it.
- Given a clipboard image read that finishes after view disposal, no preview, attachment, or render is added.

### Image generation

**Scope and maturity:** Current through OpenRouter, Codex, and Antigravity CLI (owner confirmation, 2026-10-06). The
OpenCode Responses route is experimental. Google SDK integration, graphical image settings, and remote generation are
deferred. [Provider notes](../research/image-generation-provider-proof.md) hold historical test results.

**Requirement: Generate images with a user-selected model.** Users set `imageGeneration.model`, with optional supported
`thinkingLevel` and `temperature`, globally, per project, or in a model preset. The conversation model can be any
model.

- **Pi image models** use the existing provider configuration and authentication.
- **`agy-cli/<model>`** uses Antigravity's own image model and sign-in.
- **`codex-cli/<model>`** and **`openai-codex/<model>`** use the local Codex runtime's ChatGPT sign-in. RunWield finds
  Codex on PATH or in the ChatGPT desktop app on macOS.
- **`opencode/<model>`** uses a Responses model with hosted image-tool access.

Each request uses the configured provider and billing route. Unsupported controls are reported. A model change starts
from that model's own controls.

**Requirement: Produce a reusable project image with truthful success.** `create_image` takes a prompt, a required new
output path, and optional project or Session image references. File-writing Agents, write-capable delegates, Agents
that declare the tool, and Guide can use it; Guide keeps its docs-only editing tools. Read-only delegates work
without it. Claude CLI Agents receive it through MCP. Success means one decoded image
is saved at the new path in the format its extension names. The result names the model, path, format, and dimensions,
with a preview for image-capable callers; a text-only conversation model receives the metadata, and the image stays
available to `see_image`. Existing files and inputs stay unchanged, including a destination that appears during
generation, and paths stay within the project
or Session. Failures, text-only output, malformed bytes, cancellation, and timeouts report failure and publish no file.

**Acceptance scenarios:**

- Given an image-capable Pi model, an Agent creates an image at its path; a later edit uses that file and saves a new
  image, leaving the source intact.
- Given configured image generation, Guide and write-capable delegates create requested images.
- Given a signed-in Codex runtime, image generation uses the selected model and effort; an API-key account is
  rejected.
- Given Codex installed only in the macOS ChatGPT app, image generation starts it; given no Codex, the tool reports
  setup guidance.
- Given a Claude CLI conversation, the MCP tool accepts Session attachments and returns the saved path and preview.
- Given an existing or escaping destination, generation is rejected and existing files stay unchanged.
- Given a canceled request, the generation stops and no file appears.
- Given a destination created while generation runs, that file stays and the tool reports failure.

### Work records

**Scope and maturity:** Current generation and retrieval baseline. Manual or external record creation and richer
authorship are follow-up scope.

**Requirement: Preserve outcomes with truthful completion confidence.** Work Records are concise, repository-owned
Markdown accounts of permanent facts: the delivered outcome, recorded Plan Deviations, out-of-scope facts, and durable
lessons. They keep source Plan and Ticket links, not validation receipts, delivery status, run events, to-dos, or known
defects. Identity and links survive renaming, and search can be rebuilt from the documents.

- Eligible top-level completed Plans and Epics receive auto-approved records by default. An Epic record summarizes its
  relevant children, including deferred and archived work.
- Completion labels distinguish RunWield verification, user verification with its note, closure without verification
  with its reason, and done-enough Epics. Missing historical closure reasons are disclosed.
- A record written before publication stays pending until the merge finalizes, and a restart reuses it. Publication
  approves the record without rewriting its body. The delivered commit lives only in the source Plan's Delivery
  Evidence, reached through the record's source Plan provenance. A search-index failure is reported separately from
  successful delivery.

**Requirement: Recording is best effort and recoverable.** Recording failure leaves the completed Plan and its delivery
intact. The completion notice shows both outcomes and offers **Retry Work Record**, which regenerates only that Plan's
record (or its eligible parent Epic's) in the current Session. `wld wr retry <plan-name>` targets one Plan;
`wld wr backfill` previews missing records across completed Plans, asks before generating, and reuses existing linked
records. Recorder finishes by submitting its record; a turn that ends without it receives one corrective retry
(provider errors and cancellation end the attempt), and repeated omission leaves a concise protocol diagnostic on the
Plan, without model text or private reasoning. With automatic generation turned off, listing, reading, search, and
explicit backfill stay available.

**Requirement: Retrieve current records.** `wld wr` lists, searches, reads, rebuilds the index, and backfills. Default
retrieval returns current approved records. Pending, draft, superseded, and archived records appear in explicit
historical or maintenance views with clear notices. Ideator, Planner, and Architect retrieve relevant current records;
Guide and Recorder can inspect historical records with their labels. Retrieval is Project-scoped; cross-Project
knowledge is a Workspace requirement. Older records with a `Result` section read as summaries; an invalid record stops
backfill with its filename and the required repair.

**Requirement: Accept host Recorder sections through shared record rules.**

For Attached delivery, Core saves a Recorder action with canonical Plan, diff, and validation evidence. The host returns
structured `work_record_completed` sections. Shared Core validation, persistence, deduplication, and indexing remain
authoritative; host conversation text is not a record source. Accepted sections survive process loss and are reused
before publication sealing, not generated again.

An invalid submission returns its validation errors and allows one retry. A second invalid submission saves the record
failure and permits publication to continue. Recording failure never blocks or reverses proven delivery. The completion
notice shows both outcomes and the existing backfill option. Attached supersession proposals resolve as “decide later”;
the notice names `wld wr supersede`. A proposal alone does not replace a current record.

**Acceptance scenarios: Attached recording.**

- **Shared canonical recording:** Given valid host sections from canonical artifacts, Core persists and indexes the
  eligible record under its existing rules, without importing host transcripts or starting a Core Recorder Session.
- **One invalid retry:** Given an invalid submission, Core returns errors for one retry. A second invalid submission
  saves failure, continues publication, and reports recording separately from delivery.
- **Reuse accepted sections:** Given process loss after accepted sections but before publication, recovery reuses the
  same sections and record identity. It does not repeat recording or fabricate publication proof.
- **Deferred replacement:** Given an Attached supersession proposal, the earlier record remains current. The completion
  notice names `wld wr supersede` for later confirmation.

**Acceptance scenario: Recorder recovery and partial completion.** Given a completed eligible Plan, when the Recorder
returns text without submitting its tool event, one corrective turn can finish the record. If both turns omit the event,
no record is fabricated; the Plan retains the failure reason and successful delivery is labeled with the remaining Work
Record failure and retry command. Failures while reading existing records are also retained on the source Plan before
delivery; remote publication reports that outcome from the sealed Plan even after worktree cleanup. When the last child
completes an Epic, final completion reports the parent Epic's recording outcome, including after remote cleanup.

Core retrieval is Project-scoped. Cross-Project knowledge and browser navigation are Workspace requirements. Richer
cross-artifact authorship, manual/imported record creation, and guidance for substantial retrospective edits remain
follow-up product questions.

**Target: explicit external provenance.** A maintainer may explicitly record substantial externally contributed work,
including the source change, contributor, reviewing maintainer, and validation that actually ran. These records are
opt-in and cannot claim RunWield validation. No merge is required to have a Plan or Work Record: Git owns commit-level
history, and RunWield-owned merges should clearly point back to their Plans. Optional record review, historical
compression/reorganization without changing source Plans, and richer authorship remain separately labeled follow-up
scope.
**Requirement: Maintain records deliberately.** Minor corrections update a record. A later record replaces an earlier
one through a user-confirmed relation, including a declaration in an approved Plan. Archival and restoration keep the
record and its completion meaning. Records come from completed Plans; QUICK_FIX work and ordinary external merges have
Git history.

**Acceptance scenarios:**

- Given an eligible completed Plan, the record links its source and labels how completion was established.
- Given no recorded Plan Deviations, the record has no Deviations from Plan section.
- Given publication, the approved record body equals its pre-publication body.
- Given user verification, the record states the attestation and cleaned note once.
- Given delivered code and a failed record, the completion menu offers **Retry Work Record**; a retry regenerates only
  that record, and repeating a successful retry keeps one record.
- Given Recorder returns text without submitting its record, one corrective turn can finish it; if both turns omit it,
  the Plan keeps the failure reason and delivery is labeled with the retry command.
- Given an Epic completed by its last child, final completion reports the Epic's recording outcome.
- Given a planning search, current approved records appear; an explicit historical view labels confidence.
- Given a suggested replacement, the earlier record stays current until the user confirms supersession.

**Target: explicit external provenance.** A maintainer can record substantial externally contributed work with its
source change, contributor, reviewing maintainer, and the validation that actually ran. Git owns commit-level history,
and RunWield-owned merges point back to their Plans. Optional record review,
historical reorganization, and richer authorship are follow-up scope.

### Agent and skill customization

**Scope and maturity:** Current baseline. Remote personal resources are in [Remote connection](#remote-connection).

**Requirement: Layered Agent definitions.** Bundled Agents are Router, Guide, Ideator, Operator, Planner, Architect,
Engineer, Frontend Engineer, Recorder, Tester, the workflow-only Slicer and Reviewer, and the Init pseudo-Agent. Agent
definitions are Markdown files with YAML front matter, layered in this order:

1. project: `./.wld/agents/<agent>.md`
2. home: `~/.wld/agents/<agent>.md`
3. bundled defaults

Scalar front matter follows precedence. Prompt bodies append unless `promptOverride: true` is set. User-facing labels
use the effective `name`; the filename is the internal ID for selection, routing, and persistence.

#### Metrics exporter approval

**Requirement: Resolve metrics exporter entries only after saved host approval.**

Current Core package discovery recognizes the top-level `wld.metricsExporter` declaration with contract `1`, a non-empty
ID, and a relative entry that stays inside the real installed package path. The entry cannot also be a Pi extension
resource. Core lists only user-scope installed exporters and their approval state; it resolves approved entries without
importing code. Session startup never loads an exporter entry through the Pi extension path.

The declaration can include up to eight credential fields. Each has a unique key matching
`^[A-Za-z][A-Za-z0-9_]{0,63}$`, a non-empty label of at most 64 characters, and a boolean `secret` value. Malformed fields
invalidate the declaration. Core exposes the field shape for Workspace forms without executing exporter code. Field
changes do not change approval identity.

`wld install` asks a separate default-no exporter approval question for any new or existing unapproved exporter. Only
`y` or `yes` saves approval. Core confirms the saved record before reporting approval. Host-global approval binds the
exporter ID, configured user source, real installed path, and package version; Project settings cannot grant it or
replace the approved package. `wld remove` deletes that source's approvals. Approval is not a sandbox and does not
control npm lifecycle scripts. Core delivery requires a separate [Export grant](#usage-measurement-and-export).

**Acceptance scenarios:**

- Given a valid installed exporter, before approval Core lists it as unapproved and resolves no executable entry.
  Refusal, empty input, EOF, a prompt error, or interruption before the approval write keeps it unapproved.
- Given exporter approval, Core re-reads the saved global record and resolves the matching entry. Approving code
  extensions does not approve an exporter; approving an exporter does not enable code extensions.
- Given a Project package with the same identity or a Project approval record, the user's exporter resolution and
  approval remain unchanged. An exporter-only package in an auto-discovered `extensions/` directory contributes no
  Session extension and has an invalid exporter declaration.
- Given a change to ID, source, real installed path, or version, Core reports the exporter unapproved without a settings
  write. Reinstalling asks again. Local file edits without a version change keep approval.
- Given removal, the source's approvals are deleted, other approvals remain, and a later reinstall asks again.
- Given valid credential fields, discovery exposes them. Malformed, duplicate, or oversized fields invalidate the
  declaration. Changing only valid credential fields preserves saved code approval.

Package update trust policy and reconciliation of historical code-extension consent remain deferred. Existing
unrestricted or filtered code-extension registrations are preserved, not relabeled as historical consent.

**Requirement: Customize tools while keeping workflow capabilities.** A definition names tools individually with
`tools`, by group with `toolSets` (`read`, `write`, `docs`, `shell`, `web`), or both; the highest layer that sets
either key defines the list. An Agent with neither key in any layer is conversation-only. Required workflow tools stay
available. An unknown set name fails with source-specific guidance. `delegate_agent_read` and `delegate_agent_write`
grant one delegation mode each. Guide saves ordinary Markdown documents on explicit request and generates
[images](#image-generation) when configured; Plans, ADRs, and Work Records stay with their own workflows.

**Requirement: Limit shell commands per Agent.** `bashAllowedCommands` limits the shell commands an Agent starts through
RunWield; shell access itself comes from the Agent's tools. Lists add up across layers, `[]` allows no commands, and
`null` resets a definition to unrestricted. A delegate's limit always includes its parent's restriction, and a
delegate has shell access only when its parent has it. Guide and read delegates have inspection defaults; read
delegates also inspect PRs, MRs, issues, and repositories through `gh` and `glab`. The same check applies to foreground
and background shell starts. A denial states the reason, the allowed commands, and how to report a blocker. This is a
best-effort workflow guard for RunWield's own shell tools. See
[customization](../user-documentation/customization.md#agents).

**Requirement: One Skill catalog.** Core uses one catalog for listing, model advertising, and invocation, in this order:

1. project `.wld/skills`
2. project `.agents/skills`
3. home `~/.wld/skills`
4. home `~/.agents/skills`
5. bundled skills

Project and home `.wld` skills can replace bundled skills. An `.agents` skill with a bundled skill's name or alias is
left out of the catalog. With external skills
disabled, the catalog uses project `.wld`, home `.wld`, and bundled skills. The bundled `review` Skill reviews a
user-selected PR or change against project standards, the requested behavior, and test strength; it complements the
workflow Reviewer.

**Requirement: Portable skills install independently.** Guide, Ideator, and Review are available from
[RunWield/skills](https://github.com/RunWield/skills) without downloading Core. They work in other coding agents and
projects without requiring RunWield-specific tools. Core maintenance detects changes to the portable skills, their
supporting documents, and the source definitions they adapt, so maintainers review wording drift before accepting it.

**Acceptance scenarios:**

- A user installs the portable skills from their dedicated repository without installing Core.
- A source definition or portable skill changes; the synchronization check fails and names the files requiring review.
- A new supporting document or unintended published skill is detected; validation reports it rather than silently
  accepting a stale inventory.

**Requirement: Named Invocations keep their full expansion.** Skill and Prompt Template invocations inject full
instructions when invoked and reach the active model with the current Agent's instructions and tools. The saved
expansion stays available through follow-ups, compaction, and resume. Prompt Templates display rendered content; Skills
display their compact invocation. Built-in command names take precedence on every surface.

**Requirement: Prompt Templates behave as typed messages with optional Session settings.** Core submits a rendered
Prompt Template through the ordinary user-message path. Its optional Agent, model, and thinking settings persist for
follow-ups and resume; omitted settings inherit from the Session. A new Session without selections uses Operator.
Invalid settings fail before submission. A template that requests a different Agent during an unfinished workflow
offers **Open in new session** or **Cancel**; the original workflow Session stays resumable. Clients that cannot show
the choice explain how to run the template in a new Session. Model or thinking changes
alone keep the workflow owner.

**Requirement: Bundled maintenance prompts.** `/commit` groups, commits, and pushes pending changes. `/release` runs the
repository's release workflow and asks its release choices as structured questions, on clients that support them,
before any release command. `/code-optimizer` improves
maintainability. `/test-seams` runs with Engineer as an advisory audit of tests that replace product-owned behavior:
it reports concrete locations, ownership evidence, uncertainty, and real fixture alternatives, and asks the user's
disposition before it records findings. An empty result is a bounded observation, not a clean bill of health.

**Requirement: Trusted MCP tools.** Users configure optional stdio MCP servers once and call their tools from any root
Agent, including after handoffs and Session continuation. ACP-supplied servers are Session-scoped, and each Session's
servers are independent of other Sessions. Delegated and validation Agents keep their own tool ceilings. Results keep
text, images, structured output, and server errors, and progress reaches the active surface. Tool-list changes reach the
next model request, and root Agents can list and read server resources. A call canceled while queued never runs. MCP
adds prompt context only for tools in use. MCP failures leave the Session usable with redacted diagnostics. `/mcp` shows
server status and `/mcp reconnect <server>` reconnects. CLI tools remain the preferred integration path; see
[customization](../user-documentation/customization.md).

**Acceptance scenarios:**

- Given `planner.md` named `Plan Designer`, message headers and the footer show `Plan Designer` on every Execution
  Backend; routing uses `planner`.
- Given a project definition with `toolSets: [read]` over Operator, the Agent has read tools plus Operator's workflow
  tools; `toolSets: [reed]` fails and names the valid sets.
- Given a restricted parent, a delegate's shell commands stay within the parent's limit.
- Given a read delegate with authenticated forge CLIs, it lists and views PRs, MRs, diffs, and issues.
- Given a project `.agents` Skill, the catalog selects it before home skills; a project `.wld` Skill can replace a
  bundled one.
- Given a Skill or Prompt Template invocation, its full expansion reaches the model and survives follow-up and resume.
- After installation, `/skill:review` reviews a user-selected change.
- Given `/test-seams`, Engineer reports findings with evidence and alternatives and asks before recording them.
- Given `wld /commit` without settings, it runs with Operator's configured model and thinking level.
- Given `/release` while Planner is discussing a change, the user chooses a new Session or Cancel; the planning
  conversation stays resumable.
- Given `/release` from a Router Session, the release choices appear as a structured interview; canceling it leaves
  the repository as it was.
- Given configured MCP servers, root Agent handoffs keep the tools; a failing server leaves the Session usable with a
  redacted warning.
- Given a server announces new tools, the next root request includes them.

### Models and providers

**Scope and maturity:** Current baseline. Remote model execution is target scope in
[Remote connection](#remote-connection).

**Requirement: Change models without losing Session or workflow context.** Users choose models and providers while the
Session and workflow stay the same. The selected model and its requirements are visible across clients.

**Requirement: Curated model presets.** Core bundles `codex`, `agy`, `opencode`, `claude-mixed`, `claude-opus`, and
`codex-claude` presets with visible model assignments and access requirements. Users pick them in the preset selector
or with `activeModelPreset`. Project presets take precedence over personal presets, and personal over bundled, by
name; each replaces the whole lower definition. Users can copy a bundled definition into settings to customize it.
Updates keep personal and project settings, and bundled presets stay selectable when their cache cannot be written.

**Requirement: Flexible model configuration.**

- RunWield stores model and auth configuration in its own settings paths and migrates older Pi configuration once.
- Users override models per Agent, with Agent, default, and provider resolution rules.
- Validation Repair Engineer uses Engineer's model and thinking level when it has none of its own.
- Pi-authenticated providers, OpenAI-compatible discovery through `/models`, and local or custom providers through
  `models.json` are supported.
- Claude CLI is available as `claude-cli/sonnet`, `claude-cli/opus`, `claude-cli/haiku`, and `claude-cli/fable`.
- Antigravity CLI offers its Flash and Pro families and thinking levels.
- Vision fallback covers text-only models.
- Prompt-cache warming stays off; a user-facing warming setting is deferred.

**Requirement: Recover from temporary model-service failures.** Pi-backed requests retry temporary connection,
rate-limit, and server failures, including `Unexpected EOF`, under the [retry
settings](../user-documentation/settings.md#retry) (by default three retries after 2, 4, and 8 seconds). Completed tools
run once, and partial output and diagnostic evidence are kept. Notices show failures, scheduled retries, and exhaustion
in plain language; saved history shows a neutral notice. Authentication, quota, invalid-request, and context-overflow
failures get a clear notice and the user decides. Cancellation stops retries quietly. Exhaustion ends the current model
attempt and states how to try again; [Session continuity](#session-continuity) and [workflow
recovery](#workflow-completion-and-automatic-recovery) keep the Session and workflow.

**Requirement: CLI Execution Backends.** Claude CLI and Antigravity CLI run inside a RunWield Session, and RunWield
keeps the transcript, workflow, resume, and replay. Setup uses the installed CLI and its own sign-in; the first turn
reports missing executables or sign-in with the backend's setup action. History shows the RunWield-visible activity
of each backend. RunWield Connect is the separate mode in which an external host owns the conversation; see the
[Connect PRD](runwield-connect-prd.md).

- **Claude CLI steering:** Text Steering Messages reach the active Claude CLI turn, including turns with only native
  tools. Each message stays pending until Claude acknowledges it, then enters history once. Up recalls the latest
  pending message; Esc recalls pending messages and stops the turn.
- **Antigravity:** Unsupported model selections and attachments explain what must change before a turn starts.
  History shows the selected model, thinking level, and backend. Native tool steps appear live and in
  replay as completed steps. Execution turns can run commands and create, edit, and read files in the working
  directory. First-run setup initializes empty configuration after approval and reports malformed configuration
  without overwriting it. A sign-in request during a turn tells the user to run `agy` in a terminal, sign in, and
  retry; the Session shows this guidance without login URLs or codes. Permission failures name the denied action once,
  with sensitive details redacted, stay visible in replay, and keep the pending request. See
  [Providers and Models](../user-documentation/providers.md#antigravity-cli).

Future and open questions: provider-specific prompt or temperature tuning where it materially improves behavior, and
provider support documented in terms of current configuration.

**Acceptance scenarios:**

- When the user changes a model, the Session and workflow stay the same and the model is visible across clients.
- Given no personal presets, Model Presets lists all six bundled choices with their models and required access.
- Given a personal preset with a bundled name, the personal definition takes effect in full.
- Given `Unexpected EOF` followed by a successful retry, the user sees the interruption and retry progress, then the
  answer, with completed tools kept.
- Given retries run out, the notice states the retry count and how to try again; history stays available.
- Given an authentication or quota failure, the user sees a clear notice for that failure.
- Given Validation Repair Engineer without its own model, repair uses Engineer's model and thinking level.
- Given a CLI backend without its executable or sign-in, the first turn shows that backend's setup action.
- Given an active Claude CLI turn, text steering reaches Claude before its next model step and appears once in history.
- Given a signed-out Antigravity CLI, the turn reports the terminal sign-in action promptly and can be retried after
  sign-in.
- Given an Antigravity Engineer turn, it runs a test command and creates a file in the execution workspace.

### Installation and updates

**Scope and maturity:** Current Linux/macOS shell installation and Candidate release baseline. Homebrew packages are
prepared; public availability waits for owner publication. Windows releases and checks, including WinGet manifest
preparation and submission, are paused by owner decision. Existing Windows assets and runtime code remain available. Runtime layout changes during upgrades follow
[Work protection](#work-protection).

**Requirement: Install through a shell installer or a package manager.** Users install RunWield as a standalone binary
with the shell installer or, after owner publication, through the `gandazgul/homebrew-tap` macOS tap or the
`Gandazgul.RunWield` WinGet package for Windows x64. `wld update` and `wld upgrade` update shell installs and print the
package-manager command for package-managed installs. Public docs mark package availability as pending until each
listing is public.

Homebrew:

- `gandazgul/tap/wld` for macOS Apple Silicon and Intel, and an independent `gandazgul/tap/mnemoteca`;
- package dependencies for Mnemoteca, Cymbal, Ketch (from Homebrew Core), agent-browser, and Git;
- Mnemoteca model setup and browser setup as first-use actions;
- Stable package installs update through the package manager; Candidate and exact-version installer options apply to
  shell installs.

WinGet (retained packaging capability; publication and checks paused):

- Windows x64 ZIP assets with `wld.exe`, package metadata, helper executables, and license notices;
- pinned helper URLs and SHA-256 values, with Git for Windows as a package dependency;
- bundled helpers available to RunWield and its child processes, with the global `PATH` unchanged;
- model and browser payloads downloaded to per-user locations at first use;
- `https://runwield.dev/privacy/` as the package `PrivacyUrl`;
- Stable manifests only. Automatic submission to `microsoft/winget-pkgs` is paused until the owner resumes it; while
  paused, releases prepare manifest artifacts.

**Requirement: Honor the displayed Candidate update default.** For shell installs, `wld update --rc` and
`wld upgrade --rc` accept Enter at `[Y/n]` as Yes, and `y` or `yes` in any case. Any other answer, including
end-of-input, cancels before download. `--yes` skips the question.

**Requirement: Find Bash on Windows.** Native Windows Agent Bash commands use `shellPath` when it is set. Otherwise
RunWield finds system-wide and per-user Git for Windows, custom Git installations whose `cmd` directory is on `PATH`,
and Bash on `PATH`. A missing Bash is reported as an installation prerequisite.

**Requirement: Isolate Candidate stabilization from feature work.** Maintainers cut RC1 from an explicitly confirmed
commit and stabilize later Candidates on the series' Release Branch with reviewed release fixes, while feature work
continues on `main`. Stable promotion uses the exact tested Candidate.

**Requirement: Qualify packages before publication and keep published bytes.** Candidate and Stable releases pass
native Linux/macOS archive and macOS Homebrew package checks before GitHub publication; a failed or timed-out check blocks
publication. Candidate checks leave Stable channels unchanged. Package recovery keeps the released tag and asset bytes,
verifies the existing assets, and resumes package publication. Missing or inconsistent assets stop publication.
Workspace runtime packaging waits for the final server manifest and its imports; it does not bundle an intermediate
manifest placeholder. Unix archives include the source license notice; new MIT release publication rejects a missing
or incorrect notice while recovery preserves already published bytes.

**Acceptance scenarios:**

- Given a Homebrew-owned `wld`, `wld update` prints `brew upgrade gandazgul/tap/wld`; given a WinGet-owned `wld`, it
  prints `winget upgrade --id Gandazgul.RunWield --exact`.
- Given a standalone Unix install, `wld update` uses the tag-pinned shell installer.
- Given a loose Windows executable, `wld update` gives Windows package guidance.
- Given missing helpers in a package install, RunWield tells the user to repair the package.
- Given a new Homebrew install, Ketch comes from Homebrew Core.
- Given a release while Windows publication is paused, it publishes only Linux/macOS assets, runs no Windows jobs,
  and prepares no WinGet manifests. Existing Windows releases remain unchanged.
- Given an available Candidate, Enter or Yes starts the update; No or Ctrl-D cancels it.
- Given Git under `%LOCALAPPDATA%/Programs/Git`, an Agent creates a branch through Bash without `shellPath`.
- Given RC1, the Candidate tag and new Release Branch point to the same committed source.
- Given feature work on `main` and a fix on the Release Branch, the next Candidate contains the fix and excludes the
  feature work.
- Given a tested Candidate and an advanced Release Branch, Stable uses the tested commit.
- Given a failed package check, no GitHub Release is created.
- Given a new MIT release archive with a missing or incorrect license notice, publication is blocked.
- Given an Astro server entry whose manifest is still being written, Workspace runtime packaging waits for the final
  manifest before it invokes the bundler.
- Given Stable assets published and a failed tap publication, recovery reuses the verified assets and the tag.
- Given a native Windows package check, the packaged Agent creates a Git branch and the Dashboard stream completes.

### Remote connection

**Scope and maturity:** Current connection-only subset on the approved Linux `sct` pilot with development builds.
Ordinary remote Sessions, remote project work, remote model execution, and Session recovery are target scope in the
[Remote SSH proposal](remote-ssh-prd.md).

**Requirement: Resolve a remote location.** `wld remote <host>[:<directory>]` uses OpenSSH configuration and resolves
the remote account's home or an existing requested directory. A connection-only TUI shows the canonical remote
directory. Relative paths and `~` refer to the remote account. Git is optional; discovery reports a repository or
worktree when one exists.

**Requirement: Prepare a matching development runtime.** The launcher uses an explicitly built development bundle from
one checkout (see [contributing](../contributing.md#remote-development-bundle)). It verifies build and protocol
identity, version, and checksum, then stages and checks the executable in a private remote cache. A later connection
repairs an interrupted stage. The remote profile and package-managed installs stay as they are. The remote host needs
an OpenSSH server with terminal allocation and loopback forwarding, `python3`, a writable private cache, SSHFS/FUSE,
and a glibc Linux x86-64 or ARM64 system.

**Requirement: Keep personal files on the laptop.** The connection mounts laptop `~/.wld` at a private remote root
through stock SFTP/SSHFS; the remote project's `.wld` stays on the server. Edits to personal Agents, prompts, and
Skills through the mount change the laptop files directly. This is direct trusted-host access: the server can read
every laptop `~/.wld` file through the mount, including credential files. It is not confinement.

**Requirement: Clean up connection-owned processes.** A supervisor watches the control channel and stops owned
processes, including the personal mount, on normal exit or connection loss. Interrupted setup keeps the profile,
project files, and verified cache. When the supervisor cannot confirm process exit, it reports the uncertainty.

**Acceptance scenarios:**

- Given a remote home without Git, connecting without a path shows that home.
- Given a path through a symlink or Git worktree, the view shows its canonical directory; a missing directory fails.
- Given a matching bundle and a supported host, connecting transfers or reuses a verified executable, mounts the
  personal root, and opens the connection view.
- Given a mismatched artifact or missing prerequisite, connection fails with the cause.
- Given a personal Skill edited through the mount, the laptop sees the change, and the project `.wld` stays remote.
- Given connection loss, the supervisor stops its own processes and leaves unrelated server processes running.
- **Target:** Given a provider authenticated only on the laptop, a remote Agent's model request runs in the laptop
  runtime without a second sign-in or model substitution. The trusted server can still read laptop `~/.wld` files.

### Work protection

**Scope and maturity:** Current baseline. Additional command and governance controls are open questions.

**Requirement: Enter project runtime state safely.** Core enters project runtime state before normal project-local
runtime reads, locks, or writes. RunWield 0.11 adopts eligible 0.10 state once, including unfinished publications and
saved repairs. Unsafe layouts receive a retryable refusal with the reason and the safe paths, and all user work stays in
place. Adoption is one-way; after it, use only the new version. Each entry sees newly tracked runtime paths, newly
attached worktrees, and changed runtime files. See
[ADR-017](../adr/017-project-runtime-state-under-wld-internal.md).

**Requirement: Reconcile leftovers automatically.** When a Plan is selected, RunWield reconciles files recreated by
older processes, stale runtime records, and concurrent migrations. Current progress, review decisions, and
publications stay authoritative, and original files stay recoverable.

**Requirement: Keep Project Runtime State out of repository changes.** The managed `.gitignore` block contains
`.wld/internal/`. User `.wld/settings.json`, `.wld/agents/`, `.wld/skills/`, and `.wld/prompts/` stay normal repository
content. When Git tracks or stages runtime state, or newly published history contains it, Core refuses checkpoint and
publication and reports safe cleanup paths. Core reports a broad user-written `.wld/` ignore rule, because it also hides
configuration, once per Project and change; `wld doctor` reports all current issues.

**Requirement: Preserve user work and require deliberate destructive actions.** Users keep control of their work
through reviewed intent, isolated execution, recoverable baselines, validation, independent review, optional Code
Review, and delivery checks. Shell guardrails respect the user's permissions and project instructions. Local browser
access is private by default; shared review uses explicit access.

Worktrees, branches, and Plan files can contain user work. Automatic cleanup requires proof that nothing can be lost;
otherwise the user decides. Unclaimed worktrees are kept. Settled journals, stale locks, and obsolete internal records
are RunWield's to clean automatically.

Open product questions:

- When does requiring a clean checkout protect user work enough to justify interrupting execution?
- What further controls over dangerous commands do users need beyond their project instructions?
- Is architecture governance useful as a dedicated workflow or as an optional policy?

**Acceptance scenarios:**

- Given untracked runtime state and changed user `.wld` configuration, checkpoints and publications include the
  configuration and leave runtime state out.
- Given runtime state already tracked or staged, Core refuses with safe paths and keeps the worktree, index, files, and
  refs.
- Given a long-running process, a newly staged secret or attached worktree is detected at the next entry.
- Given a broad `.wld/` ignore rule, Core keeps it and reports what it hides.
- Given eligible 0.10 state, `wld doctor` reports pending adoption read-only; Doctor repair adopts it once.
- Given unfinished 0.10 publication, adoption keeps the publication copies and repairs, and publication resumes.
- Given an unsafe layout, Doctor keeps all named paths and explains the conflict.
- Given files recreated by an older RunWield process, selecting a Plan reconciles them while current progress and
  decisions stay authoritative.
- Given ordinary symlinks in the repository, publication keeps them as Git content.
- Given a legacy collaboration secret in a linked checkout, entry adopts it into the primary store.
- Given Git tracks a collaboration secret, Doctor names the path and explains untracking, history removal, and
  rotation, without printing the secret.
- Given an unclaimed worktree without proof of disposability, it stays until the user decides.
- When recovery would reset changes or delete unmerged work, the user confirms first.

### Session continuity

**Scope and maturity:** Current shared Session baseline. Reliable end-to-end continuation is required wherever gaps
exist. Runtime boundaries are in [ADR-010](../adr/010-session-runtime-sibling-adapters-and-acp.md); storage and
synchronization are in [ADR-015](../adr/015-file-authoritative-session-bundles.md).

**Requirement: Continue the same saved work across clients.** Users work with several independent Sessions through
the TUI, ACP, and Workspace. Each Session keeps its project, conversation, selected Agent and model, and workflow
context. Starting, loading, sending, canceling, and reviewing history behave the same on every client. The same
developer can leave an idle TUI open, continue from a phone, and return to the new conversation; an open screen is a
view of the Session.

Required outcomes:

- a new Session enters history and the project runtime with its first submitted message;
- the planning Session chooser labels each Session with its title, or its first meaningful user message, and lists
  Sessions that have one of them; selecting a label continues that Session even when two labels match;
- the owner reopens and continues saved Sessions directly, with local use independent of Workspace registration;
- open surfaces update when another surface saves work, and unsent drafts stay;
- a long conversation or a completed Plan accepts the next user message;
- a retried submission after a connection failure runs once;
- automatic workflow and repair handoffs keep the original request as context, without repeating it as a new user
  message;
- running work continues when a browser leaves or reloads;
- after a process failure, saved history stays available with a clear next action, and unfinished work waits for the
  user's choice;
- Plan review and execution use the current Plan and the user's explicit approvals; see
  [Plan review](#plan-review) for `/plan-review`;
- saved [Named Invocation](#agent-and-skill-customization) expansions continue through follow-up, compaction, and
  resume;
- intact local Sessions stay usable through TUI and ACP when Workspace registration or pairing is rebuilt.

**Requirement: Export or share the complete Session.** `/export` writes every committed Session Transcript Segment in
order, with Session identity, name, project path, timestamps, artifacts, and Plan Associations. HTML is a self-contained
RunWield page with segment headings, Markdown messages, expandable tools, and collapsed thinking. JSON preserves each
segment's raw entries in a versioned `runwield.session-export` document. `.jsonl` export is retired; the command points
to `.json` instead. Reads verify all segment evidence and do not change the Session. During a turn, they include only
committed history. A new empty Session can export without creating a saved Session.

`/share` uploads HTML and JSON to one secret GitHub Gist and reports the Gist URL and an HTML preview link. Both files
include thinking and full tool output. Anyone with the link can read them. Current scope excludes in-memory Delegated
Agent, validation, and AI review transcripts and Background Task logs; results recorded in the parent transcript stay
included. This Gist path is separate from the undelivered
[Workspace snapshot sharing](runwield-workspace-prd.md#session-snapshot-sharing) and
[browser download](runwield-workspace-prd.md#session-export) capabilities.

**Requirement: Archive a Session reversibly.** Archive hides a Session from ordinary history and TUI resume lists,
through ACP or Workspace. Archive and Unarchive keep the Session ID, every transcript segment, Plan Associations, and
workflow state. Associated Plans still link to it. Direct links and explicit loading work and keep the archive state.
Older Sessions are active. Workspace Project settings provides
[Archived Sessions](runwield-workspace-prd.md#project-access-and-navigation).

**Requirement: Explain OS resource failures.** Each CLI command runs under a supervisor. When the working runtime
aborts, the supervisor restores the terminal, reports a nonzero exit, and explains recognized file-descriptor, memory,
or process exhaustion on stderr. Protocol stdout stays clean. Catchable submission errors show the same guidance and
restore the draft. The supervisor forwards termination signals and returns the command's own exit status. It keeps
saved work and workflow state as they were and never replays the failed command; after the user resolves the limit,
`wld --continue` reopens the last saved Session. Unsaved input from a native abort can be lost.

**Requirement: Route attention to the latest input surface.** Notifications go to the surface (TUI, Workspace, or ACP)
of the latest accepted user input: a message, steering, a queued follow-up, or an answer. Opening a Session,
reconnecting an observer, rejected input, and automated continuation keep the current destination. Workspace-originated
turns always send an Agent-stop event at settlement. Delivery follows the destination's permission and notification
settings. ACP reports turn completion through its protocol, and only the destination surface alerts.

#### Bounded model and tool loops

**Requirement: Stop runaway model and tool loops.** Each Pi-backed request has a durable budget of 100 model
requests, counting each Pi turn start, including automatic tool continuations. A provider retry counts when its next
turn starts; the retry notification is not another request. The count is recorded before each request and remains
attached to the same request when its controller-owned task resumes after failure or process restart. Automatic retries
and corrective nudges of one unfinished review also share that review's request budget; a later review round starts a
new budget. A new user instruction starts a new request budget. Stop before starting another model request once the
budget is exhausted, preserve the Session, and show the reason and a clear action to send a new instruction. Also stop
the current request when an exact tool call and result repeats three times consecutively, or an exact cycle of up to
three tool call/result pairs repeats three times. Persist only hashes of tool names, arguments, and results for this
check; never duplicate raw tool inputs or outputs into guard records. A saved stop blocks that request after Session
reopen and does not mark the Session or its enclosing workflow complete.

**Acceptance scenarios:**

- Given a model repeatedly requests the same tool with the same result, when the third identical pair completes,
  RunWield stops before another model request and records a visible, recoverable stop reason.
- Given a model repeats a cycle of two or three exact tool call/result pairs three times, when the cycle completes,
  RunWield stops before another model request and records a visible, recoverable stop reason.
- Given one request reaches 100 model requests, when a retry or process restart continues it, RunWield stops before
  request 101. A provider retry contributes one count when its next turn starts.
- Given one unfinished automatic review, when a controller retry or a regenerated corrective nudge starts another
  backend attempt, RunWield keeps the same request budget and stops before model request 101; the corrective text still
  reaches the model. A new review round or a new user instruction starts a new request.
- Given an interrupted controller-owned task is explicitly resumed after process restart, RunWield keeps its request
  ID and count even if recovery regenerates the prompt; matching text from fresh user input starts a new request.
- Given a loop guard stops a request, when the Session is reopened, the stop remains in its transcript and the user can
  send a new instruction; replaying the stopped request does not call the model or complete successfully.

#### Background tasks

**Requirement: Run bounded background work.** An Agent with shell authority starts an independent command with
`background_task`, checks its status, or cancels it by task ID while it keeps working. `delegate_agent` with
`background: true` runs an isolated read-only Background Task; a background request for write delegation fails before
launch. Background
shell starts follow the Agent's [shell command limit](#agent-and-skill-customization). Each Session runs up to five
tasks in its host process; a sixth start fails at once. Task IDs control only their own Session's tasks. Completed
status includes the outcome, with short output inline and longer output in a local log. Tasks live in their host
process and end with it.

**Requirement: Receive task results without another user message.** A completed task sends its result to the parent
Agent during its turn or starts a managed result turn when the Agent can accept one. The current specialist receives
results after the starting turn settles. Task output is information for the Agent; questions, reviews, Pair
checkpoints, Plan approval, and workflow completion keep their own authority. Normal turn settlement and browser tab
closure keep tasks running. Stop and host shutdown cancel active tasks and their late results.

**Requirement: Finish cleanly with running tasks.** The first eligible `task_completed` call while tasks run is
rejected with the running task IDs and kinds and the explanation that the next eligible call cancels them. The Agent
can wait, cancel tasks, or call again. Accepted completion suppresses pending and queued results. A cancellation is not
a test result.

**Acceptance scenarios:**

- Given planning, execution, and repair segments, `/export` includes them in order with Session Manifest facts; JSON
  preserves their raw entries and HTML shows their messages and expandable activity.
- Given a changed seal or missing transcript, export fails without publishing a partial Session.
- Given `/export out.jsonl`, the command writes nothing and explains how to use `.json`.
- Given an empty Session, export succeeds without creating Session persistence.
- Given authenticated GitHub CLI access, `/share` creates one secret Gist with HTML and JSON and prints both the Gist
  URL and its HTML preview URL; recorded parent results stay included but in-memory helper transcripts do not.
- Given a saved Session archived through ACP or Workspace, ordinary history and TUI resume omit it, its Plans link to
  it as archived, and its transcript and state are unchanged; Unarchive restores the same Session.
- Given a fresh empty composer, opening it creates no runtime state; the first submitted work does.
- Given multiple planning Sessions for a Plan, `/load-plan` shows their titles or first messages, and selecting a
  label continues that Session.
- Given an idle open TUI, when the owner sends the next message from a phone, the same Session continues and the TUI
  shows it on return.
- Given a browser reload or a follow-up to a completed Plan, history stays usable and drafts survive.
- Given a resumed Prompt Template or Skill invocation, the follow-up receives the saved expansion and earlier tools
  stay as history.
- Given a repeated submission after a connection retry, the work runs once.
- Given a repair segment saved under its execution worktree, resuming it from the Project root continues the same
  Session.
- Given exhausted file descriptors, the supervisor restores the terminal and shows the open-file guidance and the
  continuation command.
- Given a detached service that keeps stderr open, the command returns its own status.
- Given a long command started with `background_task`, the Agent continues at once, status reports the outcome, and a
  sixth task start fails.
- Given a read-only background delegate, it finishes and reports after the parent turn ends.
- Given a task that finishes after the turn, the current specialist receives the result without a user message.
- Given a pending question or review, task output waits for a safe turn and leaves the notification destination as it
  was.
- Given running tasks, the first `task_completed` is rejected with the task list; the next one cancels them and is
  accepted.
- Given Stop, active tasks and their child processes end and late results are suppressed.

### Capability-organized product requirements

**Scope and maturity:** Current bundled authoring guidance. Model compliance is not certified.

**Requirement: Write and maintain observable requirements in the user's PRDs.** Ideator, Planner, and Architect describe
capabilities in a project's PRDs through named observable requirements and representative acceptance scenarios. They
follow the user's existing document structure and label current, target, and deferred behavior. Each shared requirement
has one owner; Plans and Epics link to it and carry the verification and document updates that changed behavior needs.
Each project keeps its own document names and layout, and bounded fixes proceed without a new PRD.

PRDs hold user needs, outcomes, and scope; ADRs hold architectural decisions; Plans hold implementation; Work Records
hold delivery evidence. Scenarios guide verification; test coverage is established in Plans.

**Acceptance scenarios:**

- Given a project with one PRD, Ideator writes an agreed feature as capability requirements and scenarios within that
  PRD's convention.
- Given a changed capability, Planner or Architect links its owner, keeps unaffected behavior, and includes
  verification and PRD updates in the implementation scope.
- Given an unimplemented proposal, the revised PRD labels it target.

### Usage measurement and export

<a id="usage-measurement-and-export"></a>

**Scope and maturity:** Current local recording is opt-in and stays on the device. The v2 observation layer includes
linked execution, usage, command, and workflow-outcome records. The journal writer implements bounded cross-process
locking, sync, epoch control, and repair. Core reporting, history deletion, exporter approval, and export coordination
are current. A first-party [Langfuse exporter package](../../packages/langfuse-exporter/README.md) implements the
Langfuse Cloud v4 protocol. The personal Workspace usage report and
[usage settings](runwield-workspace-prd.md#personal-usage-and-outcomes) are current.

Installed exporter discovery and [saved host approval](#metrics-exporter-approval) are separate from destination
consent. Workspace usage settings manage Export grants and write-only credentials through Core functions. Executable
code approval remains host-only through `wld install`; there is no command-line destination setup flow.

**Requirement: Record structured workflow observations locally, with opt-in and no sensitive content.** With
`workflowMetrics` enabled, RunWield records ordered tool usage, token usage, cost, context snapshots, compaction,
retries, response latency, and slash commands to a local JSONL file under `~/.wld/workflow-metrics/`, one per primary
Project. The directory is `<sanitized-basename>-<full-sha256-of-real-primary-root>`, with a basename of at most 40
characters. Linked worktrees and symlink aliases share their Project's file; distinct roots do not. Recording is off by
default. Core adopts an unshared legacy journal without changing its bytes or grant offsets. A collided legacy journal
is left in place; each new history receives only attributable rows and an explicit gap, with existing grant starts moved
to the new end so copied rows do not export. If another process is adopting the legacy journal, export defers discovery
until a later cycle without changing consent or delivery positions. Owner reports keep canonical Project identities
and show unavailable history during that wait; settings remain readable without authorizing a grant. Other discovery
data errors remain errors.

Records hold metadata only: prompts, diffs, tool results, file contents, and credentials stay out. Bash commands are
reduced to coarse command labels; memory calls record their action and scope. Usage records keep exact token, cache,
and cost values. Each execution records its available tools. Background tasks and delegates keep links to their
parent. Missing measurements are marked unavailable or partial.

Each Code Review decision records a `code_review_decision` event with the decision, prior AI review round count,
AI approval or human takeover outcome, and Code Review round within the delivery attempt. Feedback presence and
annotation count are metadata only; feedback text, annotation content, and images stay out of metrics. Missing AI
review evidence is marked unavailable, not approved.

**Acceptance scenarios:**

- Given `workflowMetrics` off or unset, no metrics records are written.
- Given it is on, an Agent turn records ordered events with tool exposures, tool durations, model usage, and latency.
- Given a Bash command with arguments or pipelines, the record holds coarse command labels only.
- Given background delegated work, records keep the parent tool call, parent execution, and task identity.
- Given a tool error, rejection, cancellation, or incomplete call, the record shows the observed outcome.
- Given a template or Skill command that starts Agent work, one invocation ID links it to the execution; a picker
  closed without a choice records cancellation.
- Given manual `/compact` outside an Agent turn, the compaction is recorded under the Session and command.
- Given AI approval followed by Code Review changes requested, one decision event identifies both outcomes and the
  prior AI review round count without feedback or annotation content.
- Given human takeover at the AI round limit and a second Code Review request for changes, the event identifies
  human takeover and Code Review round two. Closing or skipping review records no decision event.

**Requirement: Usage observations describe only content-free Core activity observed while enabled.** A Usage observation
belongs to one primary Project history and collection epoch. Session and Plan links identify observed relationships;
they are not substitutes for Session Transcript or Plan Association evidence. A Usage observation is neither a
transcript nor a billing charge. Missing measurements remain unavailable, not zero.

**Requirement: Supported backends preserve their measurement detail and upstream limits.** Pi retains native per-request
measurements linked to assistant turns. Claude CLI retains each result's turn usage once with a distinct source identity;
turn cost is the change in the process running total. Request measurements and per-model detail remain alternatives
where they overlap. Core retains these alternatives locally but excludes redundant alternative rows from
all metrics exports. New Claude CLI and agy CLI usage rows identify input as excluding cache tokens; old rows keep their
recorded basis. agy CLI retains turn-cumulative tokens and records USD cost as calculated when its model ID exactly
matches the built-in Google price catalog. A missing catalog entry stays unavailable; a preview or alias model is not
price evidence. Upstream-reported cost stays distinct from calculated cost. Pi and agy reasoning counts are recorded as
a subset of output, not added to it. Missing reasoning or cache-write counts stay unavailable.

Usage rows record start and end times only when observed for that row. CLI aggregate timing measures the subprocess
turn, not model-server latency. Pi assistant timing is captured during its turn, not at settlement. Claude alternative
request rows and other unobserved rows retain null timing. Old rows are not rewritten.

Runtime events, saved entries, replay totals, the terminal footer, and Guided Review distinguish supplied zero from
absent measurements. Replay reports compaction usage separately from assistant-message totals and marks partial category
coverage. Historical zero-filled CLI entries cannot be reconstructed as measured or unavailable.

**Requirement: Langfuse export preserves Core evidence without content or duplicate totals.** The first-party package
uses Langfuse Cloud v4 OTLP HTTP ingestion, not legacy ingestion. Each attempt sends one immutable observation. Model
requests become generations; CLI turn aggregates become one explicitly labeled generation. Workflow and tool facts use
fixed-name spans. Related facts have deterministic trace and parent IDs. No parent is resent to add a child. No prompts,
input/output content, events, exceptions, local paths, arbitrary text, or automatic resource attributes are sent.

Native usage buckets are non-overlapping. Cache-inclusive input is reduced only when both cache counts are known.
Unknown cache basis keeps counts in metadata only. Reasoning is split from output. Partial rows send only known buckets,
never zero for missing counts, and carry `usage_complete=false` with missing-bucket flags. Langfuse sums those sent
buckets: its partial-row token total is a known subtotal, not a complete measurement. Cost carries Core's reported or
calculated source. Partial or unavailable cost sends neither cost details nor a native model name. A known partial
subtotal stays in metadata with `cost_complete=false`, not in the vendor's native cost total. Cost coverage is separate
from token coverage: complete catalog cost can accompany partial tokens. Older rows keep their prior coverage rule.
Reported zero stays zero. A native model name is sent only with supplied complete cost. Langfuse can add its own
calculated cost to vendor totals without an estimate label; that is destination behavior, not additional RunWield cost
evidence.

Measured generation timestamps come from the row's observed edges. An unmeasured generation has zero duration at its
observation time and `timing_measured=false`; this does not establish measured zero latency. The package performs no
retries and installs no instrumentation. It distinguishes accepted, proven non-acceptance, and uncertain delivery under
Core's delivery policy. Bounded public-API readback compares observation identity, native usage and cost, and
availability; asynchronous absence is not rejection. A documented empty native map with a zero total, or empty native
model name, can represent absence when the original availability metadata still matches. This does not invent a
measurement. Native costs permit only floating-point roundoff; missing values and supplied zero remain distinct.
Identical unmerged readback versions can confirm one immutable fact only when every returned field agrees; conflicting
versions cannot. Vendor-added buckets, costs, or complete totals that contradict missing measurements remain mismatch
evidence. Protocol fixtures do not replace owner-authorized checks of native metrics in a disposable project.

**Requirement: Auxiliary calls use the same opt-in measurement history without duplicate accounting.** Each
RunWield-started auxiliary model call captures consent and collection and history epochs before invocation. External
Guided Review and manual compaction persist an `execution_started` before model work and settle with
`execution_finished`. Vision captures its active execution at call start or starts and settles an auxiliary execution
when none exists, locally or remotely. Auxiliary starts have `dispatchKind: "auxiliary"` and `userInitiated: false`;
they add no Active day. A start without a finish appears as incomplete.

Each `see_image` fallback records one request-basis observation. Error or aborted responses retain supplied usage with
partial or unavailable coverage; a thrown error without a response records unavailable usage with a content-free reason.
Guided Review uses existing runtime observations for `wld guided-review`, without a second job total. External guide
commands record one turn-basis aggregate per settled job, with unavailable categories when the command provides no usage.
Every guide job keeps its generation outcome with the start-time epochs. The explicit remote model proof turn is not a
Usage source; its vision fallback calls are.

**Requirement: Cross-process recording has bounded lock acquisition and truthful persistence.** All writers to the
primary Project journal take an OS file lock before the same `proper-lockfile` lock, including linked worktrees and
separate Core processes. The OS lock does not expire while a writer is paused. Current epoch checkpoints avoid scans of
retained history. If a checkpoint is missing or behind, each lock acquisition reads at most 256 KiB of new journal bytes
and commits recovery progress. A recording call reports non-persistence while recovery is pending and starts automatic
recovery without waiting for more observations. Recovery releases the guard between chunks. Export authorization and
history clear wait for a complete checkpoint before taking their action. Later recording resumes after recovery;
retained rows stay unchanged and skipped observations are not replayed. Each recording invocation bounds lock
acquisition to approximately one second. A persistence success requires synchronous append and file sync; it does not
promise complete coverage. Timeout, compromised lock, storage failure, disabled collection, and
stale collection boundaries return non-persistence without blocking delivery or claiming saved data. Captured
observation identity and epoch stay fixed during an acquisition retry. No failed observation is queued for replay.
Model usage becomes reconciled only after confirmed persistence; a failed append stays explicitly retryable. Once an
execution loses a usage row, its settlement coverage is partial or unavailable, never a complete zero.

**Requirement: Collection epochs reflect observed boundaries, not inferred disabled durations.** The normal Workspace
recording control commits a fresh host-level generation and the global setting under the recording guard. Disable and
re-enable therefore preserve a boundary even without intervening appends. Projects with project-scope recording overrides
keep their epoch across global changes only when they explicitly set enablement (a boolean or their own boolean
`enabled` field). An empty Project setting inherits global enablement and generation boundaries. Direct settings-file
edits remain lazily observed. Journal appends hold the journal guard and a shared recording guard from the effective
settings read through the write, within the existing
one-second acquisition budget. Invocation consent and epochs are captured before work starts; work started while off or
in a stale collection epoch cannot settle into a later interval.

A previously enabled history may retain a disabled `collection_epoch` control transition without recording a disabled
Usage measurement. Unobserved intervals do not prove disabled durations. Re-enablement never replays missed activity or
reconstructs it from Session Transcripts. History epochs identify local Project histories independently of Session and
Plan lifecycles. The initial-history alias accepts concurrent first writers only within that first history; any clear
invalidates older captures, including `initial` captures from another process.

**Requirement: Workflow outcomes count observed operations, not inferred delivery.** Each validation attempt and repair
round has its own operation identity. Attempt numbers and round numbers are labels, not deduplication keys. A confirmed
publication observation uses a deterministic identity from the delivery attempt. Repeated cleanup does not count that
publication twice. Committed transitions keep their transition identity, allowlisted operation, and known stable Plan identity; review findings remain observed findings, not
claims of prevented defects. Tool fan-out is not model-request fan-out.

**Requirement: Publication recording precedes removal of attempt evidence and cannot gate delivery.** Both cleanup paths
await a bounded, non-fatal recording attempt before pruning. Confirmed publication is observed even when cleanup keeps
user files or a branch. A retained controller marker distinguishes complete, incomplete, and unverified observation
coverage. Recording reuses classification from the retained delivery and its captured history epoch; redundant
metadata reads do not consume the append budget. Before recording, Core retains incomplete coverage with a content-free
reason. Only confirmed persistence makes it complete. Failed, timed-out, interrupted, and legacy unverified observations
are not queued for replay by later cleanup or restart. A recording failure does not block or reverse publication. A
process interruption cannot invent an observation. Git evidence and Plan Front Matter remain delivery authority under
[Execution, validation, and recovery](#execution-validation-and-recovery). Confirmed publication and deliberate user
abandonment remain the only delivery conclusions. An interrupted Agent turn is ongoing work, not abandonment. An open
Session without an observed delivery workflow is not an undelivered failure.

**Requirement: Plan attribution uses committed, time-scoped associations.** A Session observation links to a Plan only
when its committed Plan Association covers the observation time and transcript segment. A new association ends the
previous scope in that segment; a sealed segment ends its scope. General discussion has no Plan link. A Session that
touches multiple Plans does not assign each observation to every Plan. Model usage uses the known workflow Plan scope
and observed model time, not delayed reconciliation time. A later association cannot claim an earlier model call.
A delivery attempt's committed registry
association identifies its Plan independently of Session ownership. Missing attribution stays absent. Outcome records
retain operation, transition, or confirmed delivery identity and exclude free-form errors.

**Requirement: Repair preserves history and makes measurement gaps explicit.** Existing v1 rows stay unchanged; absent
v2 links or coverage are not inferred from adjacent rows. Locked repair truncates only an incomplete final line and
appends explicit `measurement_gap` evidence with reason `incomplete_append`. Interior corruption remains in the journal
and is surfaced with corrupt line numbers; it is not silently deleted or converted into measured zero.

**Requirement: Report collected usage with one Core query.** The caller provides authorized Project roots, a half-open
local-date period, and the host reporting time zone. Core reads only journals, including safe legacy fields. It returns
settled token subtotals, reported and estimated USD cost separately, latency, daily buckets, Project/backend/model
breakdowns, and stable local Session/segment/Plan identifiers. The recorded-through marker names the latest durable
included record, not the current clock. Worktree aliases count once. Queries do not read Plan contents or Session
Transcripts, construct writable Session managers, or contact models. A disposable cache reads new journal suffixes;
rebuilding it changes no source records.

**Requirement: Active days require human input evidence.** An Active day has an execution start marked by the Runtime as
user-initiated, or an explicit user command start. Automatic Plan dispatch, validation repair, generated background
results, isolated calls, and open windows do not count. Older execution starts without input provenance do not prove an
Active day. Usage belongs to the observation's completion day, whether or not that day is active. Completion time uses
`completedAt`, then `endedAt`, then the observation timestamp, not delayed storage or cleanup time. Incomplete operations
appear separately and receive no invented spend or latency totals.

**Requirement: Preserve delivery meaning in reports.** Published changes count distinct confirmed delivery attempts with
executable Plan identity. Epic containers and observations without known executable classification are excluded; the
report discloses those exclusions. Validation attempts and repair rounds remain separate counts. Ongoing workflows are
labeled as of their latest observation; only an explicit committed abandonment observation counts as abandoned. An
interrupted Agent turn is not abandonment. Delivery conclusions remain owned by
[Execution, validation, and recovery](#execution-validation-and-recovery).

**Requirement: Usage gaps differ from covered zero.** Disabled, legacy, unavailable, incomplete, and not-yet-collected
intervals are Usage gaps. They break a trend rather than draw zero. A complete enabled day bounded by recorded evidence
can show known zero. Absence alone proves neither enablement nor a disabled duration. Partial numeric fields retain
known subtotals with adjacent exclusion counts; missing cost is not zero. Alternative CLI representations do not add
usage twice. Local calendar boundaries remain correct across daylight saving transitions.

**Requirement: Keep and clear measurement history without changing development artifacts.** Records have no age-based
expiry and remain readable when collection is off or a Session is removed. Clear removes only selected Projects'
measurement rows, including legacy rows. It preserves Sessions, Plans, worktrees, configuration, and collection state.
Clear shares the writer lock, commits a fresh History epoch, and resets journal offsets and deduplication state. A
durable clear intent prevents crash recovery from exposing old rows. Delayed observations captured in an older epoch are
rejected across processes. Restart, cache rebuild, and legacy readers cannot restore deleted history. New activity
records normally after clear. Export reads pending payloads only from the journal. Clear preserves content-free delivery
fences and reports an already authorized delivery that cannot be recalled. Reporting marks a pending clear explicitly
in Project coverage while hiding old rows, so Workspace can offer a readable retry rather than treat it as settled data.

**Acceptance scenarios:**

- Given roots that differ only by a slash versus a hyphen, their reports, clear actions, and grants remain separate.
  Legacy adoption retains an unshared journal's bytes and grant offset. A collided legacy journal gives each Project
  only its attributable report rows, exports none of the copied rows, and leaves the legacy file unchanged. This also
  holds when the grant predates a legacy clear. A new grant after a later clear retains its own approval position.
- Given a held legacy adoption guard, export completes the cycle without sending. Owner reports show unavailable
  history, and settings remain readable without writing a grant. After release, reports show the retained rows and
  competing hosts adopt the journal and export only eligible observations once, with unchanged journal bytes, state,
  and grant positions.
- Given known token, cost, and latency observations, a query returns their exact settled values and backend/model
  breakdowns. An incomplete execution is listed separately and contributes no spend or latency total.
- Given model completion before midnight and cleanup afterward, usage belongs to the earlier completion day and period.
- Given a failed model-usage append followed by a saved execution finish, the report discloses usage exclusions, not a
  complete zero. A later successful retry cannot erase the degraded coverage.
- Given two Claude results in one stream, both turn measurements count once and cost equals the final running total;
  overlapping per-model alternatives add no totals.
- Given a disabled day, a legacy-only day, and a complete enabled day with no usage, only the covered day draws zero.
  Missing token categories or USD cost disclose exclusions beside their subtotals.
- Given the repeated hour at a daylight saving transition, each completed observation belongs to one local day. An
  observation at midnight belongs only to the next half-open day. Phone and desktop receive the same zone and marker.
- Given human input, an explicit command, and an automatic repair, only human input and the command make Active days.
- Given an observed delivery attempt that is interrupted, the report labels it ongoing as of its last observation, not
  abandoned. Explicit abandonment and confirmed publication are separate conclusions.
- Given selected Project history and a paused second writer, clear changes only that history. On resume the old writer
  is rejected. Restart shows no old or legacy rows; new observations persist and report. Other Projects and development
  artifacts remain unchanged.
- Given repeated queries and a growing retained journal, refresh parses only appended bytes. Cache rebuild leaves
  transcripts, models, Plans, and the journal unchanged.

- Given one Plan with a failed validation, a repair round, and confirmed publication, the journal records separate
  validation and repair identities and one confirmed-delivery attempt, including after restart.
- Given either full cleanup or an attempt already at `cleanup_complete`, when cleanup repeats, its stable publication
  identity produces no second journal row. Keeping user files does not remove the confirmed-publication observation.
- Given disabled collection or an unwritable journal, publication still completes and prunes. Where controller evidence
  can be retained, coverage is incomplete with a content-free reason. A process death before recording leaves
  incomplete coverage and no invented outcome; restart does not backfill the missed measurement. A death after recording
  and before prune keeps the durable observation without resending it.
- Given either cleanup path and slow or failed auxiliary coverage storage, delivery and cleanup do not wait beyond the
  existing recording budget. Coverage stays incomplete unless its persistence was confirmed. Already retained delivery
  classification reaches append without another Git metadata read.
- Given disjoint committed Plan Association time scopes in one Session, observations link only to the matching Plan at
  that time. Unassigned discussion and uncommitted associations do not create Plan links.
- Given a model call before a Plan association and delayed usage reconciliation after it, the earlier call stays
  unlinked. A call in committed implementation links to its observed workflow Plan, even if reconciliation follows
  a later Plan association.
- Given an interrupted repair turn or a non-Plan Session, measurements do not label the workflow abandoned or count an
  open Session as an undelivered failure. A parallel tool batch creates no model-request fan-out claim.
- Given `workflowMetrics` disabled or unset with no prior enabled history, when turns, tool calls, or slash commands
  run, RunWield creates no metrics journal. With prior history, it may retain an observed disabled control transition,
  but writes no Usage measurements while disabled.
- Given `workflowMetrics` enabled in project or global settings, when an agent turn executes, RunWield records ordered
  events with monotonic sequences, tool exposures, tool durations, model usage, and latency.
- Given a bash command with flags, arguments, or pipelines, when recorded, RunWield stores only coarse safe command
  labels and excludes all raw paths and arguments.
- Given an execution with more than 40 tools, RunWield records individual tool exposure events without array truncation.
- Given background delegated work, RunWield preserves parent tool call identity, parent execution identity, and task
  identity across all recorded observation records.
- Given an execution that calls no tools, RunWield records its effective tool inventory and a zero call count.
- Given a returned tool error, rejection, cancellation, or incomplete call, RunWield records the observed outcome or
  missing end without turning it into a success. A failed turn keeps usage that its provider already reported.
- Given absent usage, cost, truncation, or context occupancy measurements, RunWield marks each unavailable or partial;
  it does not replace missing values with zero or add overlapping turn and request costs.
- Given Pi request usage, Claude request/turn/per-model fixtures, or agy turn-cumulative usage, when recorded, RunWield
  retains the available detail without adding Claude alternative observations to a reported turn total. Absent cache
  categories stay unavailable and supplied zeros stay measured. New agy rows record calculated USD cost only from an
  exact catalog model. An unmatched model keeps unavailable cost; reasoning remains part of output.
- Given a new CLI usage row, input and cache counts remain non-overlapping. Existing rows with unknown basis are not
  rewritten. Given agy thinking tokens or Pi reasoning tokens, recorded reasoning is part of the unchanged output total.
- Given an exact agy catalog match, cost is calculated from recorded counts and labeled calculated. Given only a preview
  catalog entry, cost stays unavailable. Missing token buckets are not written as measured zero.
- Given a Pi assistant message that completes before settlement, its observed start and end stay inside its turn.
  Settlement time does not replace them. Unobserved rows keep null timing.
- Given a complete priced request, reported-zero request, unavailable-cost request, partial agy turn, and complete CLI
  aggregate, Langfuse receives one content-free observation per attempt with the corresponding native fields and flags.
  Partial buckets stay absent; the aggregate creates no child generations or second parent total.
- Given a Guided Review cost subtotal with partial cost coverage, Langfuse receives the subtotal in metadata with
  `cost_complete=false`, without native cost details or a native model name. A partial-token agy turn with complete
  catalog cost still sends native cost. Local cost coverage follows the separate cost fact.
- Given uncertain ingestion or delayed readback, the exporter does not retry. Matching native readback confirms
  presence, including equivalent empty native representations and fully identical unmerged versions. This does not
  authorize a retry or claim exactly-once ingestion. Vendor-invented buckets, costs, complete values, or conflicting
  versions that contradict Core evidence do not confirm it.
- Given assistant entries without usage and a compaction entry with usage, when a Session is replayed, assistant totals
  show unavailable while the compaction component shows its own measured values.
- Given a completed local or remote vision fallback, when usage is present, RunWield records it once. Error or aborted
  responses retain known usage with incomplete coverage; a thrown error records unavailable usage. Each call captures
  its measurement start first; without an active execution its auxiliary start adds no Active day.
- Given a clear during an external guide command, its delayed usage and generation outcome cannot enter the new history.
- Given a default `wld` guide job, when it settles, its existing runtime measurements and one generation outcome remain
  without a duplicate job total. An external guide job records one aggregate and one outcome. Null categories yield
  partial or unavailable coverage, not zero. Version-1 frames are not accepted as new measurements.
- Given a template or Skill command that starts Agent work, its one invocation ID links to the execution. A command
  picker writes an `opened` observation, then a `dispatched` observation only when a choice starts work. Its final
  result is succeeded, failed, canceled, or rejected under the same invocation ID. Closing a picker without a choice
  records cancellation, not a completed model change.
- Given manual `/compact` outside an Agent turn, RunWield awaits an auxiliary measurement start before model work and
  records compaction and context under its Session and command. Its auxiliary execution adds no Active day.
- Given separate Core processes and a linked worktree writing the same Project history, when observations overlap, the
  shared lock serializes journal mutation; contention ends within approximately one second with a truthful
  non-persistence result if the lock is not acquired.
- Given a synchronous append or sync failure, or a compromised lock, when recording settles, it does not claim
  persistence, stop delivery, or enqueue the observation for replay.
- Given prior enabled history, when Core observes disabled collection, it records only the disabled control transition.
  When Core later observes enablement, it starts an observed collection epoch without backfilling missed measurements.
- Given recording disabled then enabled through the normal control without intervening appends, an older capture is
  rejected at the committed collection boundary and a new capture persists. An empty Project setting inherits that
  boundary; an explicit Project enablement override keeps its own epoch.
- Given a settings-write failure after recording generation commit, the unchanged enabled setting permits fresh work,
  but captures from before the attempted control change are rejected.
- Given direct settings-file edits without Core observations, the interval has no recorded measurements and no inferred
  disabled duration. An observation from a stale observed epoch is not relabeled into the new epoch.
- Given a journal with v1 rows and a torn final append, when repair runs under the lock, the v1 rows remain unchanged,
  only the incomplete tail is removed, and an explicit `measurement_gap` records the lost bytes.
- Given corrupt interior lines, when repair runs, those lines remain and gap evidence surfaces their line numbers;
  successful persistence of a later observation does not claim complete historical coverage.
- Given a large history with a missing checkpoint, one recording call starts bounded automatic recovery. Recovery
  continues without new observations, and later work records without reconstructing skipped activity.
- Given recovery in progress, export authorization and clear wait for stable history. A clear does not restore removed
  rows when background recovery continues.

#### Export consent

**Requirement: Export only under explicit destination consent.** An Export grant binds an approved installed exporter
identity, endpoint, external project, and explicit allowlist of primary Projects. Project settings cannot grant export.
Each Project starts at its journal byte position when added. An execution that started before that position is never
exported, even if it finishes later. An execution-scoped row is eligible only with retained start evidence at or after
the grant boundary in the same history; missing start evidence fails closed. Rows without an `executionId`, such as
workflow outcomes, start at their own position. A new history after clear
starts at zero. Endpoint or external-project changes and re-enablement create new consent and start positions. HTTPS is
required except explicit permission for loopback HTTP. Credentials rotation preserves consent and fences.

**Acceptance scenarios:**

- Given no installed approved exporter, no grant, or an empty allowlist, a cycle sends nothing.
- Given an execution or manual compaction started before consent and finished afterward, none of its observations are
  sent. An execution-scoped usage row without retained start evidence is not sent. A new execution in a granted Project
  is sent; an unlisted Project is not sent. An outcome without an execution ID is eligible at its own post-grant position.
  Adding a Project starts only its future history.
- Given a new endpoint, external project, or re-enablement, old pending history is not swept into the new grant.
- Given a non-loopback HTTP endpoint, Core refuses consent. Loopback HTTP also requires explicit permission.
- Given a changed installed identity, the old grant authorizes nothing, even if the new package has been approved.

<a id="export-delivery-lifecycle"></a>

**Requirement: Core owns delivery authorization and lifecycle.** The TUI and owner Workspace host run export at startup
and every 60 seconds, independent of cwd, open Sessions, Workspace registration, or browser access. Remote personal
resource hosts do not start it. Core takes a non-blocking destination OS lock, then the configuration lock and journal
guard. Grant and exporter-approval edits share the configuration lock. Under the guard Core checks current consent,
installed approval, and history, and syncs the send intent. Core builds the observation and spawns the worker before
locking, then hands the authorized request to that worker with synchronous `postMessage` under the configuration and
journal guards. It awaits network results only after release. Failed authorization terminates the worker without a
request. Clear or revoke committed before dispatch prevents that request. Pending payloads exist only in journals; a
cursor retains scan positions and eligible execution starts, rebuilding older cursors without start evidence. A
content-free ledger retains durable intents and outcomes across host restarts. Recovery visits all destinations,
including revoked grants. In-flight status requires both an unsettled intent and a held destination send lock; a dead
process does not remain in flight.

**Acceptance scenarios:**

- Given an unregistered granted Project B while cwd is Project A, a cycle sends B's eligible rows.
- Given two simultaneous hosts, each observation reaches the destination once. Every request has a durable prior intent.
- Given clear or revoke committed before the lock-scoped dispatch, the prepared worker receives no request. An
  authorized request is handed to the worker before the locks release; its network result is awaited afterward.
- Given a dead send holder, clear reports no live delivery. The next cycle marks unsettled sending intents unconfirmed
  with `process_lost` and ends abandoned confirmations, including revoked destinations, without replay.

<a id="export-delivery-states"></a>

**Requirement: Export states preserve acceptance uncertainty.** Accepted means transport reports acceptance; Confirmed
means bounded read-back proves remote presence. Unconfirmed means acceptance is unknown and automatic resend is
forbidden. Retryable non-acceptance returns to Pending with capped backoff, at most one hour. Permanent non-acceptance
stays Rejected. Needs-correction rejection resumes only after credentials change. Later rows do not wait for backoff or
Unconfirmed rows. Optional confirmation checks Accepted and Unconfirmed items at most three times over successive
cycles. Not-found-yet or mismatch never changes an item to Pending or Rejected. Status shows
current-grant/current-history counts, approval, credential configuration, sanitized codes, and last attempt time,
without observation content. Local reporting remains independent of these remote delivery states.

**Acceptance scenarios:**

- Given a lost response after remote acceptance, later cycles and restart never send the observation again.
- Given a 503, later rows proceed while that item waits. A permanent rejection stays Rejected; a correction rejection
  becomes Pending only when the credentials revision changes.
- Given read-back presence, Accepted or Unconfirmed becomes Confirmed. Three unsuccessful checks leave it unchanged.

<a id="export-failure-isolation"></a>

**Requirement: Exporter failures cannot stop local work.** Core gives trusted approved exporter code one immutable
contract-1 observation, transport credentials, destination context, and a deadline. References are host-keyed hashes,
not raw local IDs. Only model usage, finished executions, finished tool calls, validation attempts, finished repair
rounds, confirmed publication, and abandoned-workflow observations are exported. Legacy rows, context, command, tool
exposure, latency samples, paths, names, prompts, and free text are excluded. Each call runs in a Worker, stopped at 30
seconds. Throws, malformed results, hangs, and worker exits become Unconfirmed. Shutdown terminates calls and waits at
most about two seconds without holding a Session writer lock. This is failure isolation, not a security sandbox.

**Acceptance scenarios:**

- Given an exporter throw, hang, or `process.exit`, the host continues and records new local observations.
- Given captured payloads, every reference is opaque and no path, Plan name, prompt, or raw local ID appears.

<a id="export-clear-and-revoke"></a>

**Requirement: Clear and revoke stop future authorization without recalling prior sends.** Clear serializes with export
authorization under the journal guard. It removes pending payloads and changes the history epoch, but keeps ledger
fences. A previously authorized delivery can settle afterward without restoring measurements. Revoke removes consent;
both operations report whether a delivery was already in flight. Re-enabling starts at new Project positions.

**Acceptance scenarios:**

- Given clear before authorization, no cleared row is sent. Given an already authorized request during clear, the result
  reports in-flight delivery and its later settlement restores no local rows.
- Given revoke during a request, the result reports in-flight delivery, and no later row is authorized.

<a id="export-credentials"></a>

**Requirement: Keep export secrets out of settings and measurement state.** Credentials live only in Core's
`~/.wld/metrics-export/credentials.json`, with owner-only file mode `0600` inside a `0700` directory. A separate `0600`
`host.json` retains the host reference key and owner identity across restarts. Settings, status, logs, errors, and
ledgers contain no credential value. Status reports only whether credentials are configured.

**Acceptance scenario:** Given configured credentials and a delivery, authentication receives the credentials, while
settings, status, ledger, and observation contain none. Credentials and host identity files have owner-only modes.

<a id="4-current-local-workspace-surface"></a>
<a id="5-current-collaborative-planning-surface"></a>

## Browser and shared-review requirements

Core includes the local browser client that `wld plans ui` launches and the CLI actions for Shared Plan collaboration.
The [Workspace local Plan management capability](runwield-workspace-prd.md#local-plan-management) and
[shared Plan collaboration capability](runwield-workspace-prd.md#shared-plan-collaboration) own their surface
requirements and use Core's [Plan lifecycle](#plan-lifecycle), [Plan review](#plan-review), and
[execution and recovery](#execution-validation-and-recovery). Local use needs no RunWield account or subscription.

## Delivery and Architectural References

Core is fully usable locally. Personal Remote Workspace adds access to the same work from another device. Hosted
collaboration and broader code-intelligence improvements are separate follow-up scope.

- [Session architecture](../adr/015-file-authoritative-session-bundles.md)
- [Transcript handoffs](../adr/012-segment-session-transcripts-at-execution-handoff.md)
- [Project runtime state](../adr/017-project-runtime-state-under-wld-internal.md)
- [ACP compatibility](runwield-acp-protocol-prd.md) and [implementation details](../acp-implementation-details.md)
- [Workspace requirements](runwield-workspace-prd.md) and
  [continuation readiness Plan](../plans/archived/workspace-session-continuation-readiness.md)

## Success Metrics

- Router produces the correct Routing Intent with proportionate exploration.
- Plans reach review quickly, with enough context for approval.
- Approved Plans complete validation and delivery with accurate, distinct outcomes.
- Recovery paths keep enough state to continue safely after failed execution, validation, or merge-back.
- QUICK_FIX runs stay bounded and validate mechanically.
- Local Workspace manages Plans with correct front matter and lifecycle rules.

Each capability defines its acceptance scenarios, especially [Session continuity](#session-continuity). Outcome
measures complement those journeys.
