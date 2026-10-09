---
title: RunWield Workspace
status: living-roadmap
createdAt: "2026-07-06T00:00:00.000Z"
updatedAt: "2026-09-11"
---

# RunWield Workspace PRD

**Document role: Living central PRD.** Principles and lasting requirements for the browser workspace, personal
continuity, and later team collaboration.

Keep this document as current product guidance. Fold lasting requirements from completed feature PRDs here;
implementation steps belong in Plans, architectural choices in ADRs, and delivery evidence in Work Records.

**Status:** Living roadmap — current local Plan Workspace implemented; Personal Remote Workspace v1 next\
**Last Updated:** 2026-09-11

<a id="1-objective"></a>

## Objective

Evolve RunWield Workspace from a browser Plan Board for one checkout into the primary browser environment for working
the RunWield way across multiple registered Projects.

The personal product serves one developer using their own machine through a private network. The same person can start
work in the TUI, walk away with their phone, continue in Workspace, and return to the TUI with the conversation updated.
They can move among Projects, review and execute Plans, receive notifications, and search project knowledge.
Simultaneous multi-user collaboration is later scope. Reliable Session start and continuation are required for this
product to be useful; completion of earlier implementation slices does not establish that readiness.

The browser experience preserves existing Plan approval, validation, recovery, and local developer control. A later team
product should build on the personal experience; future collaboration must not burden ordinary use today.

<a id="2-problem-statement"></a>

## Problem Statement

The current Workspace is useful but scoped to one checkout and centered on a Plan Board. RunWield Sessions primarily
live in terminal processes, while browser review, Shared Plan collaboration, TUI operation, ACP clients, and future chat
channels are separate surfaces.

That creates five product gaps:

1. **No persistent multi-Project home.** The user cannot register trusted Projects and see attention, active work,
   Sessions, Plans, and recent outcomes across them.
2. **Moving between screens is unreliable.** The owner needs to continue their own conversation on a phone without
   closing an idle TUI, losing context, or navigating repair controls for an ordinary resume.
3. **No complete browser workflow.** Workspace cannot yet carry one Session through ideation, Plan review, execution,
   validation, and recovery with clear progress and next actions.
4. **Knowledge is fragmented.** Plans and Work Records can inform future work, but Workspace lacks a deliberate
   Project-level and cross-Project retrieval experience. Source-code search is likewise confined to the active Project.
5. **Remote access is not a product boundary.** The current random launch token and loopback-oriented server are not
   sufficient for a persistent remotely reachable owner Workspace.

The answer is not a generic Agent manager, issue tracker, transcript memory system, or browser IDE. Workspace should
remain a Plan- and workflow-first RunWield product.

<a id="3-product-thesis-and-principles"></a>

## Product Thesis and Principles

RunWield Workspace is **AI-native collaborative software planning and workflow continuity**.

Its core loop is:

```text
ideate or inquire
    -> materialize durable artifacts when useful
    -> review and approve a Plan
    -> execute and validate locally
    -> distill the outcome into a Work Record
    -> use durable records to plan better
```

Product principles:

- **Workspace is the primary browser shell.** Plans, Sessions, workflows, review, knowledge, and attention define the
  product; code-server is subordinate.
- **Projects are explicit trust boundaries.** Workspace accesses only registered roots and never treats an incidental
  local cache as authorization.
- **One owner, one conversation across screens.** Leaving a TUI or browser open does not reserve a Session. The owner
  can continue it from another screen and see the resulting conversation when they return.
- **Familiar behavior across screens.** Session commands, Agent defaults, and manual override behavior match the TUI.
  Browser conveniences such as dropdowns and an image picker make the same actions easier to reach; they do not
  introduce different Session semantics. Changing Agents resets model and thinking choices to the selected Agent's
  settings.
- **Plans own planned-work lifecycle.** Once a Plan exists, its workflow surface becomes the durable center for review,
  execution, validation, recovery, changes, and associated Sessions.
- **Approval is not execution authorization.** The user can approve and run now or approve for later.
- **Artifacts outrank transcripts.** Plans, PRDs, ADRs, and Work Records form durable Project and Workspace
  intelligence. Raw Session Transcripts do not.
- **RunWield replaces the forge workflow layer by default.** Intent, review, and memory are RunWield capabilities. A
  forge may remain the remote git host, merge substrate, and identity provider, but pull-request review is a
  per-repository opt-in, not the default human review loop.
- **Local-first does not mean browser-bound.** Work continues safely when the browser disconnects and stops only at
  completion, cancellation, failure, or the next required human decision.
- **Continuity should be ordinary.** Opening, refreshing, or changing screens preserves the conversation and unsent
  drafts. Both TUI and Workspace update automatically as new work is saved from the other screen. A long history or
  completed Plan does not make the conversation read-only.
- **Explicit scope beats ambient reach.** Cross-Project source search and future Agent access must never silently
  broaden from one Project to every registered Project.
- **Use the RunWield Design System.** Workspace, Plannotator, and related browser surfaces should remain visually and
  behaviorally coherent.

<a id="4-current-baseline"></a>

## Current Baseline

RunWield currently provides:

- a local browser Workspace for one checkout;
- Plan and Epic boards, detail views, body editing, and lifecycle-safe actions;
- Plannotator-based Plan and code review;
- encrypted Shared Plan Spaces with capability-based review;
- stable Plan identity and canonical markdown storage;
- Work Records and Work Record retrieval;
- a multi-session in-process Session Host and adapter-neutral SessionRuntime;
- TUI and ACP as sibling Runtime adapters;
- an ACP stdio implementation that can create, load, prompt, cancel, close, and replay Sessions;
- Cymbal as the current-Project, working-tree-aware code-intelligence layer.

Workspace already provides browser Session and Plan surfaces. The remaining readiness work is to make the complete owner
journey dependable, especially starting and continuing Sessions across TUI and phone. The architectural decisions are
recorded in ADR-015. Continuation fixes are tracked in
[Restore Ordinary Workspace Session Continuation](../plans/workspace-session-continuation-readiness.md); existing
implementation restrictions are not product requirements.

Existing local Plan management and Shared Plan collaboration remain supported foundations. Personal Remote Workspace v1
expands their containing product model rather than replacing their lifecycle or canonical storage.

## Product Model

<a id="51-workspace"></a>

<a id="1-workspace"></a>

### Workspace

**Workspace** is the browser environment containing registered Projects, durable Sessions, Plans, PRDs, ADRs, Work
Records, review surfaces, search, and notifications

The default home is the cross-Project **Attention Dashboard**, not a Project grid or a global Plan board.

<a id="52-project-and-project-runtime"></a>

<a id="2-project-and-project-runtime"></a>

### Project and Project Runtime

A **Project** is a trusted repository or project directory registered with Workspace. Registration authorizes Workspace
to operate within that root; it does not make every path on the machine accessible.

Each Project contains its own Sessions, Plans, knowledge, and health information. Several Projects can make progress at
once; returning to an inactive Project preserves its saved work. The first version uses local roots on the owner's
machine. Hosted Projects are later scope.

<a id="53-session-and-agent-session"></a>

<a id="3-session-and-agent-session"></a>

### Session and Agent Session

A **Session** is the durable user-facing conversation and workflow thread within one Project. It spans Router Triage and
specialist Agent handoffs and has a stable identity and human-readable Session Name.

An **Agent Session** is an internal specialist invocation within a Session. It is not the main navigation object.

Agent and workflow handoffs stay within one continuous conversation. Users can review the full history even when a new
phase receives only the context relevant to its task. Internal Agent invocations are not separate navigation objects.

A Session may begin without a Plan for ideation, inquiry, operation, or QUICK_FIX work. When a Plan materializes, the
Session becomes associated with it and the Plan workflow becomes the primary route. Starting from an existing artifact
creates a fresh associated Session; **Resume** re-enters the same Session.

Workspace does not introduce a generic Work Item above Sessions, Plans, and artifacts.

<a id="54-durable-artifacts"></a>

<a id="4-durable-artifacts"></a>

### Durable artifacts

- **Plan:** owns planned implementation lifecycle and may become the center of one or more associated Sessions.
- **PRD:** product-intent artifact with capability-organized requirements and acceptance scenarios. It may inform
  multiple Sessions or Plans and does not participate in Plan Lifecycle.
- **ADR:** authoritative architecture-decision artifact.
- **Work Record:** retrospective account of completed planned work and its durable future planning lessons.
- **Session Transcript:** owner-private raw history used for human resume and search, not shared knowledge.

Repository artifacts remain canonical. Workspace may index and project them, but must not silently replace them with
browser-database-only copies.

## Delivery Audience

The first version serves:

- one trusted developer;
- on the developer's own machine;
- through Tailscale, WireGuard, or an equivalent private network;
- from owner-approved paired browser devices;
- across several registered local Projects;
- with no team accounts or shared-machine concurrency.

This is a durable personal self-hosted mode, not merely a development demonstration.

## Capability Requirements

The capabilities below own browser-specific requirements. They reference Core for shared lifecycle, validation, and
Session behavior. Scope labels distinguish the existing foundation, the required Personal v1 journey, and later team
work; they do not claim rollout completion.

