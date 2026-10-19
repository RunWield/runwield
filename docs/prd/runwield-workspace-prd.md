---
title: RunWield Workspace
status: living-roadmap
createdAt: "2026-07-06T00:00:00.000Z"
updatedAt: "2026-10-16"
---

# RunWield Workspace PRD

**Document role: Living central PRD.** Principles and lasting requirements for the personal browser Workspace and its
continuity with the TUI and phone.

**Status:** The personal local Workspace is delivered in its first iteration. Collaborative SaaS
Workspace requirements are collected in [Collaborative SaaS Workspace](#collaborative-saas-workspace) until they move
to their own PRD. External-client and chat access are owned by the [ACP PRD](runwield-acp-protocol-prd.md); external
Agent hosts are owned by the [Connect PRD](runwield-connect-prd.md).

Architectural choices belong in ADRs, implementation steps and remaining work in Plans, and delivery evidence in Work
Records. Shared lifecycle, validation, and Session behavior are owned by the [Core PRD](runwield-core-prd.md); this
document adds only the browser experience.

## Objective

RunWield Workspace is the primary browser environment for working the RunWield way across several registered Projects.

It serves one developer on their own machine through a private network. The developer can start work in the TUI, walk
away with a phone, continue in Workspace, and return to the TUI with the conversation updated. They move among
Projects, review and execute Plans, receive alerts, and search project knowledge. The browser keeps Core's Plan
approval, validation, recovery, and local developer control.

## Problem Statement

Before Workspace, RunWield work lived in one terminal process per checkout. The owner had:

1. **No multi-Project home** to see attention, active work, Sessions, Plans, and recent outcomes across Projects.
2. **No reliable way to change screens** and continue the same conversation on a phone while an idle TUI stayed open.
3. **No complete browser workflow** that carried one Session through ideation, Plan review, execution, validation, and
   recovery with clear progress and next actions.
4. **No knowledge retrieval across Projects** for Plans, PRDs, ADRs, and Work Records.
5. **No remote trust boundary**, because a loopback launch token is not enough for a persistent, reachable Workspace.

Workspace answers these gaps as a Plan- and workflow-first RunWield product.

## Product Thesis and Principles

RunWield Workspace is **AI-native software planning and workflow continuity**. Its core loop:

```text
ideate or inquire
    -> materialize durable artifacts when useful
    -> review and approve a Plan
    -> execute and validate locally
    -> distill the outcome into a Work Record
    -> use durable records to plan better
```

- **Workspace is the primary browser shell.** Plans, Sessions, workflows, review, knowledge, and attention define the
  product.
- **Projects are explicit trust boundaries.** Registration is the only grant of Project access, and each Project's
  data, Agent tools, and failures stay within that Project.
- **One owner, one conversation across screens.** An open TUI or browser is a view of the Session. The owner continues
  from any screen and sees the result on return. Browser, TUI, and ACP keep the same Session identity.
- **Familiar behavior across screens.** Session commands, Agent defaults, and override rules match the TUI. Browser
  conveniences such as dropdowns and an image picker make the same actions easier to reach. Changing Agents resets
  model and thinking choices to the selected Agent's settings.
- **Plans own planned work.** Once a Plan exists, its workflow surface is the center for review, execution,
  validation, recovery, changes, and associated Sessions.
- **Approval and execution are separate choices.** The owner approves and runs now, or approves for later.
- **Artifacts outrank transcripts.** Plans, PRDs, ADRs, and Work Records are durable knowledge. Session Transcripts are
  owner-private history.
- **Repository artifacts stay canonical.** Plans and knowledge stay usable from the CLI and TUI without migration to
  Workspace-only data. Local TUI and ACP use work without Workspace.
- **Work continues without the browser.** Running work stops only at completion, cancellation, failure, or the next
  required human decision.
- **Continuity is ordinary.** Opening, refreshing, or changing screens keeps the conversation and unsent drafts. TUI and
  Workspace update automatically as the other saves work. Long histories and completed Plans accept follow-ups.
- **One design system.** Workspace, Plan Review, Code Review, and related browser surfaces use the
  [RunWield Design System](../design-system.md).

## Product Model

**Workspace** is the browser environment that contains registered Projects, durable Sessions, Plans, PRDs, ADRs, Work
Records, review surfaces, search, and alerts. Its home is the cross-Project **Attention Dashboard**.

A **Project** is a trusted repository or project directory registered with Workspace. Each Project has its own
Sessions, Plans, knowledge, and health. Several Projects can progress at once; an inactive Project keeps its saved
work. Projects are local roots on the owner's machine.

A **Session** is the durable conversation and workflow thread within one Project. It spans Router triage and specialist
handoffs and has a stable identity and a human-readable Session Name. An **Agent Session** is an internal specialist
invocation inside a Session; Sessions, not Agent Sessions, are what the owner navigates. The owner reviews the full
history of a Session, even when a phase receives only the context relevant to its task.

A Session can begin without a Plan for ideation, inquiry, operation, or QUICK_FIX work. When a Plan materializes, the
Session becomes associated with it and the Plan workflow becomes the main route. Starting from an existing artifact
creates a fresh associated Session; **Resume** re-enters the same Session.

Durable artifacts:

- **Plan:** owns the planned implementation lifecycle; one or more Sessions can be associated with it.
- **PRD:** product intent, with capability requirements and acceptance scenarios.
- **ADR:** an authoritative architecture decision.
- **Work Record:** a retrospective account of completed planned work and its lessons.
- **Session Transcript:** owner-private raw history for resume and navigation.

Workspace indexes and projects repository artifacts; the repository files stay canonical.

## Audience

- one trusted developer;
- on their own machine, or a persistent container they own;
- through Tailscale, WireGuard, or an equivalent private network;
- from owner-approved paired browser devices;
- across several registered local Projects.

This is a durable personal self-hosted product. Teams are served by the
[Collaborative SaaS Workspace](#collaborative-saas-workspace).

## Capability Requirements

Each capability owns its browser requirements and links to Core for shared behavior.

- [Container hosting](#container-hosting)
- [Browser appearance and themes](#browser-appearance-and-themes)
- [Local Plan management](#local-plan-management)
- [Shared Plan collaboration](#shared-plan-collaboration)
- [Attention dashboard](#attention-dashboard)
- [Project access and navigation](#project-access-and-navigation)
- [Installable app and alerts](#installable-app-and-alerts)
- [Browser Sessions](#browser-sessions)
- [Session snapshot sharing](#session-snapshot-sharing) — undelivered
- [Session export](#session-export) — undelivered
- [Document reader](#document-reader)
- [TUI and phone continuity](#tui-and-phone-continuity)
- [Browser Plan review and workflow](#browser-plan-review-and-workflow)
- [Durable knowledge search](#durable-knowledge-search)
- [Device pairing and remote trust](#device-pairing-and-remote-trust)

### Container hosting

**Scope and maturity:** Container packaging and an offline Kubernetes example are available. Cluster deployment is a
separate owner decision. The setup is work in progress and is not yet in the user documentation.

**Requirement: Run personal Workspace in a persistent container.** The owner builds a Linux image with Podman and runs
Workspace on a private Kubernetes server. Projects, `~/.wld` (including memory data), and `~/.agents` have separate
persistent mounts. Replacing the image keeps saved Sessions, device pairing, settings, skills, and registered Projects
when the mount paths stay the same. One Workspace instance writes this state. HTTPS and device pairing are required for
remote access. Deployment and image publication are deliberate owner actions.

**Acceptance scenarios:**

- Build the image, mount the three folders, and start Workspace behind a trusted HTTPS proxy. Pair a browser and
  register a repository from the projects mount.
- Replace the container with the same mounts and paths. Saved state and project files remain; an interrupted Agent turn
  waits for a follow-up message.
- Render the Kubernetes example locally with cluster resources and Flux configuration unchanged.

### Browser appearance and themes

**Scope and maturity:** Current dark identity. Light and custom themes and a theme picker are deferred.

**Requirement: A consistent dark browser workbench.** Workspace, Plan Review, and Code Review use the approved RunWield
brand colors and website typography: compact controls, a mint sidebar brand rail, blue selected context and actions,
and distinct semantic status colors. Browser appearance is independent of OS color preferences and the TUI theme.

**Requirement: Ready for future browser themes.** Browser colors are separate from layout, spacing, and typography. A
future light or custom token set replaces the dark set through the same browser theme renderer, including shared review
components, without restyling each surface. See the [RunWield Design System](../design-system.md#browser-themes).

**Acceptance scenarios:**

- Given a light OS setting or a light TUI theme, Workspace, Plan Review, and Code Review use the dark browser identity.
- Given an alternate browser token set supplied to the renderer, Workspace and review components use its semantic
  colors with their layout, typography, and component styles unchanged.

### Local Plan management

**Scope and maturity:** Current local browser baseline.

**Requirement: Edit and navigate Plans safely.** `wld plans ui` opens a local browser board for the current checkout.
It shows Plans by stage, separates active, held, and finished work, and presents Epics as top-level cards with child
progress. Opening a Plan is read-first; editing has a clear action and saves explicitly. Refresh recovers an unsaved
draft. Body edits keep Markdown usable from the CLI and keep lifecycle fields as they were.

Manual board moves record the owner's choices without claiming automated review or verification. Users can reflect
externally started or completed work, close without verification, or hold work. Failure and hold offer recovery or
resume. Plan, Epic, and filtered-view links survive renaming; local links need a running Workspace, and sharing access
stays explicit. Lifecycle rules follow [Core Plan lifecycle](runwield-core-prd.md#plan-lifecycle).

**Requirement: A clean board layout.** The local board shows its W. logo and heading; the board embedded in a Project
shows only the board. View tabs and search share the header row, with search after the tabs. Columns use separators,
and an empty column shows one consistent empty message. Drag-and-drop feedback appears during the interaction.

**Acceptance scenarios:**

- Given a Plan opened from the board, when the owner edits its body and saves, the Markdown stays usable from the CLI
  and lifecycle fields are unchanged.
- When the owner moves or manually closes work, the board records that choice without claiming verification; failure
  and hold offer recovery or resume.
- When a Plan or Epic is renamed, its existing links resolve and child progress stays visible.

### Shared Plan collaboration

**Scope and maturity:** Current self-hosted collaboration protocol. The container definitions are for testing; runtime
isolation for production hosting is deferred. Hosted deployment and further browser actions belong to the
[Collaborative SaaS Workspace](#collaborative-saas-workspace).

**Requirement: Share review revisions with explicit access.** Workspace supports encrypted Plan sharing through
self-hosted Shared Spaces:

- `wld plans share`, `pull`, `push`, and `unshare` run the review and publishing cycle;
- reviewer and maintainer links are distinct, and Plan documents hold no secrets;
- the browser supports comments, resolving and reopening, and Revision switching;
- one agreed shared review version, with clear publishing and unsharing actions.

**Requirement: One link through successive Revisions.** Reviewers use a stable browser link without accounts or local
tooling. Comments attach to selected text or the whole Revision and stay with that Revision. A maintainer pulls the
latest Revision and feedback into Planner or Architect, revises locally, and publishes the next Revision at the same
link. A maintainer link allows deliberate handoff to another maintainer. Publishing protects newer shared work from
stale local changes. Unshare deletes the remote content and returns the local Plan to independent use, with recovery
guidance if remote content is already gone.

**Requirement: Private content and visible retention.** The hosting service cannot read Plan bodies, comments, display
names, or annotations. Guidance distinguishes reviewer and maintainer links and explains their bearer access. When
expiry is enabled, users see when the Shared Space will expire. Operators receive setup, access, abuse-control,
retention, and backup/restore guidance in the [collaboration documentation](../user-documentation/collaboration.md).
Shared review follows [Core Plan review](runwield-core-prd.md#plan-review) and
[Plan lifecycle](runwield-core-prd.md#plan-lifecycle).

**Deferred:** public creation credentials and their rotation/recovery, signed multi-architecture image publication,
activity/audit feeds, Revision diffs, comment attachments, and closed-Space export. Hosted and browser-management scope
stays in [Collaborative SaaS Workspace](#collaborative-saas-workspace).

**Acceptance scenarios:**

- Given a shared Plan, a reviewer following their link can comment and switch Revisions within that access, without
  receiving maintainer secrets.
- When the maintainer publishes a new review version or unshares, participants see that outcome, and repository
  documents stay free of sharing secrets.
- Given comments on an earlier Revision, publishing a new one keeps the same review link and leaves each comment with
  its original Revision.
- Given optional expiry, the maintainer sees the expiry time; restoring a Shared Space from backup restores access to
  its Revisions and comments.

### Attention dashboard

**Scope and maturity:** Current.

**Requirement: Surface the owner's next consequential action.** The Workspace home is an attention-first queue across
registered Projects. It answers one question:

> What do I need to work on next?

It ranks work by workflow consequence:

1. **Pinned:** Sessions, Projects, Plans, or workflow items the owner pinned to find them easily.
2. **Needs You:** a current human decision or external prerequisite: an unanswered question, a Plan review, a Code
   Review, or an associated Agent stopped with unfinished execution, including a Pair checkpoint. Answering it removes
   the signal. Active TUI Sessions count without first being opened in the browser. Plan status, review settings, old
   repair flags, and Project diagnostics alone are not attention items.
3. **Ready to Continue:** Plans ready for work, paused workflows, ready child Plans, and other safe next actions.
4. **Recently Finished:** delivery workflows that published or that the owner abandoned, and completed non-delivery
   requests.
5. **Running Quietly:** work in progress that needs no decision.

Needs You has the strongest visual priority, and Running Quietly stays secondary. Projects, filters, Session
transcripts, Plan details, validation evidence, Work Records, and Project health stay explorable from the Dashboard.
Each row links to the Session or Plan where the owner acts; the Dashboard itself grants no approval or execution.

**Requirement: Readable sections.** Each section starts with the five most recently updated items, has a header button
to reverse the sort, and offers **Read more** and **Show less**. Sort and expansion survive automatic refreshes. Rows
show their update time, and finished rows also show their completion time. Row titles use the Plan name, or the Session
name for questions without a Plan; the secondary text gives the waiting reason and the next step.

**Requirement: Show the Dashboard before checks finish.** The first page shows all four attention cards in a loading
state. Verified rows appear as their checks finish, independently of other Projects and Plans. Counts stay marked
incomplete until checks finish. A section says "Nothing here" only after all its checks succeed. A failed check shows
an error with Retry and keeps verified rows. A failed refresh keeps earlier rows, labeled as not updated, until a
successful retry replaces them. When a Project cannot be read, the Dashboard says its list may be incomplete and links
to Project settings. Focus stays on a refreshed row, or moves to its section heading when the row is gone. The
Dashboard refreshes automatically while visible.

**Acceptance scenarios:**

- Given two Projects with blocked, ready, finished, and running work, the owner sees what needs attention without
  opening each Project.
- Given a live question, Plan review, Code Review, or a Pair checkpoint, it appears in Needs You and links to its
  Session; answering it removes the signal.
- Given a ready Plan with old repair or review flags, it appears in Ready to Continue.
- When the owner pins work, it becomes easier to find and keeps its existing permissions.
- Given a slow read, all four cards appear at once as loading, and verified rows appear before unrelated checks finish.
- Given completed checks with no work, a card says "Nothing here"; given a failed check, it shows an error and Retry.
- Given more than five items, the five newest appear; reversing the sort and expanding survive refresh.
- Given a Project with thousands of archived Sessions, the Dashboard and sidebar open promptly and reflect newly
  completed work on refresh.

### Project access and navigation

**Scope and maturity:** Current.

**Requirement: Confirm home and system Project roots.**

Add and relink inspect the submitted root on the server using Core's
[exact directory policy](runwield-core-prd.md#project-context-and-initialization). A classified root requires explicit
Continue/Quit consent before the registration transaction writes Project records or root evidence. The server returns
HTTP 409 `directory_confirmation_required` with warning text and an opaque acknowledgement bound to the submitted and
canonical root. Retry rechecks that binding. Responses do not disclose the server home or resolved absolute paths.

Both forms use the same accessible modal, initially focused on Quit, with keyboard containment, Escape dismissal, and
focus return. Quit keeps the entered form values and makes no registration change. Pending requests prevent duplicate
submission. Ordinary roots retain their existing one-request success contract. Existing Projects are not revoked.

**Acceptance scenarios:**

- Given an exact server home or a symlink to a listed root, add or relink returns confirmation-required with no writes.
  Continue registers or relinks once; Quit or Escape keeps the form and existing Project unchanged.
- Given a changed submitted root or retargeted symlink, an earlier acknowledgement cannot authorize the new target.
  Existing authentication, request-forgery protection, deduplication, and retarget conflicts still apply.
- Given an ordinary descendant of a listed root, add and relink need no folder acknowledgement.

**Requirement: Workspace reaches registered Projects.** For each registered Project, Workspace shows:

- registration and RunWield initialization health;
- active, held, failed, implemented, verified, and closed Plans;
- standalone and Plan-associated Sessions;
- PRDs, ADRs, Work Records, and related research;
- knowledge search;
- workflow, Git, validation, and recovery health.

Registering, disabling, and removing a Project change Workspace access and indexing; repository data, Plans, Work
Records, Session history, branches, and RunWield worktrees stay as they are.

**Requirement: Manage a Project from its settings.** Project settings opens from the registration alone, so the owner
can relink, disable, or remove a Project whose root is missing or disabled. Disabling is reversible. Remove deletes the
registration completely and returns to Projects; adding the directory again creates a new registration and rediscovers
its Sessions and artifacts. Repository content becomes available when the Project is enabled and its root exists.
Project settings requests preserve caller-supplied HTTP headers in every standard browser header format, together with the
default JSON content type and owner CSRF token unless explicitly overridden by the caller.

**Requirement: Recover from failed Project requests.** Linking, relinking, and maintenance actions show pending and
failure feedback beside their controls. A rejected network request clears pending feedback, preserves entered paths,
and restores the controls for an explicit retry. Failures never navigate or claim completion, and a later successful
attempt replaces the failure message. Pending requests prevent duplicate submission of the same action.

**Requirement: Restore archived Sessions from Project settings.** Project settings has General and Archived Sessions
tabs. Archived Sessions lists archived names in pages, links to their conversations, and offers Unarchive. Unarchive
returns the same Session ID, transcript, and Plan Associations to ordinary history. Opening an archived Session keeps it
archived. Plan Session listings show archived links with their status. Archive changes require Project access and
Session ownership. Archive semantics follow [Core Session continuity](runwield-core-prd.md#session-continuity).

**Requirement: Navigate without repeated startup work.** Home opens the Attention Dashboard; with no enabled Project, it
opens Projects. The logo returns directly to the last visited Session. Dashboard, Sessions, and Plan home share one
mounted navigation sidebar that keeps expanded Projects and scroll position. The sidebar is usable at once: registered
Projects load first, and each Project's recent Sessions load independently of Plans, other Projects, and the
Dashboard. Pending and failed reads keep New Session and existing navigation available and are labeled as pending or
failed. **Show more** loads the next five recent Sessions that are not already nested under a visible Plan; a failed
request can be retried without duplicate rows. A Project's Plan Board item stays active across its Plan Board, Closed,
and On Hold views.

**Requirement: Consistent headers and menus.** The hamburger menu left of the Workspace logo holds browser notification
permission with its current state and a link to the public documentation. The Workspace brand, main title, and Session
context tabs share one top-aligned header row. Session, Plan Review, and Code Review use the same header alignment,
borderless compact buttons, and menu styling at every width. Projects and Devices share Workspace-level header tabs.
Project rows open a child settings page with Back to Projects, root controls, and maintenance actions. Devices applies
across Workspace, and the current browser has a compact badge. On mobile, sidebar controls stay in the visible header
while the owner scrolls a Session or review and while the viewport resizes. Segmented selectors keep a steady footprint
and slide the highlight; sidebars open and close with subtle motion. Reduced-motion preferences apply immediately.

**Acceptance scenarios:**

- Given two registered roots and one unregistered directory, Workspace offers only the registered roots.
- When a Project is disabled or removed, Workspace access and indexing stop and its files, Sessions, branches, and
  worktrees remain. A removed Project leaves Projects, the sidebar, and the Dashboard, and its old settings URL stops
  resolving; adding its directory again rediscovers its Sessions.
- Given a missing Project root, its settings page opens and offers relink, disable, and remove.
- Given custom request headers as a `Headers` instance, tuple list, or record, Project settings requests
  retain those headers and the default owner CSRF token without changing the caller's request options.
- When a link, relink, enable, disable, remove, or rescan request loses its connection, the page shows a visible
  failure, retains entered values, and permits retry without automatic resubmission or navigation. HTTP errors retain
  the server explanation; successful retries navigate or show rescan diagnostics as usual.
- Given an archived Session, Archived Sessions lists it with paging and opens its conversation; Unarchive returns the
  same Session to ordinary history.
- Given a foreign Session or an unauthorized Project, an Archive or Unarchive request fails and the Session stays as
  it was.
- From a Session or its review, the logo returns to the last Session with the sidebar intact.
- With many saved Sessions, the sidebar shows its recent names promptly and Show more stays available.
- Documentation in the hamburger menu opens `docs.runwield.dev` and leaves the active Session as it is.

### Installable app and alerts

**Scope and maturity:** Current live-page alerts. Web Push for closed or suspended apps, and Plan-ready and
interview-specific alerts, are deferred.

**Requirement: Install Workspace as an online app.** On supported browsers, Workspace installs from its HTTPS origin
(or localhost for development) with a RunWield icon, a standalone window, and the Dashboard as its start page. Device
pairing applies to everything the installed app opens. Workspace needs a live connection: a failed launch or
navigation shows a connection page whose **Try again** retries the original destination. A connection lost in an open
page shows a notice and keeps the page and its unsent text. The notice asks the owner to check their network, the
Workspace server, and Tailscale when used. Failed writes wait for the owner to retry them.

**Requirement: Deliver Session alerts on mobile and desktop.** Workspace shows an Agent-stop alert when Workspace holds
the [notification destination](runwield-core-prd.md#session-continuity), including after steering or answering a TUI-
or ACP-hosted turn from Workspace. Alerts keep arriving while the owner navigates to the Dashboard, another Session, a
Plan, or a review. Delivery uses the active service worker, with the desktop Notification API as a fallback, and
follows notification permission, shared notification settings, and focused-tab suppression. Tapping an alert opens its
Session. Restored history raises no alerts. Delivery errors are diagnosable and leave the Agent turn running.

**Acceptance scenarios:**

- Install from a phone or desktop browser and launch to the Dashboard or the pairing screen.
- Disconnect from the server and open a Session URL: the connection page appears. Reconnect and choose Try again: the
  same URL loads through normal authentication.
- Lose connectivity with a draft open: a retry notice appears and the draft stays. Reconnect: the notice clears.
- Send a message, navigate to the Dashboard, and receive the stop alert with a link back to that Session.
- Steer a TUI turn from Workspace: its stop alert reaches Workspace once. A later accepted TUI input returns the
  destination to the TUI.
- On a mobile browser without the Notification constructor, a permitted alert appears through the service worker.

### Browser Sessions

**Scope and maturity:** Current. Whole-history virtualization and active-turn size limits are deferred.

**Requirement: A complete conversation timeline.** The owner creates, reopens, follows, and continues Sessions in
Workspace with the same conversation, Agent, and model as the TUI. The timeline shows:

- user and Agent messages, with Agent identity and handoffs;
- tool progress and structured output;
- live human interactions while the owner process is active;
- Plan review links and outcomes;
- execution and validation progress;
- cancellation, failure, and recovery;
- usage and Session status where useful.

Saved history and live events appear once, in chronological order. Activity groups hold consecutive completed tools and
Thinking between messages. Opening Activity keeps it open as events arrive, and its toggle opens or closes the Thinking
blocks; each Thinking block also toggles on its own. Shared conversation rules follow
[Core TUI conversation](runwield-core-prd.md#tui-conversation) and
[Session continuity](runwield-core-prd.md#session-continuity).

**Requirement: Workflow reports stay readable.** Every workflow tool appears as a prominent, fully expanded block whose
report, decisions, review notes, checklist, and outcome stay readable live and in saved history. A finished block shows
its final status. Workflow blocks have square corners, mint titles, and a mint left rail, distinct from blue user
messages; failures are red. System notices use a mint stripe and tint; warnings and errors use amber and red.

**Requirement: Choose a Project before the first message.** New Session shows its Project above the composer. The New
Session link uses the current enabled Project, then the Project last opened in this browser, then the first enabled
Project. While the draft is empty and no create request is pending, the owner can choose another enabled Project; this
opens that Project's New Session with its own draft and Agent and model defaults. Text, whitespace, an image, or a
restored draft locks the choice. An explicit Project route stays explicit, and a retry after a network error stays with
its original Project. After the Session is accepted, its Project is fixed.

**Requirement: Drafts and images survive.** The owner attaches, pastes, views, and sends images, including while the
same Session is open in the TUI. Unsent text and images survive a refresh and a failed send. An image the selected
model or backend cannot accept is rejected before the request is accepted, with the draft and previews intact; after
the owner fixes the model or image setup, one send is accepted.

**Requirement: A compact composer.** On desktop and phone, the unfocused composer is one row: the Agent mascot (per
[Core's setting](runwield-core-prd.md#agent-mascots)), Attach, the Agent, provider, model, and Thinking summary, and the
primary action. Focusing it reveals the full input and settings; moving focus between its controls keeps it open, and
leaving collapses it with text, images, selections, and queued messages intact. The history position stays put during
expansion. On phones, expanded settings show common selections without clipping, and the composer stays above the
on-screen keyboard. While a stoppable Session runs, an empty composer's primary action is **Stop**; text or an image
makes it **Send** or **Steer**. **Queue** is a separate action. When Core becomes busy, the end of the conversation
shows the shared dots loader and "Thinking...", which pauses for owner input and clears when Core is idle; saved history
shows no busy indicator. The composer's accessible name identifies a saved draft.

**Requirement: Session context in a sidebar.** The Session sidebar shows the active Agent, provider and model, and
Thinking at the top, following the active Session state. When `plan_written` attaches a new Plan, the sidebar follows it
at once and selects the Workflow tab once; progress keeps updating through execution and review. Workflow content uses
the Workflow tab as its heading and the sidebar as its scroll area, with an active stripe on the current step. At 900px
and narrower, the sidebar starts hidden and the owner can open it; the desktop preference returns when the window
widens. On a phone, the open sidebar fills the height below the header, its tabs and close control stay reachable,
arrow keys and Home and End move between tabs, keyboard focus stays inside the sidebar, and the covered conversation
returns in place on close. A queued configuration change shows as queued until it applies. The toggle keeps
its position, and the header keeps its height.

**Requirement: Commands match the TUI.** Browser command controls use the shared command catalog with the same Agent
defaults and override rules. Workspace offers navigation commands and leaves out TUI process controls (`/theme`,
`/quit`, `/exit`). `/plan-review` follows [Core Plan review](runwield-core-prd.md#plan-review).

**Requirement: Session lists are readable.** Session lists use the saved title, then the first user message; a command
is a valid first message. Sessions with neither stay out of the lists.

**Requirement: Archive conversations from history.** Each history row has Archive. Idle Sessions archive at once. A
busy Session asks for confirmation; Confirm stops the work, waits for it to settle, then archives, and Cancel leaves it
running. Pending actions are visible, and a failed request keeps the row with an error and retry guidance. The controls
work with keyboard and touch. Archived Sessions are restored from
[Project settings](#project-access-and-navigation).

**Requirement: Work runs independently of the tab.** Several Sessions can run across several Projects. Closing a tab or
losing the network leaves work running, including [Background Tasks](runwield-core-prd.md#background-tasks). Task
results can start a turn after the user's turn ends and appear in the same conversation. On reconnection, Workspace
shows the latest saved conversation and current work, and the owner continues when the Session is ready for input.
Replayed task results stay history. [Pair execution](runwield-core-prd.md#frontend-engineering-and-pair-execution)
uses the same timeline and composer; a pending checkpoint survives refresh.

**Requirement: Server shutdown cancels local work before waiting.** Stopping the Workspace server cancels its active
Session turns and pending browser interactions before it waits for accepted operations to settle. The coordination
store stays open until settlement finishes. Shutdown does not wait for a browser answer.

**Requirement: Workspace stays current through repeated use.** Repeated visits to Sessions, Plans, reviews, and
questions show current content without a restart, and memory from completed work does not accumulate per visit. A slow
or disconnected observer receives the latest state when it catches up, and live work continues. This is not a
universal process-memory limit; memory use of live observation remains a targeted follow-up.

**Acceptance scenarios:**

- From New Session, the owner sees the Project above the composer on desktop and phone; with an empty draft, choosing
  another enabled Project loads its draft and settings. Typing locks the choice, and clearing the draft unlocks it.
- Given a failed Project read, the selector offers Retry; with no Projects, it links to Projects.
- Given a typed message and images, the draft and previews survive a failed send and a refresh.
- Given an attachment the backend cannot accept, the request is rejected with the draft intact, for new and resumed
  Sessions.
- Given a running Session and an empty composer, the primary action stops the work; typing turns it into Send or Steer.
- Given an active model turn or an unanswered browser question, stopping the Workspace server cancels the wait and
  settles accepted work before it closes the coordination store.
- Given a phone, the composer stays visible above the keyboard and the draft and history position survive closing it.
- Given a Session switched from Ideator to Planner, the sidebar follows the new Plan as `plan_written` attaches it,
  without a reload, on local and attached browsers.
- Given a finished workflow tool, its full report stays readable and its block shows the final status.
- Given an idle Session, Archive removes its row at once; given a busy Session, Confirm stops and settles the work
  first, and Cancel leaves it running.
- Given a failed archive request, the row stays with an actionable error.
- Given a Background Task started from Workspace and a closed tab, the task finishes and its result appears in the same
  conversation on reconnection, with the draft and any pending interaction unchanged.
- Given several completed Background Task result turns, a later `task_completed` returns the Session to idle and the
  next message is accepted.
- Given many completed turns, the browser reconnects to the same Session, sees the complete saved output, and submits a
  follow-up once.
- Given a Pair checkpoint, it appears in the normal timeline and a later message in the ordinary composer resolves it.

### Session snapshot sharing

**Scope and maturity:** Undelivered Workspace capability. The existing Gist-based sharing path is not this capability.

**Requirement: Share an explicit, read-only snapshot.** `/share` in Workspace previews committed Session history before
creating an anyone-with-the-link snapshot. The preview makes the content being shared explicit. A TUI connected to
Workspace uses the same sharing flow. Each Session has at most one active snapshot. It includes committed user and Agent messages and completed tool calls in collapsed,
expandable groups with their original tool headers. Model thinking and temporary live waits stay private.

**Requirement: Owner-controlled publication and access.** Later Session activity stays private until the owner updates
the snapshot. An update replaces its content at the same link. Rotating the secret creates a new link and disables the
old one; revocation disables sharing while preserving the original Session. The link grants access only to the
snapshot, not control of the Session, its Project, or live activity. Existing Workspace hosting and network boundaries
still apply. Team identity and collaboration controls remain separate future scope.

**Acceptance scenarios:**

- Given a private Session, when the owner previews and creates a snapshot, its link shows the previewed committed history
  read-only, with tool groups collapsed and thinking omitted.
- Given an active snapshot, when the original Session receives another message, the shared copy stays unchanged until
  the owner explicitly updates it; the update keeps the same link.
- Given a shared link, rotating it disables the old link, and revocation disables the active link without changing the
  original Session.
- Given a TUI connected to Workspace, `/share` uses the same preview, snapshot, update, rotation, and revocation flow.

**Proposed Domain Language — Shared Session Snapshot:** The one active, revocable, read-only copy of committed Session
history published by its owner through a bearer link. It changes only on explicit update. Affected terms: Workspace,
Session, Session Transcript, and Session Control. The source Session remains private and authoritative; snapshot access
confers no Session Control or Project access. _Avoid_: shared Session, public Session, live Session link, collaborative
Session. This term remains proposed until the capability ships.

### Session export

**Scope and maturity:** Undelivered browser capability. Output-format choices are deferred to its implementation work.

**Requirement: Download a Session from the browser.** The owner can export a Session through its actions or `/export`
and receive a browser download. Export keeps the existing Session available and preserves its workflow state. This is
an owner download, separate from publishing a shared snapshot.

**Acceptance scenarios:**

- Given a saved Session, when the owner chooses Export or invokes `/export`, the browser offers its exported
  conversation as a download and the original Session stays available.
- Given a canceled or failed download, the original conversation, draft, and workflow remain intact.

### Document reader

**Scope and maturity:** Current.

**Requirement: One reader for every durable document.** One shared Markdown reader serves Plans, PRDs, ADRs, Work
Records, Epic artifacts, and reports from every read-only entry point: Ideator review prompts, Session artifacts in
Workspace and the TUI, Search, and the `wld plans read` and `wld wr read` commands. It has its own full-window logo and
title header and one Contents header. Opening a document shows loading feedback until it is ready. A Session launch
returns with **Back to Session**, a Search launch with **Back to Search** (keeping its query and filters), and a local
launch with **Close**. A Search launch creates no Session or artifact registration. Feedback stays in the owning
Session interaction. In the TUI, Alt+] lists registered artifacts
and opens the selected one in this reader.

**Requirement: Comfortable on phone and paper.** Contents starts collapsed on small screens and uses the same panel
control as Plan and Code Review. Print / Save PDF produces a complete, paginated light rendering with readable Mermaid
diagrams and without navigation or review controls, independent of scroll position and dark mode. Browser waiting
states use one consistent dots indicator. Linked source files open with compact line spacing; long files
scroll within the reader.

**Requirement: Callouts render as callouts.** Plan Review and the reader show Markdown WARNING, NOTE, and TIP alerts as
amber, blue, and teal boxes with an icon, a kind label, and the author's bold title. They use the theme's semantic
colors, wrap on phones, and keep a visible box and label on paper. The Markdown stays as written, and annotations on
callout text stay attached. The Changes view shows callouts as plain quotes; styled callouts there are deferred.
Callout authoring is owned by [Core Plan authoring](runwield-core-prd.md#plan-authoring-and-external-adoption).

**Acceptance scenarios:**

- On a slow connection, opening a document shows loading feedback, then the document.
- On a phone, a document opens with Contents closed; the owner opens Contents, selects a heading, and returns to the
  document.
- An Ideator PRD review, a Session artifact, and a `wld plans read` command show the same reader with different return
  actions.
- From Search, the reader returns to Search with its query and filters.
- Given WARNING, NOTE, and TIP callouts, each shows its icon, label, title, and text on desktop, phone, and paper.
- Given an annotation on callout text, it keeps its selection through View, Edit, and feedback.

### TUI and phone continuity

**Scope and maturity:** Current required journey. The shared authority is
[Core Session continuity](runwield-core-prd.md#session-continuity); these are its browser and phone journeys.

**Requirement: Change screens without losing input or duplicating work.**

- As the owner, I start a conversation in the TUI, leave it open, and send the next message from my phone when the
  Agent is ready for input.
- When I return to the TUI, it shows the messages and results from my phone. The same holds from Workspace back to the
  TUI.
- I read the conversation while work runs. Changing screens or refreshing keeps the work running, submits each request
  once, and keeps my draft.
- I answer an Agent question from my phone and the same work continues. If the process that asked has stopped, the UI
  says the question needs a retry and keeps the conversation.
- I continue a long conversation without loading every older message. Completed work stays open for follow-up.
- I steer the running Agent from either screen and see the message and its response in the same conversation.
- While work runs, I see what is happening and what I can do next. Another open screen never blocks me or asks me to
  recover the Session.
- If a real failure interrupts the Session, I keep my input and receive a concrete next action.

**Acceptance scenarios:**

- Given an idle TUI left open, when the owner continues from a paired phone, the same conversation advances and appears
  in the TUI on return.
- Given a long history or a completed Plan, a follow-up from either screen proceeds directly.
- When the browser disconnects during work, work continues; reconnecting shows saved progress and keeps the draft.
- When the process behind a live question has stopped, the owner sees that it needs a retry, with no dead control or
  invented answer.

### Browser Plan review and workflow

**Scope and maturity:** Current. Shared rules come from [Core Plan review](runwield-core-prd.md#plan-review),
[Plan lifecycle](runwield-core-prd.md#plan-lifecycle), and
[execution, validation, and recovery](runwield-core-prd.md#execution-validation-and-recovery).

**Requirement: Review the current Plan and keep explicit execution choices.** From Workspace, the owner reviews, gives
feedback, approves for later, or approves and runs the current Plan:

- **Approve & Run** approves the Plan and authorizes the current Session to proceed through readiness, execution, and
  Workflow Validation.
- **Approve for Later** makes the Plan Ready For Work and waits for a later decision.

Only Approve & Run authorizes execution, and only for the current Session; approval gives no other Session permission
to run the Plan. If the Plan changed after the owner opened it, Workspace shows the
changed content before it accepts approval. A decision on a review that the TUI or an ACP client opened uses the
originally reviewed document. A repeated delivery of the same click runs the action once. If a review request supplies
an approval value, it must be a boolean; malformed approval values leave the Plan and live review unchanged. Feedback
and review chat may omit approval.

**Requirement: Full-window review.** Plan and Code Review replace the Workspace shell with the full-window review
layout: their own toolbar, Contents or Files on the left, and Annotations or chat on the right. Left sidebars use square
underline tabs (Contents and Versions; Files and Changes). The right sidebar header holds its Annotations and chat tabs
and the collapse control in one row. After a successful decision in Workspace (approval for later, approval to run or
decompose, or submitted feedback), the owner returns to the originating Session in the same tab. A failed decision
keeps the review open. Standalone reviews keep their close-tab or auto-close behavior.

**Requirement: Review layouts fit the screen and the owner's preferences.** Code Review remembers the owner's last Split
or Unified view in this browser. Both layouts and Guided Review wrap long lines. Plan and Code Review start with
Annotations collapsed and open it at the first annotation; a later manual collapse holds. At 980px and narrower, Files
in Code Review, and Contents and Annotations in Plan Review, start collapsed; each opens from the toolbar, fills the
workbench below the header, and opening one closes the other. The compact Plan Review header keeps the title, approval,
and the View, Edit, and Changes controls, with execution and annotation tools in menus. On a phone, the Plan fits the
screen with its actions reachable, and the Code Review diff stays readable below its file list.

**Requirement: Plan content comes before front matter.** Plan Review uses Wide when no valid width preference is saved.
Saved width choices remain available in standalone review; Workspace review uses the full document width. View mode
starts with the front matter card hidden. Show front matter reveals it, and Hide front matter hides it again. Edit mode
keeps the full Markdown, including editable front matter, regardless of the card's visibility. On phones, document
actions sit above the title, not beside its first lines.

**Requirement: Contained working-file reads.** Code Review validates the OS-resolved path of the opened file before
reading response bytes from that same file object. A concurrent directory replacement cannot redirect the read outside
the Project. If the host cannot verify the opened object's containment, it refuses the read. Reads do not modify files
or change access controls.

**Requirement: Chat in the review.** Plan and Code Review chats accept attached annotations without a typed message:
attaching annotations enables Send and its keyboard shortcut. The Agent receives the notes as review context, and the
conversation shows the submission. Working or unavailable chats stay disabled. While an Epic is in review,
the Architect discussion stays on the page across rounds, following
[Core Epic review chat](runwield-core-prd.md#plan-review).

**Requirement: Answer Plan Questions in place.** A valid `wld-question` fence appears as one question card in its Plan
section, with Yes/No, text, or multiple-choice controls. Multiple choice includes Other with free text. The form marks
the recommended answer but does not select it for the owner. Invalid blocks remain readable code with a parse-error
note. Answers survive a reload of the same Plan revision; answers for removed question ids are dropped after revision.

Answered questions attach to Planner chat automatically. The context chip shows the answer count and combines with
attached review notes. Send and Send Annotations include a “Question answers” section. Removing the chip omits that
context from the chat message without erasing the answers. Before either approval action, open questions trigger a
confirmation that names their count and says the recommended answers will be used. Cancel keeps review open. Approval
follows [Core's question resolution rules](runwield-core-prd.md#plan-review). No bundled Agent writes question blocks;
local Planner instructions can opt in.

**Requirement: Repair code inside the open review.** A Code Review repair request keeps the same review screen and
conversation through the repair and the required CI rerun. The Agent's reply and the refreshed changes appear in place,
with chat history, the selected file, diff collapse choices, the Guided Review or diff mode, and collapsed guide
sections intact. Guide prose from an earlier revision is marked as such until it is regenerated. Long repairs keep
their live updates.

**Requirement: One Plan-centered workflow surface.** Once a Plan exists, its Plan home brings together:

- Plan content and related PRDs, ADRs, research, and Work Records;
- associated Session activity;
- review and feedback;
- readiness and execution authorization;
- execution progress and affected files;
- validation, AI review, Guided Review, and repair activity;
- worktree state and changes;
- failure details and recovery;
- confirmed publication or deliberate abandonment, with the applicable Work Record.

Plan home and the Session Workflow sidebar show the same presentation: ordered stages with the active step marked, the
blocker, the next action, and the proven working Session link when one exists. Step descriptions explain the work,
proven results, waiting user actions, and available errors; Publication describes the confirmed phase and any recorded
failure. Code Review follows AI review, then Publication. Ready-for-work
Plans show Planning as complete and Execution as next. Plan home uses the shared navigation sidebar and title header,
with Contents starting collapsed and Contents and Workflow controls on one row.

**Requirement: Continue Plans from Workspace.** Plan home finds its working Session from saved Plan associations.
Actions follow the current workflow and Session state:

- interrupted execution continues in its existing worktree and transcript segment and proceeds into validation;
- paused validation resumes at its saved phase in the existing worktree, as `/load-plan` does, with pause reasons
  shown and later questions and Code Review answerable in Workspace; live progress replaces the paused display;
- an Epic ready for decomposition opens Slicer;
- a held Plan offers **Resume from hold**, runs the worktree and staleness checks, rejects a stale Plan revision, and
  restores its previous stage after the owner confirms any warnings;
- an approved Plan without a working Session, or an idle Plan approved for later, offers **Review Plan**, which opens
  the saved Plan in the shared review with no Agent turn and reuses its review Session on repeated requests;
- running and completed work offers navigation.

Each action is an observable operation with its questions, review links, cancellation, progress, and errors shown beside
it, including on mobile. A repeated delivery of the same request starts one operation. Live questions and reviews belong
to the Plan that owns them. Workflow recovery follows [Core workflow
completion](runwield-core-prd.md#workflow-completion-and-automatic-recovery).

**Requirement: Delivery evidence in the Session.** After confirmed delivery, the Session shows a compact evidence card
that separates mechanical checks, AI review, Code Review, the owner's verification, publication confirmation, and Work
Record creation. The TUI summary uses the same facts. Review policy is labeled as policy; the card shows only reviews
and verification that occurred. The checked candidate and the delivered commit are shown separately. Check receipts
open in the shared reader, and unavailable history is labeled as unavailable. Run and repair counts describe recorded
receipts. A failed Work Record keeps the delivery confirmation and offers **Retry Work Record**, with an explanation
that backfill regenerates missing or failed records across completed Plans. On narrow screens, identifiers wrap and
every action stays available.

**Acceptance scenarios:**

- Given a Plan Review with no saved width choice, it opens Wide and its front matter card is hidden. Show front matter
  reveals the card; Hide front matter removes it without changing the Plan.
- Given hidden front matter, Edit still shows its YAML. After the owner changes a field and saves, Show front matter
  shows the changed value.
- Given a saved Compact or Default width, standalone Plan Review keeps that choice.
- Given a Plan with no front matter, View has no front matter toggle.
- Given a Plan with a Plan Question in a section, the owner answers it there and reloads; the same answer is restored.
- Given answered questions and attached review notes, chat shows their combined context count and Send carries both.
  Removing the chip excludes both from that chat message. Annotation-only Send remains available.
- Given question-answer feedback, Planner can record the decision in the affected section, remove the answered block,
  and present the revised Plan in the same review loop. Answers for removed ids no longer appear in the draft.
- Given an open question, either approval action warns with the count. Cancel keeps review open; confirmation saves
  the resolved Plan under Core's approval rules.

- Given a Workspace Plan or Code Review, submitting approval or feedback returns to its Session in the same tab; a
  failed decision stays in review.
- Given an inside-Project working file, Code Review returns its content. A static outside-Project symlink is rejected.
- Given concurrent directory changes during a working-file read, Code Review returns only contained content or refuses
  the read; outside files stay unchanged.
- Given a Plan changed since the review opened, approval shows the changed content first.
- Given the same approval click delivered twice, the action runs once; Approve for Later starts no execution.
- Given a live review receives a nonboolean approval value, the request fails without changing the Plan or consuming the
  review; a subsequent valid decision still succeeds.
- Given a saved Epic in review, two message-and-reply rounds with Architect stay on the page, and explicit review
  actions still decide the review.
- Given Unified selected, a reload keeps Unified with Annotations closed; the first note opens Annotations and a later
  manual collapse holds.
- Given a narrow screen, Files starts closed, its toolbar button opens it, and long lines wrap in Split and Unified.
- Given a repair request in Code Review, the reply and current diff arrive in the same review, with collapse choices and
  chat history intact.
- Given an idle Plan approved for later, Review Plan opens a live review; Approve & Run starts execution in that
  Session.
- Given an approved Plan with no Session, Review Plan creates one review Session; repeated requests reuse it.
- Given interrupted execution resumed from Workspace, file tools write in the saved worktree and completion continues
  into validation.
- Given a Session reused for a second Plan, opening the first Plan shows only its own questions and reviews.
- Given a held Plan, Resume from hold shows worktree warnings, rejects a stale Plan revision, and restores the previous
  stage after confirmation.
- Given a Plan home opened without a Session parameter, the working Session and the eligible next action appear.
- Given a revised Plan review, reloading its URL reconnects to the latest review interaction.
- On mobile, **Answer agent** closes the workflow sidebar and shows the live question in the Session.
- Given a reopened Session after delivery, the evidence card remains. A Code Review approval without verification shows
  **Human verification: Not recorded**, `codereview` Never explains its stored `none` policy, and a failed Work Record
  can be retried without new execution or publication.
- Given an internal failure, the workflow stays active while RunWield repairs it, outside Recently Finished.

### Durable knowledge search

**Scope and maturity:** Current. Search opt-out, research retrieval, full Session Transcript search, and history filters
are deferred.

**Requirement: Retrieve eligible knowledge with scope and confidence visible.** Workspace Search offers a quick-search
dialog and a full results page across enabled registered Projects. Both use the same query, Project and type filters,
ranking, pagination, and result identity. Results identify their Project and content type. Exact document or Session
Names rank first, then title and heading matches, then body and first-message matches; recency breaks ties.

Searchable sources:

- current Plans;
- PRDs and ADRs;
- current approved Work Records;
- `docs/design-system.md` and applicable domain-language documents;
- Session Names and each Session's first user message, for owner navigation.

Before showing or opening a result, Workspace checks the Project and the current source. One Project's indexing failure
leaves other Projects' results and other Workspace views working. RunWield's own writes appear in search promptly, and
external edits appear after a background scan. Search filters leave Project settings unchanged.

Work Record results show the summary, Project, source links, completion confidence, and notices, so the owner can tell
RunWield verification from user attestation, closure without verification, and done-enough Epics. A completed PRD,
old Plan, or Work Record is history; it is not proof that a current journey works. Record generation and confidence are
owned by [Core Work records](runwield-core-prd.md#work-records).

**Acceptance scenarios:**

- Given two Projects with same-named artifacts, results keep their Project and type, and both search surfaces show the
  same order.
- When a source changes, disappears, leaves its registered root, or becomes ineligible, search and its links show the
  current state before the next background scan.
- Given a document added during indexing, search finds it when its requested refresh completes.
- When one Project cannot be indexed, healthy results and the failed Project's status stay visible.
- Given a Plan without an ID, search skips it, leaves its file as it is, and returns the Project's other results.
- When the owner opens a Work Record, the shared reader shows current content and returns to Search.
- When an Agent retrieves planning knowledge, it receives durable artifacts; Session entry text stays owner-only.

### Device pairing and remote trust

**Scope and maturity:** Current.

**Requirement: Authorize devices explicitly and allow revocation.** A private network is required, and device pairing
authorizes each browser:

- bootstrap approval is short-lived and intentional;
- paired browsers and installed apps stay authorized across launches and Workspace restarts; a saved pairing page
  returns an authorized device to the Dashboard;
- Workspace lists paired devices and revokes them; revocation or cleared site data requires a new pairing;
- every browser action uses the same device permissions;
- other websites, including sites open in a paired browser, cannot act on the owner's Workspace;
- non-loopback access uses TLS, through RunWield or a documented trusted terminator;
- a paired device reaches registered Projects only;
- consequential execution, terminal, filesystem, and destructive actions are explicit and auditable;
- secrets and bearer credentials stay out of Plan front matter, Session Transcripts, repository artifacts, and URLs
  beyond the bootstrap step.

Shared Plan links and Workspace device pairing are separate permissions: each grants only its own access.

**Acceptance scenarios:**

- Given a new browser, the owner pairs it deliberately; a revoked device loses access.
- Given a paired installed app, reopening a saved pairing page or restarting Workspace opens the Dashboard with the
  existing authorization.
- Given a Shared Plan link without device pairing, its holder receives shared-review access only.
- Given access beyond loopback, Workspace uses the secure boundary and exposes registered Projects only.
- Given another website open in a paired browser, it cannot act as the owner.

## Personal Workspace Acceptance Journey

This cross-capability journey shows that the capabilities work together. One trusted developer can:

1. Reach Workspace over a private network, pair a browser deliberately, list paired devices, and revoke one.
2. Register at least two local Projects and confirm that Workspace cannot browse or search unregistered roots.
3. See an attention-first Dashboard across those Projects with Pinned, Needs You, Ready to Continue, Recently Finished,
   and Running Quietly work.
4. Create a standalone Session in Workspace, resume it later, and keep one durable identity across Agent handoffs.
5. Run live Sessions in two Projects at once, each with its own Session, tool, interaction, and workflow state.
6. Start work in Workspace, disconnect the browser, and reconnect to the saved conversation and current progress with
   the request submitted once and the draft intact.
7. Start a Session in the TUI, leave it open, send the next message from a phone, and return to the updated TUI; then
   the reverse, including a long conversation and a follow-up after a completed Plan.
8. Change a Plan after opening its review and see the update before approval is accepted.
9. Complete a bounded FEATURE through planning, Plan Review, **Approve & Run**, execution, Workflow Validation, and
   Work Record visibility from Workspace.
10. Use **Approve for Later** to leave an approved Plan Ready For Work.
11. After an interrupted operation, reopen the saved conversation and follow the stated next action with input intact
    and uncertain work waiting for the owner's choice.
12. Search eligible Plans, PRDs, ADRs, and Work Records within one Project and across registered Projects.
13. Confirm that Agent retrieval receives durable artifacts while Session Transcripts stay owner-only navigation.
14. Receive an actionable attention signal for a required human interaction and return to the correct Session or Plan
    workflow.

## Success Measures

- The owner completes the acceptance journey remotely without an active TUI process.
- The TUI → phone → TUI journey works with both screens open and keeps the Agent, model, and history.
- Ordinary continuation is direct: no takeover, manual preparation, or full-history download.
- Several Projects progress at once while human attention stays understandable.
- Each request runs once, and changed Plans are shown before approval.
- Search returns eligible data from registered Projects only.
- Repository artifacts stay usable through the CLI and TUI.
- Users can tell durable knowledge, private transcript history, and Plan-worktree changes apart.
- Workspace feels like a Plan and workflow product.

## Risks and Mitigations

| Risk                                                       | Product mitigation                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent remote access expands the local attack surface. | Private networking, device pairing, revocation, registered Project roots, consistent permissions, and explicit consequential actions. |
| Switching screens loses work or blocks continuation.       | Prove the TUI → phone → TUI journey with open clients, long history, kept drafts, and follow-ups after completed work.                |
| Background continuation surprises the owner.               | Show Running and Needs You prominently, alert at human gates, offer cancellation, and keep explicit execution authorization.          |
| Multi-Project concurrency exhausts a developer laptop.     | Keep inactive Projects inexpensive, show resource pressure, and return partial results when one Project is unavailable.               |
| Search exposes data beyond its intended scope.             | Search enabled registered Projects only, keep Agent tools Project-scoped, and keep Session Transcripts owner-only.                    |
| Session history becomes accidental shared memory.          | Keep transcripts owner-private and out of Agent retrieval; reusable knowledge goes into durable artifacts.                            |
| Workspace drifts into generic Agent management.            | Organize around the attention queue, Projects, Sessions, and Plan workflows; keep Running Quietly secondary.                          |

## Non-goals

- Public-internet exposure without a private network.
- Team accounts, roles, organization membership, and shared-machine concurrency in the personal Workspace.
- Ambient collaborator access to private Session Transcripts, or cross-Session Agent retrieval from them. Explicit
  owner-published [snapshots](#session-snapshot-sharing) are a separate undelivered capability.
- A generic Work Item, Task, ticket, Scrum, or issue-tracker layer.
- Database-only replacements for Markdown Plans, PRDs, ADRs, or Work Records.
- A browser IDE: editors, language servers, terminals, debugging, or extension management.
- Requiring Git, GitHub, pull requests, or Plan worktrees for every workflow.
- A raw WebTUI as the main Session experience.
- Blind workflow replay after a crash, or repeating unfinished work whose outcome is unknown.
- Separate hosted execution environments per Project.
- Identical token-by-token animation on every open screen; each screen updates as work is saved.
- Replacing Shared Plan capability links with Workspace device identity.

## Collaborative SaaS Workspace

**Status:** Coming soon. These requirements will move to a dedicated SaaS Workspace PRD. Nothing in this section is
delivered. The personal Workspace above stays the foundation; team features build on it without adding ceremony to
personal use. Hosted execution follows proven planning, workflow, isolation, and recovery.

Deferred from the self-hosted [Shared Plan collaboration](#shared-plan-collaboration) to SaaS:

- hosted Workspace deployment (Cloudflare D1);
- browser-side push, close, unshare, delete, and Plan body editing;
- automated collaboration notifications;
- [Forge Change Request Delivery](forge-change-request-delivery-prd.md) as an explicitly selected delivery and review
  mode, with RunWield-native review and Direct Delivery as the default.

### Team planning and governance

**Scope and maturity:** SaaS target.

**Requirement: Team-chosen roles and approval policy.** Team planned work uses a Plan-centered experience with
product-facing areas: Ideas, Planning, Review, Ready, In Progress, Verifying, Done, and On Hold. Raw Core statuses stay
visible in detail views. From the Plan screen, users start an idea, create or refine a PRD, create a Plan or an Epic,
review a Plan, and inspect Work Records and planning memory. Work Record search is secondary to the Plan workspace.

The team product adds independently hosted Projects, team and organization membership, Project-level authorization and
policy, and collaborator-visible artifacts. It starts with three roles: **Admin**, **Member**, and **Reviewer/Guest**.
Teams decide how strictly they divide planning, architecture, and execution; finer Member permissions can come later.

Default policy is lightweight:

- Members create and collaborate with minimal ceremony.
- Important Plans go through review.
- Work Records auto-approve after Recorder generation.
- Epics need explicit approval before decomposition or work.

Optional stricter settings restrict who approves Plans, require Work Record review before retrieval, require ADR links
for architectural Plans, and require explicit approval before a Plan enters Ready.

**Acceptance scenarios:**

- Given default policy, members shape a Plan together while important Plans and Epics receive their required review.
- When a team enables stricter approval or Work Record review, those choices govern the relevant transition or
  retrieval, and Core verification keeps its meaning.
- A user moves from an idea or PRD into a Plan or Epic and later finds the resulting Work Record.

### Team artifact privacy and authorship

**Scope and maturity:** SaaS target. Owner-private conversation is a product-wide principle.

**Requirement: Share durable artifacts and keep working transcripts private.**

- Plans, PRDs, ADRs, and Work Records are team-visible according to Workspace permissions.
- Working conversations are private by default, and chat messages stay with their Session.
- Code-review discussion, assignment, and approval state are collaboration process data held in Workspace; only durable
  results (Plans, Work Records, and commits) enter the repository.
- Artifacts record user and Agent authorship, shown as quiet metadata: author, drafting Agent, approval mode, and
  source references.
- Admin and debug Session access exists where policy allows.
- Product analytics are anonymized and aggregated unless users opt into broader sharing.

**Acceptance scenarios:**

- Given a collaborator permitted to read a Plan, its artifacts and authorship are visible and the author's working
  transcript stays private.
- When review discussion is saved, it stays in Workspace, and the repository receives durable results.

### Team planning intelligence

**Scope and maturity:** SaaS target.

**Requirement: Trusted planning knowledge across permitted Projects.** Shared cross-Project planning intelligence is
the main reason to pay for Workspace. It strengthens planning; RunWield is not hosted Agent management:

```text
A trusted planning system where every material change has a reviewable intent, governed execution, independently
verified outcome, and reusable record of what the team learned.
```

Workspace extends Core's repository records with:

- team-wide Work Record search;
- cross-Project retrieval for new Plans;
- context packs for Ideator, Planner, and Architect;
- compression and deduplication of older records;
- answers to "what did we decide before?" across Projects;
- filters by Project, area, Plan type, completion mode, and status.

**Acceptance scenarios:**

- Given current records across team Projects, a Planner's retrieved context keeps provenance, completion confidence,
  and Project scope.
- When older records are compressed or deduplicated, source Plans stay intact and current guidance stays distinct from
  history.

### Team code review and delivery

**Scope and maturity:** SaaS target. Personal review is owner-only.

**Requirement: Shared review responsibility and shared checks before merge.**

- Human review defaults to Workspace, with assignable reviewers and Agent assistance for reviewer and author.
- Teams can select forge-hosted or Dual Review per repository, team, or instance; each gate keeps its own decisions.
- Workspace merges validated, approved work after shared CI succeeds. Local checks are a fast tier ahead of shared CI.
  Publication uses a labeled Forge Change Request as the CI-and-merge envelope, with the actual author, reviewer, and
  merger identities.
- Approval counts, required checks, and self-merge policy have familiar forge meanings. GitHub sign-in and correct
  person attribution are high priority; identity, audit, and review responsibility stay explicit.
- Externally contributed work can become source material for a maintainer-owned Plan with contributor and maintainer
  provenance.

**Shared requirements:** [Core execution and validation](runwield-core-prd.md#execution-validation-and-recovery) and
[team planning and governance](#team-planning-and-governance).

**Acceptance scenarios:**

- Given validated work whose shared CI fails, Workspace holds the merge.
- When a teammate is assigned review, assistance, decisions, and merge attribution keep the author, reviewer, and
  merger identities.
- Given Dual Review, each gate keeps its own decision.
- Given an external contribution adopted by a maintainer, the Plan and delivery keep both identities.

### Proposed SaaS domain language

**Assignable Human Review**: Workspace-hosted code review assigned to a teammate, with Agent assistance for reviewer
and author. Discussion and approval state are Workspace process data; only durable results are committed. _Avoid_: pull
request, PR review, review sync

**Forge** (proposed redefinition): by default, the remote Git host and merge substrate; review and repository policy
are RunWield capabilities that a team can delegate to the Forge per repository. _Avoid_: system of record for intent,
review, or memory; required review gate

**Project Evidence Graph**: a rebuildable provenance projection that connects project intent, decisions, Plans,
delivery evidence, and outcomes, with source artifacts as project truth. _Avoid_: Plan Evidence Graph, Session
Transcript graph, source of truth

## References

- [RunWield Core PRD](runwield-core-prd.md)
- [ACP PRD](runwield-acp-protocol-prd.md) and [Connect PRD](runwield-connect-prd.md)
- [Forge Change Request Delivery PRD](forge-change-request-delivery-prd.md)
- [ADR-007: Local-First Workspace Plan Board](../adr/007-local-first-workspace-plan-board.md)
- [ADR-008: Remote-Canonical Collaborative Shared Spaces](../adr/008-remote-canonical-collaborative-shared-spaces.md)
- [ADR-010: SessionRuntime sibling adapters and ACP](../adr/010-session-runtime-sibling-adapters-and-acp.md)
- [ADR-015: File-Authoritative Session Bundles](../adr/015-file-authoritative-session-bundles.md)
- [RunWield Design System](../design-system.md)