- [Container hosting](#container-hosting)
- [Browser appearance and themes](#browser-appearance-and-themes)
- [Local Plan management](#local-plan-management)
- [Shared Plan collaboration](#shared-plan-collaboration)
- [Attention dashboard](#attention-dashboard)
- [Project access and navigation](#project-access-and-navigation)
- [Browser Sessions](#browser-sessions)
- [TUI and phone continuity](#tui-and-phone-continuity)
- [Browser Plan review and workflow](#browser-plan-review-and-workflow)
- [Durable knowledge search](#durable-knowledge-search)
- [Human cross-Project code search](#human-cross-project-code-search)
- [Main-checkout Code Surface](#main-checkout-code-surface)
- [Device pairing and remote trust](#device-pairing-and-remote-trust)
- [Team planning and governance](#team-planning-and-governance)
- [Team artifact privacy and authorship](#team-artifact-privacy-and-authorship)
- [Team planning intelligence](#team-planning-intelligence)
- [Team code review and delivery](#team-code-review-and-delivery)

### Container hosting

**Scope and maturity:** Container packaging and an offline Kubernetes example are available. Cluster deployment is a
separate owner decision.

**Requirement: Run personal Workspace in a persistent container.**

The owner can build a Linux image with Podman and run Workspace on their private Kubernetes server. Projects, `~/.wld`,
and `~/.agents` have separate persistent mounts. The `.wld` mount also holds memory data. Image replacement preserves
saved Sessions, device pairing, settings, skills, and registered Projects when mount paths remain unchanged. One
Workspace instance writes this state; HTTPS and device pairing remain required for remote access. Container packaging
does not deploy or publish an image automatically. The container setup is a work in progress and is not yet in the user
documentation.

**Acceptance scenarios:**

- Build the image, mount the three folders, and start Workspace behind a trusted HTTPS proxy. Pair a browser and
  register a repository from the projects mount.
- Replace the container with the same mounts and paths. Saved state and project files remain available. An interrupted
  agent turn requires a follow-up; it does not automatically resume.
- Render the Kubernetes example locally without changing cluster resources or Flux configuration.

### Browser appearance and themes

**Scope and maturity:** Current browser implementation uses the approved dark identity. Light/custom theme delivery and
a theme picker remain deferred; support for separate browser themes must remain intact.

**Requirement: Keep a consistent dark browser workbench.**

Workspace, Plan Review, and Code Review use the approved RunWield brand colors and website typography. Keep compact
controls, a mint sidebar brand rail, blue selected context and actions, and distinct semantic status colors. OS color
preferences and TUI theme choices do not change browser appearance. TUI appearance and Session behavior are unchanged.

**Requirement: Preserve future browser theme choices without a restyle.**

Browser colors remain separate from component layout, spacing, and typography. A future light or custom token set can
replace the dark set through the same browser theme renderer, including shared review components, without restyling each
surface or depending on TUI settings. The current UI offers no theme picker, light theme, or OS-following mode.

**Acceptance scenarios:**

- Given light OS settings or a light TUI theme, when the owner opens Workspace, Plan Review, or Code Review, each uses
  the approved dark browser identity; changing TUI themes does not change browser colors.
- Given a future alternate browser token set, when it is supplied to the renderer, Workspace and review components use
  its semantic colors without changes to their layout, typography, or component styles. This does not claim a shipped
  light/custom theme.
- When the owner opens browser controls or the Session command menu, no browser theme picker or light-mode action is
  offered; ordinary Session commands and TUI theme controls keep their existing behavior.

Implementation guidance: [RunWield Design System](../design-system.md#browser-themes).

### Local Plan management

**Scope and maturity:** Current local browser baseline.

**Requirement: Edit and navigate Plans without changing their lifecycle accidentally.**

`wld plans ui` remains a useful local browser board for the current checkout. It shows Plans by stage, separates active,
held, and finished work, and presents Epics as top-level cards with child progress. Opening a Plan is read-first;
editing has a clear action and saves explicitly. Refresh can recover an unsaved draft. Markdown structure and ordinary
CLI use remain intact, and body editing does not accidentally change workflow fields.

Manual board moves record the user's choices without claiming automated review or verification. Users can reflect
externally started or completed work, close without verification, or hold work. Failure and hold offer the appropriate
recovery or resume actions. Plan, Epic, and useful filtered-view links remain stable after renaming. Local links need a
running Workspace; sharing access remains explicit.

These local outcomes are the foundation, not a restriction to one Project in the personal multi-Project product. Later
document surfaces should feel consistent while keeping Plan lifecycle controls specific to Plans.

**Acceptance scenarios:**

- Given a Plan opened from the board, when the user edits its body and saves, Markdown remains usable from the CLI and
  lifecycle fields do not change accidentally.
- When the user moves or manually closes work, the board reflects that choice without claiming automatic verification;
  failure and hold expose recovery or resume.
- Resuming paused validation from the Workflow sidebar continues the saved validation and repair work, just like
  `/load-plan`, in the existing execution worktree. The action uses the displayed committed Session version, prevents
  duplicate clicks while pending, refreshes the Session afterward, and shows progress, pause reasons, and errors beside
  the action, including on mobile. Live validation updates replace older paused checkpoint displays; Open Session from
  its own sidebar reveals the conversation instead of navigating back to the same covered page.
- When a Plan or Epic is renamed, its existing links still resolve and child progress remains visible.
- The local board shows its W. logo and heading; the embedded Project board omits duplicate branding, Project title, and
  checkout health. View tabs and search share the header row, with search trailing the tabs. Columns use separators
  instead of enclosing borders, and an empty column has one consistent empty message. Drag/drop feedback appears only
  during an interaction; there is no default instruction footer.
- Plan Board views, Session context, and annotation/chat views in Plan and Code Review share square underline tabs: a
  thin baseline and a thicker active indicator.

### Shared Plan collaboration

**Scope and maturity:** Current self-hosted baseline; hosted deployment and additional browser actions remain deferred.

**Requirement: Share review revisions with explicit access.**

Workspace supports encrypted collaborative Plan sharing through self-hosted remote Workspace Shared Spaces.

Current collaboration capabilities:

- self-hosted encrypted Shared Spaces;
- `wld plans share`, `pull`, `push`, and `unshare` for the review and publishing cycle;
- distinct reviewer and maintainer links without exposing secrets in Plan documents;
- browser comments, resolution/reopening, and Revision switching;
- one agreed shared review version, with clear publishing and unsharing actions.

The [Collaborative Planning PRD](collaborative-planning-PRD.md) defines these journeys. Storage and protocol details are
in [collaboration documentation](../user-documentation/collaboration.md).

Deferred collaboration surface:

- hosted RunWield Workspace / Cloudflare D1 deployment
- browser-side push, close, unshare/delete, or Plan body editing
- automated notifications
- Forge Change Request Delivery through GitHub or GitLab as an explicitly selected delivery and review mode (see
  [forge-change-request-delivery-prd.md](forge-change-request-delivery-prd.md)); RunWield-native review and Direct
  Delivery remain the default

Shared review consumes [Core Plan review](runwield-core-prd.md#plan-review) and
[Plan lifecycle](runwield-core-prd.md#plan-lifecycle).

**Acceptance scenarios:**

- Given a deliberately shared Plan, when a reviewer follows their link, they can comment and switch Revisions within
  that access without receiving maintainer secrets.
- When the maintainer publishes a new review version or unshares, participants see the corresponding shared-review
  outcome; ordinary repository documents do not acquire sharing secrets.

<a id="62-attention-dashboard"></a>

### Attention dashboard

**Scope and maturity:** Personal Remote Workspace v1 target; existing UI is not proof of the complete journey.

**Requirement: Surface the owner’s next consequential action.**

The default Workspace home is an attention-first queue across registered Projects. Its primary question is:

> What do I need to work on next?

The dashboard should not list every active Session with equal weight or reward multitasking. It ranks attention by
workflow consequence while preserving exploration paths for users who want the broader state.

Default ordering:

1. **Pinned:** user-pinned Sessions, Projects, Plans, or workflow items. Pinning makes work easier to find.
2. **Needs You:** actual human decisions or external prerequisites, such as approval, feedback, human review, or a Pair
   checkpoint. Use current unanswered Session interactions (including `plan_written` Plan reviews and code reviews), or
   an associated Agent that stopped with unfinished execution, including a conversational Pair checkpoint. Draft,
   feedback, validated, configured review modes, and historical repair flags alone do not request attention. Internal
   diagnostics remain in Project settings/navigation. When Project data cannot be read, the Dashboard warns that its
   list may be incomplete and links to Project settings without adding diagnostics to the attention queue.
3. **Ready to Continue:** approved Plans ready for work, paused workflows, child Plans ready in a PROJECT sequence, or
   other safe next actions.
4. **Recently Finished:** successfully published or deliberately abandoned delivery workflows, and completed
   non-delivery requests. Failed attempts and verification attestations alone do not finish an undelivered workflow.
5. **Running Quietly:** Sessions and Plan workflows currently progressing without a required human decision.

The first screen should emphasize the top actionable queue and keep Running Quietly secondary. Project navigation,
filters, all-active views, Session transcripts, Plan details, validation evidence, Work Records, and Project health
remain explorable, but users should not have to inspect every Project to discover blocked or finished work.

The Dashboard shows current work across Projects and links to the Session or Plan where the owner can act. It does not
create an additional approval step or change which work the owner can continue.

**Requirement: Show the Dashboard before checks finish.** The first page response shows all four attention cards with
loading states. Verified rows appear as their checks finish, even when another Project or unrelated Plan check is still
pending. Counts remain visibly incomplete until checks finish. A successful empty section says there is no work only
when all relevant checks succeeded. A failed check never makes an empty section look successful. Partial errors keep
verified rows and offer Retry. A failed refresh keeps prior rows but labels them as not updated; a successful retry
replaces obsolete rows. Each card keeps its sorting, expansion, and focus during updates.

**Requirement: Bound navigation reads without waiting for the Dashboard.** The sidebar reads saved Plan and Session
navigation evidence independently of Dashboard classification, readiness checks, and live connections. Navigation reads
only the recent Session names it needs, without counting the full Session archive. Each listing request reads one
recovered, sorted Session catalog snapshot rather than scanning it again for each page. Completed reads are not retained
as a stale cache; the next refresh reads current evidence. Sidebar Plan ordering uses saved Plan status and Session
state; Dashboard cards use their separately verified workflow evidence.

The sidebar's controls are usable before any data request completes, including on mobile. Registered Projects load
first; each Project's recent Sessions appears independently without waiting for Plans, workflow evidence, another
Project, or the Dashboard. Loading and failed reads keep New Session and existing navigation available, and never
present a pending collection as empty. Later detail updates preserve expanded Projects, focus, and sidebar position.

Each dashboard read verifies runtime layout and migration evidence once per checkout, rather than repeating those checks
for every Plan and worktree lookup. Registry evidence for a Project is read once for its Plans, with duplicate live
attempts still treated as errors. The next read verifies that evidence again; Plan and Session state remain fresh within
the read. The visible page makes one finite shared dashboard request per refresh, waits five seconds after it settles
before another automatic request, and pauses automatic requests while hidden.

Each section defaults to most recently updated first, has a header button to reverse its sort, and initially shows five
items. Rows show the relevant update time, and finished rows also show completion time when it differs. Row labels name
the next review, answer, or navigation step without claiming that opening the destination executes or approves work.
Needs You has stronger visual priority than finished work. **Read more** expands that section, and **Show less**
collapses it. Sort and expansion choices survive automatic refreshes. Ready-for-work Plans belong in Ready to Continue
unless a current unanswered interaction needs the owner.

**Acceptance scenarios:**

- Given a slow dashboard read, the first HTML shows all four cards as loading. Verified rows appear before unrelated
  checks finish in either the same Project or another Project; other cards remain visibly incomplete.
- Given completed checks with no eligible work, a card says “Nothing here.” Given failed checks, it instead shows an
  error and Retry. A partial failure keeps verified rows; a failed background refresh keeps older rows marked not
  updated. A successful retry replaces old rows and clears the warning.
- Given the Dashboard is hidden or a request is still active, automatic refresh does not start another Dashboard scan. A
  sidebar request finishes without waiting for an unrelated live connection or Dashboard readiness check.
- Given two registered Projects with blocked, ready, finished, and running work, when the owner opens Workspace, the
  queue surfaces what needs attention without opening each Project.
- When the owner pins work, it becomes easier to find but does not gain approval or execution permission.
- When work reaches a required human decision, the attention signal leads to the correct Session or Plan; quietly
  running work stays secondary.
- Given a Project with thousands of archived Sessions, opening the Dashboard and sidebar together does not read every
  archived transcript. Paging a listing does not repeat its manifest scan. A later refresh reflects newly completed
  work.
- Given a ready Plan with old repair or review flags, it appears in Ready to Continue. A live question, Plan review,
  code review, or execution Agent stopped at a conversational Pair checkpoint appears in Needs You and links to the
  associated Session; answering it removes that attention signal. Active TUI Sessions are observed without first opening
  them in the browser.
- Given more than five items in any section, only the five newest appear initially. Reversing sort shows the oldest
  first; expanding shows all eligible items, and refresh preserves both choices.
- Given a Project read fails, the Dashboard says its list may be incomplete and links to Project settings. Counts show
  known items rather than a confirmed total, and an empty section does not claim there is no work. It does not present
  the diagnostic as a work item. When a refresh changes a focused row, keyboard focus stays with the row or moves to its
  section heading if that row is gone.
- Given Plans in different sections, their row labels distinguish reviews, questions, progress and completed outcomes.
  Timestamps explain update ordering and show the completion time for finished work without implying that a link
  approves or executes a Plan.

<a id="63-project-experience"></a>

### Project access and navigation

**Scope and maturity:** Personal Remote Workspace v1 target.

**Requirement: Limit Workspace reach to registered Projects.**

For each registered Project, Workspace shows:

- registration and RunWield initialization health;
- active, held, failed, implemented, verified, and closed Plans;
- standalone and Plan-associated Sessions;
- PRDs, ADRs, Work Records, and related research;
- artifact and Project knowledge search;
- current code-index health;
- access to the main-checkout Code Surface;
- relevant workflow, Git, validation, and recovery health.

Registration, disabling, and removal affect Workspace access and indexing only. They must not delete repository data,
Plans, Work Records, Session history, branches, or RunWield worktrees.

**Requirement: Remove a Project registration completely.** Remove deletes the registration and its dependent Workspace
SQLite records, rather than retaining a visible removed entry. Previously removed registrations are cleaned up on
upgrade. Adding the directory again creates a new Workspace registration and rediscovers its file-authoritative Sessions
and artifacts. Removal returns to Projects; disabling remains reversible in the existing settings page.

Project settings reads the Workspace registration independently of repository availability. Missing or disabled roots
must not block opening settings, relinking the root, or disabling/removing the registration. Repository-dependent reads
remain unavailable until the Project is enabled and its root is available.

Dashboard attention rows use the Plan name from the live review or linked Plan. Questions without a Plan use the Session
name. The waiting reason belongs in the secondary status text, never as a repeated generic row title.

**Requirement: Restore archived Sessions from Project settings.**

Current Project settings has General and Archived Sessions tabs. Archived Sessions lists paginated archived names, links
to their conversations, and an Unarchive action. Successful Unarchive restores ordinary history with the same Session
ID, transcript, and Plan Associations. Opening an archived Session does not unarchive it. Associated Plan Session
listings retain these links with visible archived status. Project access and Session ownership are checked before any
archive-state change; a foreign Session cannot be changed through another Project.

**Requirement: Install Workspace as an online-only app.**

On supported browsers, Workspace can be installed from its HTTPS origin (or localhost for development), with a RunWield
icon, standalone window, and the Dashboard as its start destination. Existing device pairing still applies, including
when the installed app opens a Session, Plan, or review. Installation does not grant access.

Workspace requires a live connection. A failed launch or navigation shows a connection page with a Try again action that
retries the original destination. A connection lost in an already open page shows a notice while keeping the page and
its unsent text mounted. Ask the owner to check their network, Workspace server, and Tailscale when used. The service
worker stores no Workspace content, queues no offline actions, and never automatically resends a failed write. Only its
generic connection page is available without the server.

**Acceptance scenarios:**

- Install from a supported phone or desktop browser, then launch to the Dashboard or pairing screen as appropriate.
- After installation, disconnect from the server and open a Session URL: show the connection page instead of stale
  Session data. Restore connectivity and choose Try again: load that same URL through normal authentication.
- Lose connectivity with a draft open: show a retry notice without replacing the page or sending the draft. Reconnect:
  clear the notice after a successful request; failed actions are not queued or replayed.

**Requirement: Deliver Session alerts on mobile and desktop.**

Workspace delivers new live Agent-stop events when the latest accepted user input came from Workspace, including
steering or answering a question in a TUI- or ACP-hosted turn. Navigating to Dashboard, another Session, a Plan, or a
review does not disconnect alerts. Merely viewing a Session does not change its notification destination.

With permission, delivery uses the active Workspace service worker, with the desktop Notification API as a fallback.
Shared notification settings and focused-tab suppression still apply. Tapping an alert opens its originating Session.
Delivery errors are diagnosable without interrupting the Agent turn. Restored history does not trigger alerts.

This is live open-page delivery: a closed or suspended app cannot receive new events without Web Push, which remains
unimplemented. Plan-ready and interview-specific browser alerts are not yet included.

Acceptance:

- A mobile browser that rejects the Notification constructor can display a permitted Agent-stop alert through its
  worker.
- Send a message, navigate to Dashboard, and receive the stop alert with a link back to that Session.
- Steer a TUI or ACP turn from Workspace: its final stop reaches Workspace without polling, and the TUI does not
  duplicate the alert. A later accepted TUI input restores the TUI destination; a rejected input does not change it.
- Denied permission, disabled notification settings, and focused-tab suppression remain respected.

**Requirement: Open Workspace without repeating startup work.**

Workspace home opens the Attention Dashboard. Logo links return directly to the last visited Session. Navigation
preserves the mounted sidebar and its loaded data; its viewport height stays stable while destination content loads. The
sidebar reads only enough Session names to fill its recent list and determine whether more exist, without waiting for
names from every older conversation. **Show more** loads the next five most recent unseen Sessions, excluding Sessions
already nested under visible Plans. It filters identities before reading names and stops after five results plus one
lookahead, without counting or scanning all older transcripts. Loaded rows remain usable during the request and after a
failure; another click retries without duplicating rows. Session contents load independently of the sidebar.

**Requirement: Keep global actions and Session context in consistent headers.**

The hamburger menu to the left of the Workspace logo contains browser notification permission and its current state,
plus a link to the public RunWield documentation. Session context tabs occupy the main header above their pane. One
collapse/restore control stays on that row, moving only horizontally and reversing its icon when the pane opens or
closes. Session, Plan Review, and Code Review use the same header alignment. Their hamburger menus and sidebar controls
share the same borderless buttons, hover treatment, and compact height at every screen width. Review and Workspace menus
share their popup and item styling. Segmented tool selectors keep a steady footprint and slide the selection highlight
when selection changes. Labels switch immediately without width animation; reduced-motion preferences keep the highlight
immediate.

The Workspace brand, main title, and Session context tabs share a top-aligned header row. Navigation retains its header
while its list scrolls. Workflow content inside a Session uses the existing Workflow tab as its heading and the sidebar
as its scroll area; it must not introduce a duplicate heading, nested scrolling pane, or bulky per-stage cards.

Dashboard, Sessions, and Plan home keep the same mounted Workspace navigation sidebar, preserving expanded Projects and
scroll position across navigation. Plan home uses it for switching between Plans and uses its shared title header
without a second logo or reader header. Contents starts collapsed, and Contents and Workflow controls share one aligned
row. Both panes remain reopenable on mobile. Workflow steps use the active stripe instead of Current/Upcoming labels;
their descriptions explain the work, proven results, waiting user actions, and available errors. Code Review follows AI
review, then Publication. Ready-for-work Plans show Planning as complete and Execution as the next step. Publication
facts describe the confirmed phase and any recorded failure.

**Acceptance scenarios:**

- Given an archived Session, Project settings > Archived Sessions lists its name and supports paging and opening its
  saved conversation. Opening it leaves it archived. Unarchive removes it from this view and returns the same ID and
  transcript to ordinary history.
- Given an archived Session associated with a Plan, the Plan still lists its Session link with archived status.
- Given a foreign Session or unauthorized Project, an Archive or Unarchive request fails without changing the Session.
- Given two registered roots and one unregistered directory, when the owner browses Projects, only the registered roots
  are available to Workspace.
- When a Project is disabled or removed, Workspace access and indexing stop without deleting repository data, saved
  Sessions, branches, or worktrees.
- Removing a Project makes it disappear from Projects, the sidebar, and the dashboard, and its old settings URL no
  longer resolves. Its files remain unchanged; adding its directory again rediscovers the saved Sessions.
- From a Session or its review, clicking the Workspace logo returns to the last Session without an intermediate home
  request or clearing the sidebar.
- From Workspace, opening Documentation in the hamburger menu opens `docs.runwield.dev` without changing the active
  Session.
- Opening home shows a plain shared loader, reuses its sidebar result on the destination page, and opens Projects when
  no enabled Project is available.
- With many saved Sessions, the sidebar resolves only its visible recent names plus one lookahead; unnamed Sessions
  remain hidden and Show more remains available.
- The Project’s Plan Board navigation item stays active across its Plan Board, Closed, and On Hold views, and clears
  when the owner opens a Session or another Project’s board.
- Projects and Devices share Workspace-level header tabs and consistent content margins. Project rows open a child
  settings page with a Back to Projects control, root controls, and maintenance actions. Linking a Project opens that
  settings page. Settings omits duplicate Plan Board or New Session actions. Devices applies across Workspace, and the
  current browser has a compact badge beside its device name.
- Opening the Workspace menu reveals notification permission without occupying Session or review header space.
- On mobile, scrolling a Session or embedded review and resizing the browser viewport keeps sidebar controls in the
  visible header; the document behind the workbench cannot scroll them offscreen.
- On Android Chrome, opening the keyboard shrinks the Session workbench so the focused composer and its actions remain
  visible above the keyboard. Closing it restores the available height while retaining the draft and history position.
- At 980px or narrower, Plan Review starts with Contents and Annotations collapsed. Both can be opened and closed
  explicitly; each fills the workbench below the header with reachable tabs and a close control. Opening one hides the
  other. Contents/version selection returns to the document. The compact header retains title and approval, while
  execution and annotation tools remain available from menus; View, Edit, and Changes stay visible. Resizing into this
  range collapses both panels without preventing manual reopening.
- The Session sidebar shows the current Agent, provider/model, and Thinking at the top, omitting the name already in the
  header. Values follow the active Session state; a queued configuration change is not displayed as already active.
- A Session started with Ideator and switched to Planner follows the new Plan as soon as `plan_written` attaches it,
  without reloading or waiting for the response to finish. Live workflow and agent changes reach both local and attached
  browsers. A newly attached Plan selects Workflow once; progress continues updating during execution and review.
- Saved history and live events appear once in chronological order, including completion, QA, and review reports. A
  delayed result cannot change an accepted report's time. Repair handoffs do not repeat the original user prompt.
  Activity groups contain only consecutive completed tools and Thinking between messages or special blocks.
- Opening Activity keeps it open as new events arrive. Its toggle opens/closes Thinking blocks, including new Thinking
  rows while open, without changing individual tool blocks. Thinking can also be toggled independently.
- On desktop and mobile, an unfocused composer is one compact row containing attachment, the Agent/model/Thinking
  summary, and the primary action. Focusing it reveals the full input and dropdowns; moving focus between its controls
  keeps it open. On phones, expanded settings show the selected Agent, model, and Thinking values without clipping the
  common selections. Leaving the composer collapses it without losing text, attachments, or queued messages.
- While a stoppable Session is running, an empty composer shows Stop in the primary action slot. Typing text or
  attaching an image changes it back to Send/Steer; clearing the draft returns Stop. Queue remains a separate action.
- Plan and Code Review use shared underline tabs for their left sidebar views. Their right sidebar header contains
  annotation/chat tabs and the collapse control in one row, with no duplicate Annotations heading. Collapsed restore
  controls retain their existing position and behavior.

- Opening and closing Session context preserves the header height and the toggle's vertical position; on phones its tabs
  replace the title on that row, while the Workspace navigation control remains reachable. The expanded pane's header
  background and vertical divider reach the top of the page, with no additional pane divider beneath its tab rail.
- Entering a Session at 900px or narrower, or resizing into that range, hides its context sidebar even when desktop
  preferences saved it open. The owner can reopen it explicitly. Widening restores the desktop preference; narrow-screen
  toggles do not overwrite it. Hamburger and collapse buttons keep their compact height.
- Opening or closing navigation, Session context, Plan/Code Review, or artifact Contents sidebars uses consistent,
  subtle motion. Reduced-motion preferences apply immediately, and repeated toggles preserve the final requested state.

<a id="64-session-experience"></a>

### Browser Sessions

**Scope and maturity:** Existing browser baseline with the complete Personal v1 journey required.

**Requirement: Preserve conversation, drafts, and controls in the browser.**

The owner can create, reopen, follow, and continue Sessions in Workspace. The experience preserves the same conversation
and selected Agent and model across TUI and browser. The primary timeline represents:

- user and Agent messages;
- Agent identity and handoffs;
- tool progress and structured output;
- live human interactions while the owner process is active;
- Plan review links and outcomes;
- execution and validation progress;
- cancellation, failure, and recovery;
- usage and Session status where useful.

Terminal-byte streaming is not the primary Session UI.

**Requirement: Archive conversations from Session history.**

Current Session history provides a per-row Archive action. Idle Sessions archive without confirmation. Busy Sessions
require confirmation to stop current work; Cancel leaves work running and archive state unchanged. Confirm uses the
existing Stop path and waits for settlement before archive. Pending actions are visible. A failed request keeps the
Session in the current view and shows an error with retry guidance. Controls work with keyboard and touch input.
Ordinary history omits archived Sessions; the Archived view belongs in
[Project settings](#project-access-and-navigation), not on Session history. Durable archive semantics follow
[Core Session continuity](runwield-core-prd.md#session-continuity).

**Requirement: Keep repeated browser navigation memory-stable.** Reopening Session, Plan, review, and question pages in
one running Workspace process shows current content without retaining another page renderer for each visit. Navigation
does not cache page responses or make the owner restart Workspace to see current Plan content. Live operation
observation and its memory use remain a targeted follow-up; this requirement does not set a universal process-memory
limit.

**Requirement: Choose a Project before the first message.** New Session shows its route Project above the composer. The
owner can choose another available registered Project only while the draft has no text or images and no create request
is unresolved. The browser uses the current enabled Project, then the last-opened enabled Project in this browser, then
the first enabled Project for the New Session link. An explicit Project route stays explicit. A Project change opens
that Project's New Session route and restores its own draft and Agent/model defaults; it does not move the old draft.
After acceptance, and in existing Sessions, there is no Project choice. Project availability follows
[Project access and navigation](#project-access-and-navigation).

Session lists use the saved title, then the first user message. Commands are valid first messages. A Session with
neither is omitted from lists. The owner can attach, paste, view, and send images from the browser, including while the
same Session is open in the TUI; unsent text and images survive a refresh and remain available after a failed send.

Every workflow tool appears as a prominent, fully expanded block. Its report, decisions, review notes, checklist, and
outcome remain readable in live and saved history. Completed workflow calls must not remain marked as running.

Several Sessions may run across several Projects. Closing a browser tab or losing network access does not cancel work,
including Background Tasks owned by the Workspace host process. Task results can start a turn after the original user
turn ends and appear in the same conversation without a new browser message. On reconnection, Workspace shows the latest
saved conversation and current work. The user can continue when the Session is ready for input without a separate
takeover or preparation step. Replaying saved Background Task results never creates a running operation or keeps the
composer busy after current work settles. Task ownership and limits follow
[Core Session continuity](runwield-core-prd.md#session-continuity), not browser tab lifetime; the browser does not offer
a separate task dashboard or recover process-lost tasks.

Pair Execution uses this same timeline and composer. A checkpoint report ends the Agent turn and remains visible as
conversation. Questions and review discussion do not require a separate decision control and do not resume work.
Natural-language revision, continuation, autonomous switching, and Stop messages are interpreted by the execution Agent
and committed through the typed checkpoint tool. Reloading the page preserves the pending checkpoint.

Shared behavior: [Core TUI conversation](runwield-core-prd.md#tui-conversation),
[models and providers](runwield-core-prd.md#models-and-providers),
[Session continuity](runwield-core-prd.md#session-continuity), and
[local workflow metrics](runwield-core-prd.md#local-workflow-metrics). Browser command controls use the shared command
catalog and follow the same Agent defaults and override rules; switching Agents resets model and thinking choices to
that Agent’s settings. Workspace hides `/theme`, `/quit`, and `/exit`, keeps existing navigation commands, and does not
expose TUI-only process controls.

**Requirement: Keep repeated browser use memory-stable.**

After an operation settles, Workspace keeps its compact identity, result, retry metadata, and applicable Agent-stop
alert, not a second live copy of its transcript, tools, images, or pending answers. Saved conversation and workflow
reports remain in the [Core Session files](runwield-core-prd.md#session-continuity). A slow observer receives the latest
needed snapshot instead of a copy for each live event; closing its browser connection does not end live work, a pending
review, or a Background Task. A reconnect shows current work and committed history. Retry metadata still grows with the
number of requests, and a single active snapshot can be large; this is not an absolute memory ceiling. Whole-history
projection, history virtualization, and active-turn byte limits remain deferred.

**Acceptance scenarios:**

- Given an idle Session in history, Archive removes its row without a confirmation or loss of saved work; it appears in
  Project settings > Archived Sessions.
- Given a busy Session, Archive asks for confirmation. Cancel leaves it running and active; Confirm stops and settles
  work before the Session appears in Archived Sessions, without completing its Plan or workflow.
- Given a failed Stop or archive write, the row remains and an actionable error appears. Keyboard and phone-width users
  can retry the same action without losing access to its transcript.
- After repeated visits to different Sessions, Plans, reviews, and questions, each page shows the current requested
  content. The running Workspace does not retain an additional renderer for every visit. Rebuilding an already loaded
  production renderer requires a server restart; the development server keeps its normal hot reload.
- After many completed turns, the browser can reconnect to the same Session, see complete saved Agent output, and submit
  a follow-up once. A duplicate request keeps its original operation and Session; different input with the same request
  ID is rejected. Completed live operations keep no transcript-sized payloads.
- When an observer reads slowly or disconnects during a turn, new snapshots coalesce without pausing the Agent. A fast
  observer sees the latest busy state, queued steering, and pending review or question. After settlement it receives a
  compact final result and the saved history appears once; no false interruption or stale Session response replaces it.
  A fast completion can still notify Agent-stop once, while restored history does not replay that alert.
- From New Session, the owner sees the route Project above the collapsed composer on desktop and phone. With an empty
  draft, choosing another enabled Project opens its New Session route and loads its saved draft and settings before Send
  is available. A disabled or unavailable Project cannot be chosen. A failed Project read offers Retry; when no Projects
  are available, the owner can open Projects.
- Typing any text, including whitespace, or attaching an image locks the Project choice. A restored draft does the same.
  Clearing unsent input unlocks it unless a create request remains unresolved. A network-error retry stays with its
  original Project; an HTTP 422 rejection keeps its editable draft. Acceptance hides the choice even when only an
  operation ID exists; a Session detail page has no Project choice.
- When the owner starts a Session with a command, it can use that first message as its list title; an empty Session with
  no title or message does not appear.
- Given a typed message and image attachments, when sending fails or the browser refreshes, the draft and previews
  remain available. Image preflight rejection, including unsupported backend attachments such as Antigravity CLI,
  returns a validation error (HTTP 422) before acceptance for both new and resumed Sessions. It never queues the
  rejected request or clears its draft/previews. After correcting the model or image setup, one send is accepted.
- On desktop and mobile, the unfocused composer shows the Agent mascot (when enabled by
  [Core's setting](runwield-core-prd.md#agent-mascots)), Attach, the Agent/provider/model/Thinking summary, and the
  primary action. Its accessible name identifies a saved draft without adding visible text. On a phone, expanded
  settings keep common selected values readable without sideways scrolling. Focusing the summary expands the textarea
  and settings; moving focus outside collapses it without losing text, images or selections. Moving between its controls
  keeps it expanded. Expansion and collapse animate without losing the visible history position or requiring live
  followers to scroll down again; reduced motion is respected. The primary action stops running work when the draft is
  empty and sends or steers when text or images are present.
- On a phone, opening the Session sidebar fills the available height below the Workspace header. Its tabs and close
  control remain reachable while scrolling. Arrow keys and Home/End move between context tabs, and each tab names its
  panel. Keyboard focus cannot enter the covered conversation or composer; closing the sidebar restores both in place
  and makes them available again. On desktop, the visible conversation stays usable.
- The composer shows the active Agent mascot beside its controls, sharing identities and activity semantics with
  [Core's Agent mascots](runwield-core-prd.md#agent-mascots) and honoring the Core `mascot` visibility setting. When
  visible, it keeps a fixed footprint on desktop and phones, pauses for owner input, reduced motion, hidden tabs and
  offscreen views, and never animates from saved history alone.
- When Core becomes busy after a message, the live end of the conversation immediately shows the shared dots loader and
  “Thinking...”, including before any assistant text arrives. It clears when Core is idle or the live operation ends,
  and pauses while a human answer is needed. Reopening saved history does not show an old busy indicator.
- Given a Workspace Session with multiple completed Background Task result turns, when a later user request ends with
  `task_completed`, the Session returns to idle and accepts another message without restarting Workspace. Replaying the
  earlier results during continuation does not reopen their operations.
- When a workflow tool finishes, its full report and outcome remain readable in live and saved history and its block
  stops showing Running. All special tool blocks, including completion and QA reports, have square corners and mint
  titles and left rails identifying RunWield, distinct from blue user messages. Failure status remains visibly red.
  Their rails match other timeline stripes in thickness and meet the frame squarely, without diagonal joins.
- Normal System notices use a mint stripe and tint, distinct from blue user messages; warning and error stripes remain
  amber and red.
- When the owner changes Agents through browser controls, the selected Agent, model defaults, and thinking behavior
  match the TUI.
- Given an existing browser Session with a live Plan review, when the owner enters `/plan-review`, Workspace returns its
  current link when available or reports that it is starting instead of opening another review. If the review has ended,
  the command requests a new review of that Session's last reviewed Plan under
  [Core Plan review](runwield-core-prd.md#plan-review), not a replay of an unanswered decision.
- Given no saved review, busy work, or a Plan that is unavailable or no longer reviewable, when the owner requests
  `/plan-review`, Workspace explains why it cannot open the review.
- Given a live Plan review opened by the TUI or an ACP client, when the owner answers it in Workspace, Workspace uses
  the original reviewed document and rejects the decision if its content has changed. A Sequence group decision uses the
  registered document worktree rather than an absent or older primary Plan.
- Given Pair Execution in Workspace, a checkpoint appears in the normal timeline and the ordinary composer supports
  discussion and a later decision. No separate checkpoint form or final-approval buttons are required.
- Given a pending Pair checkpoint, refreshing or reopening the Session preserves the report and lets a later user
  message resolve it without changing owner, worktree, working directory, tools, or attempt.
- Given a Background Task started in a Workspace-hosted Session, when its browser tab closes before the task finishes,
  its host continues the task. The result appears in the same conversation on reconnection, even if the original turn
  has ended; it does not submit a user command, clear a draft, or resolve a pending human interaction.
- Given a slash command executed in Workspace with `workflowMetrics` enabled, Workspace records command start and finish
  observations under the primary project metrics file with duration and outcome.

**Requirement: Read Session artifacts comfortably on desktop and phone.**

Print / Save PDF produces a complete, paginated light rendering of the document, including readable Mermaid diagrams,
without Workspace navigation or review controls. The printed document is independent of screen scroll position and
dark-mode preferences.

Plan Review and the shared reader show Markdown WARNING, NOTE, and TIP alerts as callouts: amber, blue, and teal boxes
with an icon, a kind label, and the author's bold title. They use the browser theme's semantic colors, wrap on phones,
and keep a visible box and label on paper. Callouts do not change the Markdown, and annotations on their text stay
attached. Plan authoring guidance is owned by
[Core Plan authoring](runwield-core-prd.md#plan-authoring-and-external-adoption). The Changes view shows callout text as
plain quotes; matching callout styling there is deferred.

Opening an artifact gives immediate loading feedback until its document is ready. Browser waiting states use one
consistent dots indicator, familiar from the TUI. One shared Markdown reader serves Plans, PRDs, ADRs, Work Records,
Epic artifacts, and reports from every read-only entry point, including Ideator review prompts, Workspace/TUI Session
artifacts, and the Plan/Work Record read commands. It replaces Workspace navigation with its own full-window logo/title
header and one Contents header. Contents starts collapsed on small screens and uses the same panel control as Plan and
Code Review. Workspace launches return directly to the originating Session; local launches have Close. Feedback stays in
the owning Session interaction. Search opens Work Records and supported documentation through a Project launch of the
same reader. It returns to the preserved Search URL, does not create a Session or artifact registration, and never uses
the standalone review exit action. TUI users can choose a registered artifact with Alt+] and open this same reader.

**Acceptance scenarios:**

- On a slow connection, opening an artifact shows loading feedback during navigation and reader startup, then the
  document replaces it.
- On a phone, an artifact opens with its document visible and Contents closed; the owner can open Contents, select a
  heading, and return to the document, or collapse Contents without selecting anything.
- In Workspace, the artifact title appears once in the reader header and Workspace navigation is absent. A Session
  launch uses Back to Session; a Search launch uses Back to Search and preserves its query and filters.
- An Ideator PRD review, a registered Session artifact, and a Plan/Work Record read command display the same reader;
  only artifact metadata and the return/close action differ.
- In a TUI Session, Alt+] lists registered artifacts and opens the selected artifact in that reader without changing the
  running Agent or artifact content.
- Given a Plan with WARNING, NOTE, and TIP callouts, when the owner opens it in Plan Review or the reader on desktop or
  phone, each callout shows its icon, label, title, and text without widening the page. Printing shows each callout as a
  labeled box on light paper.
- Given an annotation on callout text, when the owner switches between View and Edit or sends feedback, the annotation
  keeps the selected text.

<a id="65-moving-between-tui-and-phone"></a>

### TUI and phone continuity

**Scope and maturity:** Personal v1 required journey; continuation fixes do not narrow this commitment.

**Requirement: Change screens without losing input or duplicating work.**

- As the owner, I can start a conversation in the TUI, leave it open, and send the next message from my phone when the
  Agent is ready for input, so I can keep working away from my desk.
- When I return to the TUI, it shows the messages and results produced from my phone without reopening the Session. The
  same applies when I move from Workspace back to the TUI.
- I can read the conversation while work is running. Changing screens or refreshing does not cancel that work, repeat a
  submitted request, or discard my draft.
- I can answer an Agent question from my phone and have the same work continue. If the process handling that question
  has stopped, the UI explains that the question needs to be retried and keeps the saved conversation available.
- I can continue a long conversation without loading every older message first. Completed work remains available for
  discussion and follow-up.
- If work is still running, I see what is happening and what I can do next. Merely having another screen open is not a
  reason to block me or ask me to recover the Session.
- I can steer the running Agent from either screen and see that message and its response in the same conversation.
- If an actual failure interrupts the Session, I keep my input and receive a concrete next action. Routine screen
  changes do not require recovery steps or technical knowledge.

The shared authority is [Core Session continuity](runwield-core-prd.md#session-continuity); these are its browser/phone
journeys.

**Acceptance scenarios:**

- Given an idle TUI left open, when the owner continues from a paired phone, the same conversation advances and
  automatically appears in the TUI on return.
- Given a long history or completed Plan, when the owner sends a follow-up from either screen, it proceeds without
  loading every old message or a takeover ceremony.
- When the browser disconnects during work, work continues; reconnecting shows saved progress and retains the draft
  without duplicate submission.
- When a process handling a live question has stopped, the owner sees that it needs retry rather than a dead control or
  an invented answer.

<a id="66-plan-actions"></a>
<a id="67-plan-workflow-surface"></a>

### Browser Plan review and workflow

**Scope and maturity:** Current review baseline with the complete Personal v1 journey required.

**Requirement: Review the current Plan and preserve explicit execution choices.**

The owner can review, give feedback, approve for later, or approve and run the current Plan from Workspace. Opening a
Plan or its associated Session does not give that screen permanent control of the work.

**Requirement: Keep Architect Epic review chat in the shared review.**

Plan and Code Review chats accept attached annotations without a typed message. Adding annotations to chat enables Send
and its keyboard shortcut; removing them disables Send when the message is empty. The Agent receives the notes as review
context, and the conversation shows the annotation-only submission. Working or unavailable chats stay disabled.

**Requirement: Repair code without replacing the open review.**

A Code Review repair request keeps the same review screen and conversation through repair and the required CI rerun. The
Agent response and refreshed changes appear in place. Preserve chat history, the selected file, diff collapse choices,
Guided Review versus diff mode, and collapsed guide sections. Retained guide prose is marked as describing an earlier
revision until regenerated; the inline diffs show current changes. A lengthy repair must not lose its refresh
subscription merely because a short UI timeout expires.

Acceptance: collapse a file diff and a guide section, request a repair, and verify that the reply and current diff
arrive in the same standalone or Workspace review without opening another tab. Switch between Guided Review and diff and
verify that both retain their collapse choices and all earlier chat messages.

Workspace Plan Review keeps the Architect discussion on the page across review rounds and permits another message and
reply while the Epic remains in review. It follows [Core Epic review chat semantics](runwield-core-prd.md#plan-review):
opening a saved review starts no model turn, and chat does not replace explicit feedback, cancellation, or approval
actions.

Plan and Code Review replace the entire Workspace shell with the full-window review layout. Each uses its own toolbar
and Contents/Files and Annotations sidebars; the Workspace Project/Session sidebar and its restore control are absent.
Returning to a Session restores the normal Workspace shell. The right sidebar places its Annotations/chat tabs and
collapse control in a single header row, matching standalone reviews, with no duplicate title row. The left sidebars use
that same underline-tab treatment for Contents/Versions and Files/Changes, with both labels visible. Read-only Plan and
artifact views use the same full-window shell with their own logo/title header and Back to Session action. Contents has
one header and collapse control, without a second tab row.

After a successful Plan or Code Review decision in Workspace, return to the originating Session in the same tab. This
includes approval for later, approval to run or decompose, and submitted feedback. Failed or recovery-required decisions
keep the review open. Workspace never applies the standalone auto-close preference; standalone reviews continue to offer
closing the tab or close automatically according to that preference.

Linked source files open with compact, consistent line spacing. Short files must not stretch their rows to fill the
dialog; long files scroll within the reader.

If a Plan changes after the owner opens it, Workspace shows the changed content before accepting an approval for the new
version. Repeated delivery of the same click does not run the action twice. Actual failures explain what happened and
how to continue without silently discarding work.

Once a Plan exists, one Plan-centered surface unifies:

- Plan content and related PRDs, ADRs, research, and Work Records;
- associated Session activity;
- Plannotator review and Feedback;
- readiness and execution authorization;
- execution progress and affected files;
- validation, semantic review, Guided Review, and repair activity;
- Plan worktree state and changes;
- failure details and Plan Recovery;
- confirmed publication or deliberate abandonment, with the applicable Work Record.

Review offers distinct outcomes:

- **Approve & Run:** approve the Plan and authorize the current Session to proceed through readiness, execution, and
  Workflow Validation.
- **Approve for Later:** approve and prepare the Plan as Ready For Work without authorizing immediate execution.

Plan approval never implies ambient permission for a different Session to execute it. An idle Plan saved for later
offers **Review Plan** in its Plan home and Session Workflow sidebar. This opens the saved Plan in the shared review
surface directly; it does not ask an Agent to regenerate the Plan or start execution before a new approval decision.

The Plan home and Session Workflow sidebar show the same workflow presentation: ordered stages, current step, blocker,
next action, and proven working Session link when available. The separate Plan Progress page is not a product surface;
its read data feeds Plan home and Session context.

**Continuation routing:** Plan home resolves its working Session from saved Plan associations even when opened without a
Session parameter. Available actions follow current workflow and Session state; a running or completed workflow does not
offer Resume just because a continuation endpoint exists. Resuming interrupted execution continues its existing worktree
and transcript segment, an Epic ready for decomposition opens Slicer, and validation resumes at its saved phase. Each
action remains an observable Workspace operation with working questions, review links, cancellation, and errors.
Repeated delivery of the same request must not start another operation.

Live questions and reviews belong to the Plan currently owning that operation. A Session's historical association with
another Plan never redirects that Plan's action to the current Plan's question or review. Plans on hold offer **Resume
from hold**, run the existing worktree and staleness checks, and restore their previous stage after any warnings are
confirmed. Approved Plans without a working Session offer **Review Plan**: Workspace creates the review Session and
opens the shared review without an Agent turn. Repeated requests reuse that Session and operation.

Shared rules: [Core Plan review](runwield-core-prd.md#plan-review), [lifecycle](runwield-core-prd.md#plan-lifecycle),
and [execution, validation, and recovery](runwield-core-prd.md#execution-validation-and-recovery).

Internal locks, settings, storage, and synchronization are repaired automatically. Workspace keeps delivery active
through failures and pauses; cancelling a turn does not abandon the workflow. When a real user decision or external
prerequisite is needed, explain the outcome at stake and offer continuation or deliberate abandonment without exposing
internal repair procedures.

**Acceptance scenarios:**

- Given a Workspace Plan or Code Review, submitting approval or feedback returns to its Session in the same tab, even
  when standalone auto-close is enabled. A failed decision stays in review. Standalone reviews still close automatically
  when configured, or offer closing the tab when auto-close is off.
- Given a saved Epic opened or reopened for review in Workspace or standalone Plan Review, two message-and-reply rounds
  with Architect remain visible on the active page. Opening the review starts no model turn. The owner can still use
  separate Send Annotations, Cancel, Approve for Later, and Approve & Slice actions; chat alone does not authorize
  decomposition.
- Opening either review through a direct link or Workspace navigation shows one review toolbar and only review sidebars
  on desktop and mobile. Read-only artifacts likewise omit Workspace navigation and show a single Contents header.
  Returning to the Session restores Project/Session navigation.
- Given a Plan changed since the review opened, when the owner tries to approve, the changed content is shown before the
  approval is accepted.
- Opening a short linked source file keeps adjacent lines together at every viewport size; a longer file remains
  scrollable without pushing the reader controls offscreen.
- On a phone, the Plan document fits the screen with its controls and approval actions reachable. Opening or closing
  Contents or Annotations does not widen the page, and the owner can scroll to the end of the document.
- On a phone, Code Review keeps a readable, scrollable diff below its file list. The list cannot squeeze the diff shut;
  layout controls wrap without widening the page.
- When the same approval click is delivered twice, the action occurs once; Approve for Later never starts execution.
- Given an idle Session whose Plan was approved for later, Review Plan opens a live review of that saved Plan. Approve
  for Later keeps it Ready For Work; Approve & Run starts execution in that Session with the reviewed approval evidence.
- Given an executing Plan, when the owner opens its workflow surface, its review, changes, validation, recovery, and
  resulting record are accessible in context.
- Given a paused validation resumed from Workspace, subsequent questions and Code Review remain answerable there.
- Given interrupted execution resumed from Workspace, file tools write inside the saved execution worktree, keep the
  existing transcript segment, and completing implementation continues into validation.
- Given a Session reused for a second Plan, opening the first Plan never shows the second Plan's live question or
  review.
- Given a held Plan, Resume from hold presents any worktree warnings, rejects stale Plan revisions, and restores the
  previous stage only after confirmation; a Plan restored to Ready For Work then offers Review Plan.
- Given an approved Plan with no Session, Review Plan creates one review Session; duplicate requests create neither
  another Session nor another review, and no Agent runs before approval.
- Given a Plan home opened without a Session query parameter, the saved working Session and eligible next action are
  available; running and completed work offers navigation rather than another Resume.
- Given a revised Plan review, reloading its URL reconnects to the latest review interaction in the same operation.
- On mobile, Answer agent closes the workflow sidebar and makes the live question visible and usable in the Session.
- Given a failed attempt caused by internal state, the workflow stays active while RunWield repairs it; it does not
  become Recently Finished or require the owner to fix storage or locks.

<a id="68-durable-knowledge-search"></a>

### Durable knowledge search

**Scope and maturity:** Delivered for Personal Remote Workspace v2. Search opt-out, research retrieval, full Session
Transcript search, and history filters are deferred.

**Requirement: Retrieve eligible artifacts with scope and confidence visible.**

Workspace Search gives the owner one quick-search dialog and one full results page across enabled registered Projects.
Both surfaces use the same query, Project and type filters, flat ranking, pagination, result identity, and canonical
source checks. Results always identify their Project and content type. Exact document or Session Names rank before title
and heading matches; body and first-message matches follow. Recency only breaks otherwise similar matches.

Eligible sources are current Plans in the normal Plan store, PRDs, ADRs, current approved Work Records,
`docs/design-system.md`, applicable domain-language documents, Session Names, and each Session's first committed user
message. Source code, Plan-worktree code, arbitrary Markdown, general research, archived Plans, non-current Work
Records, and later Session messages are excluded. Session entry lookup is owner navigation, not Project Knowledge Search
or cross-Session Agent retrieval.

Search uses a separate rebuildable index. Before display and navigation, Workspace checks the enabled Project and the
current canonical source. Indexing failure in one Project does not block healthy Projects or other Workspace views.
RunWield-owned writes request an early refresh after they commit; a bounded background scan catches missed requests and
external edits. Search filters do not change Project settings.

Work Record results and readers show the summary, Project, source links, completion confidence, and applicable notices.
Users can tell automated verification from user attestation, skipped verification, and a done-enough Epic. Retrieval
must not treat a completed PRD, old Plan, or Work Record as proof that a current end-to-end journey works.

[Core Work records](runwield-core-prd.md#work-records) owns record generation, eligibility, correction, and completion
confidence. [Core capability-organized requirements](runwield-core-prd.md#capability-organized-product-requirements)
owns PRD authoring behavior.

**Acceptance scenarios:**

- Given two enabled Projects with same-named artifacts, when the owner searches and filters, results keep stable Project
  and type identity and both search surfaces preserve the same order.
- When an indexed source changes, disappears, escapes its registered root, or becomes ineligible, search and an issued
  destination refuse stale evidence before the next background scan.
- When one Project cannot be indexed, healthy Project results and the failed Project's safe status remain visible.
- When a Plan lacks an ID, search skips it without changing its file and still returns other valid results from that
  Project.
- When the owner opens a Work Record or supported document, the shared read-only reader shows current canonical content
  and returns to the preserved Search URL. Session artifact readers still return to their Session.
- When an Agent retrieves planning knowledge, owner-private Session entry text and source-code results are not silently
  included.

<a id="69-human-cross-project-code-search"></a>

### Human cross-Project code search

**Scope and maturity:** Deferred beyond Personal Remote Workspace v2; cross-Project Agent search remains excluded.

**Requirement: Search only deliberately selected Projects.**

A future release can provide RunWield-owned Cymbal federation:

- the user explicitly selects one or more registered Projects;
- searching selected Projects remains responsive while other work continues;
- results are grouped or clearly labeled by Project;
- first-use indexing, refresh, partial results, failures, and freshness are visible;
- a result links only to content the owner authorized Workspace to access;
- duplicate symbols across Projects are not silently collapsed;
- relationship, reference, trace, and impact results remain Project-scoped unless a real cross-Project dependency is
  known.

Global code search targets registered Projects' main checkouts. RunWield Plan worktrees are excluded to prevent
conflicting versions, duplicate results, and exposure of intermediate work. Plan-worktree code remains available through
its Plan workflow and review surfaces.

Cross-Project code search is human-only in the first version. Existing Agent code tools remain scoped to the Session's
Project. Users may deliberately bring selected findings into a Session, but Workspace must not silently grant an Agent
access to other Projects.

Sourcebot is not a first-version dependency. It remains an optional future provider for organization-scale or remote
committed-code search.

**Acceptance scenarios:**

- Given selected registered Projects with duplicate symbol names, when the owner searches, results keep Project identity
  and exclude Plan-worktree duplicates.
- When one selected index fails, available results and the failure/freshness notice remain visible while unrelated work
  continues.
- When the user brings a chosen result into a Session, the Agent does not gain ambient access to the other Projects.

<a id="610-code-surface"></a>

### Main-checkout Code Surface

**Scope and maturity:** Deferred beyond Personal Remote Workspace v2; a future code-server integration remains
subordinate and separately secured.

**Requirement: Inspect and edit the authorized checkout without owning workflows.**

Workspace may launch or connect to code-server as the subordinate **Code Surface** for a Project's main checkout.

The Code Surface:

- supports manual inspection and editing without replacing Workspace navigation;
- does not own Sessions, Plan Lifecycle, validation, recovery, or RunWield worktrees;
- opens global code-search results at the corresponding main-checkout location when valid;
- never pretends Plan-worktree-only content is present in the main checkout;
- preserves code-server's separate security boundary and limits its filesystem reach to the intended Project.

Manual changes and commits remain the developer's responsibility. They may make active Plans stale or create merge
conflicts, which RunWield handles through normal lifecycle and integration checks.

Personal mode preserves existing local agency: QUICK_FIX and supported in-place workflows may modify the main checkout
without being forced into Plan worktrees.

**Acceptance scenarios:**

- When the user opens a global code result, the Code Surface navigates to its authorized main-checkout location rather
  than pretending a worktree-only version exists there.
- When the user edits through the Code Surface, normal stale-Plan and merge checks still apply; the editor does not take
  ownership of Plan lifecycle or other roots.

<a id="611-pairing-and-remote-trust"></a>

### Device pairing and remote trust

**Scope and maturity:** Personal Remote Workspace v1 target.

**Requirement: Authorize devices explicitly and allow revocation.**

Private networking is necessary but not sufficient authorization. The first version requires owner-approved browser
device pairing:

- bootstrap approval is short-lived and intentional;
- paired-device sessions persist but are revocable;
- paired browsers and installed apps retain authorization across launches and Workspace restarts; visiting a saved
  pairing page returns an authorized device to the Dashboard without another approval. Successful page visits renew the
  persistent cookie; revocation or clearing browser site data still requires a new pairing;
- Workspace provides a paired-device and revocation view;
- all browser activity respects the same device access permissions;
- another website cannot act on the owner’s Workspace without authorization;
- browser access requires a secure TLS boundary at non-loopback addresses, using a documented trusted terminator if
  RunWield does not manage certificates itself;
- direct plaintext non-loopback exposure is not a safe default;
- pairing a device grants access only to registered Projects;
- consequential execution, terminal, filesystem, and destructive actions remain explicit and auditable;
- secrets and bearer credentials do not enter Plan front matter, Session Transcripts, URLs beyond bootstrap necessity,
  or repository artifacts.

The first version does not require usernames, passwords, team accounts, account recovery, public-internet exposure, or
organization roles.

Shared Plan capability authorization remains separate from Workspace device authorization. A paired Workspace device
does not automatically receive a Shared Plan capability, and possessing a Shared Plan link does not authorize the owner
Workspace.

**Acceptance scenarios:**

- Given a new browser device, when it requests access, the owner must deliberately pair it; revoked devices cannot
  continue using Workspace.
- Given a paired installed app, when it reopens a saved pairing page or Workspace restarts, it opens the Dashboard with
  its existing authorization rather than generating another code. An external navigation can carry the device cookie,
  while mutations still require the trusted Origin and matching CSRF proof.
- Given a Shared Plan link without owner-device authorization, when someone follows it, they receive only the
  shared-review access and cannot operate owner Workspace.
- When Workspace is reached beyond loopback, access uses the documented secure boundary and exposes only registered
  Projects; another website cannot act as the owner.

### Team planning and governance

**Scope and maturity:** Later collaborative SaaS scope; not Personal v1.

**Requirement: Support team-chosen roles and approval policy.**

Personal Workspace keeps its [Attention dashboard](#attention-dashboard). Team planned work uses the following
Plan-centered experience.

Primary areas:

- Ideas
- Planning
- Review
- Ready
- In Progress
- Verifying
- Done
- On Hold

These are product-facing states for PMs, tech leads, and developers. Raw Core lifecycle statuses can remain visible in
detail views for transparency and debugging.

Natural actions from the Plan screen:

- start a new idea
- create or refine a PRD
- create a Plan
- create an Epic
- review a Plan
- inspect Work Records and planning memory

Searching Work Records is important, but secondary to the Plan workspace.

**Roles and permissions.**

The team product adds independently hosted Projects, team and organization membership, Project-level authorization and
policy, and collaborator-visible durable artifacts.

The later team Workspace should start with minimal roles:

- **Admin**
- **Member**
- **Reviewer/Guest**

Do not encode PM, tech lead, or developer job-title roles by default. Teams should decide how strictly they divide
planning, architecture, and execution responsibilities.

Later, Workspace may allow more granular Member permissions, but this should not be required at launch.

**Approval policy.**

Workspace should use lightweight defaults with optional strictness.

Default behavior:

- Members can create and collaborate with minimal ceremony.
- Important Plans go through review.
- Work Records auto-approve after Recorder generation.
- Epics require explicit approval before decomposition/work.

Optional stricter settings:

- restrict who can approve Plans
- require Work Record review before retrieval
- require ADR links for architectural Plans
- require explicit approval before a Plan can enter Ready

**Acceptance scenarios:**

- Given a team using default policy, when members shape a Plan, they can collaborate without job-title roles while
  important Plans and Epics receive their required review.
- When a team enables stricter approval or Work Record review, those choices govern the relevant transition or retrieval
  without redefining Core verification.
- When a user opens team planning, they can move from an idea or PRD into a Plan or Epic and later discover the
  resulting Work Record.

### Team artifact privacy and authorship

**Scope and maturity:** Later collaborative SaaS scope; owner-private conversation remains a product-wide principle.

**Requirement: Share durable artifacts without sharing private working transcripts.**

Workspace should persist durable artifacts, not raw planning conversation minutia.

Requirements:

- Plans, PRDs, ADRs, and Work Records are team-visible artifacts according to workspace permissions.
- User/agent working conversations are private-first by default.
- Individual chat messages should not be attached to Plans by default.
- Code-review discussion, assignment, and approval state are collaboration process data. Workspace hosts them outside
  the repository, as it does working conversations; only durable results — Plans, Work Records, and commits — enter the
  repo.
- Artifact metadata can store user and Agent authorship.
- Details screens can show quiet metadata such as author, drafting Agent, approval mode, and source references.
- Admin/debug session access may exist where policy allows.
- Product analytics should be anonymized and aggregated for RunWield improvement unless users explicitly opt into
  broader sharing.

**Acceptance scenarios:**

- Given a collaborator permitted to read a Plan, when they inspect its context, eligible artifacts and authorship are
  visible but the author’s private working transcript is not.
- When review discussion is saved, process data stays in Workspace; repository artifacts contain durable results, not
  raw conversation or passive analytics content.

### Team planning intelligence

**Scope and maturity:** Later collaborative SaaS scope; distinct from Personal v1 human search.

**Requirement: Retrieve trusted planning knowledge across permitted Projects.**

The paid Workspace moat is shared cross-project planning intelligence.

```text
A trusted planning system where every material change has a reviewable intent, governed execution, independently verified outcome, and reusable record of what the team learned.
```

Workspace should extend Core's repo-local records with:

- team-wide Work Record search
- cross-project retrieval for new Plans
- context packs for Ideator, Planner, and Architect
- compression/deduplication of older records over time
- answers to "what did we decide before?" across projects
- filtering by project, area, Plan type, completion mode, and status

This is a key reason to pay for Workspace. It should strengthen planning without reframing RunWield as hosted agent
management. Organization-scale intelligence and optional external cross-repository search providers extend this later
scope.

**Acceptance scenarios:**

- Given permitted current records across team Projects, when a Planner retrieves context, results retain provenance,
  completion confidence, and applicable Project scope.
- When older records are compressed or deduplicated, source Plans remain intact and the current guidance stays
  distinguishable from historical material.

### Team code review and delivery

**Scope and maturity:** Later collaborative SaaS scope; owner-only review remains Personal v1.

**Requirement: Preserve review responsibility and require shared checks before merge.**

Teams adopting Workspace receive assignable human review with Agent assistance and a clear path from validated work to
shared CI and merge. Required outcomes:

- Human review defaults to Workspace. Discussion, assignment, and approval state stay outside the repository; only
  durable results such as Plans, Work Records, and commits enter it.
- Teams can explicitly select forge-hosted or Dual Review per repository, team, or instance. The gates do not
  synchronize decisions or silently satisfy one another.
- Workspace merges validated, approved work only after shared CI succeeds. Local checks remain a fast tier and never
  replace shared CI. Publication uses a labeled Forge Change Request as the CI-and-merge envelope, preserving the actual
  author, reviewer, and merger identities.
- Approval counts, required checks, and self-merge policy have familiar forge-style meanings. GitHub sign-in and correct
  person attribution are high-priority roadmap requirements; identity, audit, and review responsibility stay explicit.
- Externally contributed work can become source material for a maintainer-owned Plan while preserving contributor and
  maintainer provenance.

**Shared requirements:** [Core execution and validation](runwield-core-prd.md#execution-validation-and-recovery) and
[team planning and governance](#team-planning-and-governance). Independent hosted Projects, membership, and Project
policy belong to team governance; broader search belongs to [team planning intelligence](#team-planning-intelligence).
Hosted execution follows proven planning, workflow, isolation, and recovery.

**Acceptance scenarios:**

- Given validated work awaiting team delivery, when local checks pass but shared CI fails, Workspace must not merge it.
- When a teammate is assigned review, assistance, decisions, and merge attribution preserve the author, reviewer, and
  merger identities.
- Given a repository explicitly using Dual Review, when one review gate changes, the other gate is not silently
  synchronized or satisfied.
- Given an external contribution, when a maintainer adopts it, the Plan and delivery preserve both contributor and
  maintainer provenance.

<a id="7-product-constraints-and-architectural-reference"></a>

## Product Constraints and Architectural Reference

- Local TUI and ACP use must remain available without starting Workspace or maintaining its registration database.
- Workspace accesses only Projects the owner registered, and the owner can revoke device access.
- Project data and conversation history remain private according to their existing sharing choices. Viewing a Project
  does not authorize wider Agent access.
- Projects can make progress independently. One Project's indexing or failure should not make unrelated work unusable.
- Browser, TUI, and ACP preserve the same Session identity and supported workflow behavior.
- Existing repository artifacts remain usable outside Workspace. Workspace must not require users to move their Plans or
  knowledge into a proprietary document store.

Session storage, synchronization, and writer coordination are described in
[ADR-015](../adr/015-file-authoritative-session-bundles.md). Product requirements above define the experience that
design must support. Internal lock phases, file layouts, and recovery algorithms belong in architecture and
implementation records, not as additional user obligations.

<a id="8-first-version-acceptance-criteria"></a>

## First-Version Acceptance Criteria

This cross-capability journey proves that the independently described capabilities work together. Personal Remote
Workspace v1 is complete only when one trusted developer can:

1. Reach Workspace over a private network, pair a browser deliberately, list paired devices, and revoke one.
2. Register at least two local Projects and verify Workspace cannot browse or search unregistered roots.
3. See an attention-first Dashboard across those Projects that ranks Pinned, Needs You, Ready to Continue, Recently
   Finished, and Running Quietly work without requiring Project-by-Project inspection.
4. Create a standalone Session in Workspace, resume it later, and retain one durable identity across Agent handoffs.
5. Run live Sessions in at least two Projects concurrently without Session, tool, interaction, or workflow state bleed.
6. Start work in Workspace, disconnect the browser, and reconnect to the saved conversation and current progress without
   repeating the request or losing the draft.
7. Start a Session in TUI, leave its window open, send the next message from a phone when the Agent is ready, and return
   to the updated TUI. Repeat in the other direction. Include a long conversation and a completed Plan follow-up.
8. Associate a Session with a Plan, change the Plan after opening its review, and confirm Workspace shows the update
   before accepting approval of the changed content.
9. Complete a bounded FEATURE journey through planning, Plannotator review, **Approve & Run**, execution, Workflow
   Validation, and Work Record visibility from Workspace.
10. Use **Approve for Later** to leave an approved Plan Ready For Work without starting execution.
11. After an interrupted operation, reopen the saved conversation and follow the stated next action without losing input
    or silently repeating work whose outcome is uncertain.
12. Search eligible Plans, PRDs, ADRs, and Work Records within one Project and across contributing registered Projects.
13. Search source code across explicitly selected Projects through Cymbal federation, receive Project-labeled partial
    results when one index fails, and avoid Plan-worktree duplicates.
14. Confirm that another Session's Transcript is absent from Agent retrieval and Workspace Intelligence while remaining
    searchable by the owner for navigation.
15. Open a Project's main checkout in code-server without granting it ownership of RunWield Plan worktrees.
16. Receive an actionable attention signal for a required human interaction, return to the correct Session or Plan
    workflow. Pinning affects which work is easy to find; it does not change what the owner can do.

<a id="9-success-measures"></a>

## Success Measures

The first version succeeds when:

- the owner can complete the acceptance journey remotely without depending on an active TUI process;
- the TUI → phone → TUI journey works with both screens left open and preserves the selected Agent, model, and history;
- ordinary continuation needs no takeover, manual preparation, or full-history download;
- multiple Projects can make progress concurrently while human attention remains understandable;
- repeated requests do not duplicate work, and changed Plans are shown before approval;
- artifact and code search return only eligible, explicitly scoped Project data;
- repository artifacts remain usable through existing CLI and TUI workflows without migration to Workspace-only data;
- users can distinguish durable knowledge, private transcript history, main-checkout code, and Plan-worktree changes;
- Workspace feels like a Plan/workflow product rather than an Agent fleet dashboard or browser IDE wrapper.

<a id="10-risks-and-mitigations"></a>

## Risks and Mitigations

| Risk                                                                  | Product mitigation                                                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent remote access expands the local attack surface.            | Require private networking, device pairing, revocation, trusted Project roots, consistent access permissions, and explicit consequential actions.         |
| Switching screens loses work or blocks ordinary continuation.         | Prove the TUI → phone → TUI journey with open clients, long history, preserved drafts, and follow-up after completed work.                                |
| Background continuation surprises the user.                           | Show Running and Needs You state prominently, notify at human gates, expose cancellation, and preserve explicit execution authorization.                  |
| Multi-Project concurrency exhausts a developer laptop.                | Keep inactive Projects inexpensive, show resource pressure, and return partial results when one Project is unavailable.                                   |
| Cross-Project search leaks sensitive code or paths.                   | Query only explicitly selected registered Projects, sanitize absolute paths, keep Agent tools Project-scoped, and support artifact-intelligence opt-out.  |
| Global search conflates incompatible symbol versions.                 | Keep Project identity visible, group results by Project, exclude Plan worktrees, and avoid invented cross-Project call graphs.                            |
| code-server becomes an unbounded filesystem or terminal backdoor.     | Treat it as a separately bounded Code Surface tied to the intended Project and never as authorization for other roots or Plan worktrees.                  |
| Session history becomes accidental shared memory.                     | Keep Transcripts owner-private and out of Agent retrieval; require durable artifact creation for reusable knowledge.                                      |
| Workspace drifts into generic Agent management or noisy multitasking. | Organize around an attention-first queue, Projects, Sessions, and Plan workflows; keep Running Quietly secondary; do not add generic Tasks or Work Items. |
| Personal architecture cannot evolve to SaaS.                          | Preserve independent Project access and a consistent Session experience so later team hosting can extend the product.                                     |

<a id="11-out-of-scope-for-personal-remote-workspace-v1"></a>

## Out of Scope for Personal Remote Workspace v1

- Public-internet exposure without a private network.
- Team accounts, roles, organization membership, or shared-machine concurrency.
- Multiplayer code review, review assignment, and Workspace-side merge; these arrive with the collaborative SaaS
  Workspace, while Personal v1 review stays owner-only.
- Collaborator access to Session Transcripts.
- Cross-Session Agent retrieval from Session Transcripts.
- Agent access to cross-Project Cymbal search.
- A generic Work Item, Task, ticket, Scrum, or issue-tracker layer.
- Replacing markdown Plans, PRDs, ADRs, or Work Records with database-only documents.
- Rebuilding VS Code, language servers, terminals, debugging, or extension management inside Workspace.
- Opening or editing RunWield-owned Plan worktrees through code-server.
- Requiring Git, GitHub, pull requests, or Plan worktrees for every supported workflow.
- Bundling Sourcebot or depending on its services, authentication, or license.
- Making a raw WebTUI the primary Session experience.
- Blind workflow replay after a crash.
- Silently repeating unfinished work after a crash without knowing its outcome.
- Separate hosted execution environments for each Project.
- Identical token-by-token animation on every open screen. Each screen must still update automatically as work is saved.
- Hosted SaaS execution, billing, organization policy, or multi-tenant infrastructure.
- Replacing Shared Plan capability links with Workspace device identity.

<a id="12-sequencing"></a>

## Sequencing

### Current foundation

Retain and build on:

- current local Plan Workspace;
- Plannotator review;
- Shared Plan collaboration;
- Work Records;
- SessionRuntime and the in-process multi-session host;
- TUI/ACP sibling adapters;
- Cymbal current-Project code intelligence.

### Next: Personal Remote Workspace v1

Deliver the complete first-version boundary in this PRD, including registered Projects, persistent Sessions, remote
device pairing, Attention Dashboard, reliable Session continuation, automatic conversation updates, canonical Plan
action checks, unified Plan workflow, notifications, artifact intelligence, human cross-Project Cymbal search, and the
code-server Code Surface.

Cross-Project search is part of the first version, not a later add-on: a multi-Project Workspace should support
deliberate search across both durable planning artifacts and source code while preserving their different semantics.

### Following: OpenAB/Telegram compatibility

After Personal Remote Workspace establishes reliable Session continuation, automatic updates, and consistent Plan action
coordination, complete the OpenAB/Telegram Stage 1 proof against the same shared coordination model. Telegram remains a
secondary notification and continuation channel rather than a parallel Session owner or primary product shell.

ACP remains the replaceable external-client contract, and full ACP v1 compliance remains valuable independently of
Telegram.

### Later: collaborative SaaS Workspace

Deliver [team planning and governance](#team-planning-and-governance),
[artifact privacy](#team-artifact-privacy-and-authorship), [team intelligence](#team-planning-intelligence), and
[team review and delivery](#team-code-review-and-delivery). Hosted execution follows proven planning, workflow,
isolation, and recovery.

<a id="13-proposed-domain-language"></a>

## Proposed Domain Language

**Workspace Intelligence Search**: Deliberate retrieval over eligible durable artifacts across registered Projects,
preserving source Project, artifact type, status, and freshness. _Avoid_: Public global search, Session Transcript
search, unscoped organization access

**Project Evidence Graph**: A rebuildable provenance projection connecting durable project intent, decisions, Plans,
delivery evidence, and outcomes without replacing source artifacts as project truth. _Avoid_: Plan Evidence Graph,
Session Transcript graph, source of truth

**Assignable Human Review**: Workspace-hosted human code review assigned to a teammate, with Agent assistance for
reviewer and author. Review discussion and approval state are Workspace process data held outside the repository; only
durable results are committed. _Avoid_: pull request, PR review, review sync

**Forge** (proposed redefinition): under the default posture the Forge is the remote git host and merge substrate;
review and repository policy are RunWield capabilities that a team may explicitly delegate to the Forge per repository.
_Avoid_: system of record for intent, review, or memory; required review gate

These terms remain proposed until their respective capabilities ship. Workspace Intelligence Search does not itself
establish the proposed Project Evidence Graph.

<a id="14-references"></a>

## References

- [RunWield Core PRD](runwield-core-prd.md)
- [Session Host and ACP PRD](runwield-acp-protocol-prd.md)
- [Cymbal multi-Project federation research](../research/cymbal-multiproject-search-federation.md)
- [Shared Core Plan lifecycle](runwield-core-prd.md#plan-lifecycle)
- [Collaborative Planning PRD](collaborative-planning-PRD.md)
- [Forge Change Request Delivery PRD](forge-change-request-delivery-prd.md)
- [ADR-007: Local-First Workspace Plan Board](../adr/007-local-first-workspace-plan-board.md)
- [ADR-008: Remote-Canonical Collaborative Shared Spaces](../adr/008-remote-canonical-collaborative-shared-spaces.md)
- [ADR-010: SessionRuntime sibling adapters and ACP](../adr/010-session-runtime-sibling-adapters-and-acp.md)
- [ADR-015: File-Authoritative Session Bundles](../adr/015-file-authoritative-session-bundles.md)
- [RunWield Design System](../design-system.md)

### Session delivery evidence

After confirmed delivery, the owning Session displays a compact evidence card in its timeline. It separates mechanical
checks, semantic AI review, human code review, actual human verification, publication confirmation and Work Record
creation. The same recorded facts feed the TUI summary above its existing continuation choices. Review policy does not
imply review or verification occurred. Checked candidate and delivered commit remain distinct and inspectable. Recorded
check receipts link to the shared Markdown reader; unavailable history stays explicit. Run and repair-start counts
describe recorded receipts, not resettable retry budgets. Failed Work Records preserve delivery confirmation and expose
Retry Work Record, with an explanation that backfill regenerates missing or failed records across completed Plans.

Acceptance: reopening the Session preserves its report; a code-review approval with no verification attestation shows
Human verification: Not recorded; codereview Never explains its stored none policy; a failed Work Record can be retried
without re-executing or republishing the Plan. Narrow screens wrap identifiers and retain every action.
