# Product Requirements Document (PRD): RunWield

**Document role: Living central PRD.** Product vision, guiding principles, and the relationship between Core, Workspace,
and Connect.

Keep this document as current product guidance. Fold lasting requirements from completed feature PRDs here;
implementation steps belong in Plans, architectural choices in ADRs, and delivery evidence in Work Records.

<a id="1-vision--strategy"></a>

## Vision & Strategy

**RunWield** is collaborative software planning with AI.

RunWield helps software teams figure out what to build, shape the work into reviewable Plans, execute approved work
through a local open-core harness, and preserve distilled records so future planning starts from what the team already
learned.

The product loop is:

```text
ideate -> plan -> execute -> record -> use records to plan better
```

RunWield should not be positioned as an agent management platform, issue tracker, ticket system, Scrum tool, or generic
AI chat product. Agents are implementation partners inside the planning loop, not the product category.

<a id="2-product-architecture"></a>

## Product Architecture

<a id="21-runwield-core"></a>

<a id="1-runwield-core"></a>

### RunWield Core

**RunWield Core** is the free local harness and runtime. It owns the canonical local workflow:

- local `wld` CLI
- interactive TUI
- local web UI clients
- Sessions across TUI, browser, and ACP-compatible external clients
- Router, Ideator, Planner, Architect, Slicer, Engineer, Operator, Reviewer, Tester, and Recorder agents
- local Plans, PRDs, ADRs, and Work Records as markdown artifacts
- local execution, validation, and recovery workflows

Core remains useful by itself. It should provide the full local loop for one project/repository without requiring the
hosted product.

The detailed Core product requirements live in [runwield-core-prd.md](runwield-core-prd.md). This root PRD summarizes
Core only enough to place it inside the broader RunWield product architecture.

<a id="22-runwield-workspace"></a>

<a id="2-runwield-workspace"></a>

### RunWield Workspace

**RunWield Workspace** is the browser environment for working across Projects. Personal Workspace first serves one owner
moving between the TUI and their phone: starting, continuing, and returning to the same conversation must be ordinary
and reliable. Team collaboration and SaaS extend that experience later.

Workspace focuses on:

- Plan-centered collaboration
- shared backlog and in-progress planning flow
- collaborative Plan review
- assignable human code review with Agent assistance, replacing forge pull-request review by default
- PRD, ADR, and Work Record visibility
- cross-project planning memory
- relevant retrieval for new planning work
- optional governance around approvals and records

Workspace should not initially lead with hosted execution. Hosted AFK `wld` agents may become a later capability for
executing ready Plans, but the first SaaS wedge is collaborative planning and records.

The detailed Workspace product requirements live in [runwield-workspace-prd.md](runwield-workspace-prd.md). That PRD
marries the local Plan management UI and encrypted collaborative planning directions into the self-hostable and hosted
Workspace story.

<a id="23-runwield-connect"></a>

<a id="3-runwield-connect"></a>

### RunWield Connect

**RunWield Connect** is the plugin ecosystem that brings RunWield planning, verification, recovery, Work Records, and
memory into external agent hosts such as Claude Code, Codex, OpenCode, and Pi. It begins with first-party plugins built
and compatibility-tested by RunWield.

The external host remains the user's interface and makes every model call. RunWield Core supplies the durable workflow
authority and local operations on demand. A user explicitly activates Connect for an individual request; installing a
Connect plugin must not alter ordinary host behavior.

Connect is a first-class way to use RunWield, not a deliberately weakened trial of Core or Workspace. Its detailed
requirements live in [runwield-connect-prd.md](runwield-connect-prd.md). That document retains **attached mode** and
**Attached Workflow** as internal architectural terms while using RunWield Connect as the public product name.

When RunWield Core owns the Session and invokes another harness non-interactively, such as Claude Code through
`claude -p` or Antigravity CLI, that harness is an **Execution Backend** alongside Pi. Execution Backends are Core
capabilities, not RunWield Connect plugins or separately branded product modes.

<a id="24-naming"></a>

<a id="4-naming"></a>

### Naming

- **RunWield**: public product and umbrella brand.
- **RunWield Core**: free local harness.
- **RunWield Connect**: plugins for using RunWield workflows inside external agent hosts.
- **RunWield Workspace**: personal browser workspace, with team collaboration and SaaS later.
- **`wld`**: CLI command.
- **Wield**: acceptable shorthand after context is established.

Avoid public phrasing such as "Wield AI" because it risks brand collision and points toward the wrong category.

<a id="3-core-philosophies"></a>

## Core Philosophies

- **Planning is the category:** RunWield should own AI-native/collaborative software planning, not agent management.
- **Plan-by-Default:** Material work starts with a Plan unless it is explicitly a bounded operation or quick fix.
- **Artifacts over traces:** Durable team knowledge lives in Plans, PRDs, ADRs, and Work Records, not raw chat logs.
- **Private working space:** In-between user/agent conversations are private-first. Artifacts persist; chat minutia does
  not become team memory by default.
- **Local-first core:** Core artifacts are repo-local markdown first. Workspace enhances collaboration and cross-project
  intelligence without making the local harness dependent on SaaS.
- **Distilled memory:** Future planning should use approved/final records and rationale, not noisy intermediate debate.
- **Flexible team roles:** PMs, tech leads, and developers can collaborate however their team works. RunWield should not
  prescribe job-description boundaries.
- **Lightweight defaults, optional strictness:** Flow should be easy by default, with stricter approval and governance
  policies available for teams that need them.

<a id="4-core-objects"></a>

## Core Objects

<a id="41-plan"></a>

<a id="1-plan"></a>

### Plan

The **Plan** is the central product object.

A Plan connects:

- product or technical intent
- the proposed approach
- review and approval state
- execution readiness
- validation outcome
- links to related PRDs, ADRs, and later Work Records through derived references

Plans are prospective: they describe what the team intends to do and how.

Plans remain markdown files with stable front matter in Core. Workspace can provide richer collaboration, but must not
erase the repo-local Plan model. Optional external Ticket links preserve user-identified demand provenance for
navigation; RunWield still does not make external trackers mandatory, fetch Ticket data, or synchronize Ticket lifecycle
state.

<a id="42-prd"></a>

<a id="2-prd"></a>

### PRD

PRDs capture user needs, product intent, scope, and capability-organized requirements with acceptance scenarios. Each
capability has one owning PRD; current, target, and deferred behavior stay distinct. They are first-class planning
inputs that RunWield agents can create or refine within the user’s document conventions.

<a id="43-adr"></a>

<a id="3-adr"></a>

### ADR

ADRs remain the authoritative artifact for architecture and technical decisions. Work Records and Plans may reference
ADRs, but should not become a parallel technical-decision authority.

<a id="44-work-record"></a>

<a id="4-work-record"></a>

### Work Record

Work Records are retrospective planning-memory artifacts: what completed work produced, why it matters, deferred scope,
and lessons worth retrieving. They link to source Plans and preserve the actual completion confidence. They do not
replace ADRs, raw conversations, or Git’s commit history. Detailed generation, backfill, retrieval, and external-record
scope belong to [Core Work records](runwield-core-prd.md#work-records).

## Capability Ownership

These five documents are this project's living PRDs. The product-family capabilities below own shared product promises;
each surface document owns its detailed behavior. A reference adds context, not another independently maintained copy.

| Owning PRD                                                     | Capability scope                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [RunWield](#capability-requirements)                           | Reviewed intent, consistent cross-surface outcomes, durable knowledge, public documentation, independent adoption and privacy             |
| [Core](runwield-core-prd.md#capability-requirements)           | Routing, Plan review/lifecycle, execution, validation, recovery, Sessions, context, records, customization, PRD authoring                 |
| [Workspace](runwield-workspace-prd.md#capability-requirements) | Local boards and sharing, attention, browser/phone journeys, Project access, knowledge/code search, pairing, later team governance/review |
| [Connect](runwield-connect-prd.md#capability-requirements)     | External-host opt-in, host model ownership, host compatibility, privacy, setup and recovery                                               |
| [ACP](runwield-acp-protocol-prd.md#capability-requirements)    | External-client Sessions, negotiated interactions, Telegram reference journey, recovery and protocol conformance                          |

When behavior changes, update the owning capability and its acceptance scenarios in the same implementation change.
Other PRDs and Plans link to that owner. Proposed additions, changes, and removals stay labeled until reconciled with
actual delivery; unmet intent is retained explicitly. Keep the five-document ownership rule in this project's
`AGENTS.md`; bundled guidance supports any user's PRD structure.

## Capability Requirements

- [Reviewed intent and proportional work](#reviewed-intent-and-proportional-work)
- [Consistent workflow outcomes across surfaces](#consistent-workflow-outcomes-across-surfaces)
- [Durable capability requirements and planning memory](#durable-capability-requirements-and-planning-memory)
- [Public documentation](#public-documentation)
- [Independent adoption and private working space](#independent-adoption-and-private-working-space)

### Reviewed intent and proportional work

**Scope and maturity:** Lasting product promise. Core’s capability sections distinguish the current baseline and
follow-up scope.

**Requirement: Review material intent before implementation.**

Users can clarify ideas, review intended changes while revision is cheap, and receive a level of planning appropriate to
the work. Inquiry and bounded operations stay lightweight; material planned work is reviewed before execution; large
projects become independently deliverable children. Work Kind preserves whether planned work is a bug, feature,
refactor, maintenance, or documentation.

Detailed owners: [Core request routing](runwield-core-prd.md#request-routing),
[Plan review](runwield-core-prd.md#plan-review), and
[Epic decomposition and hold](runwield-core-prd.md#epic-decomposition-and-hold). Workspace may also offer direct actions
into Ideator, Planner, or Architect when the user already knows the artifact they need.

**Acceptance scenarios:**

- Given a user exploring an idea, when they clarify product intent, the result can inform a capability-organized PRD and
  later a reviewed Plan without prematurely starting implementation.
- Given a small bounded fix versus a broad migration, when each is routed, the fix receives proportionate checks while
  the migration receives architecture and independently reviewed child work.

### Consistent workflow outcomes across surfaces

**Scope and maturity:** Lasting product promise; availability depends on the surface’s stated delivery scope.

**Requirement: Preserve approval and completion meaning across surfaces.**

Users receive the same meaning of approval, execution, validation, recovery, and completion through every supported
RunWield surface. Local Core remains useful without hosted Workspace. Personal Workspace supports the same owner moving
between screens. Connect preserves the external host’s conversation and model ownership. ACP exposes a RunWield-owned
Session through an external client. Core Execution Backends are another way to run turns inside Core, not Connect.

Detailed owners: [Core Session continuity](runwield-core-prd.md#session-continuity),
[Plan lifecycle](runwield-core-prd.md#plan-lifecycle), and
[execution, validation, and recovery](runwield-core-prd.md#execution-validation-and-recovery). Surface-specific
constraints and maturity belong in the ownership table below. Unsupported host or client behavior must be disclosed
without weakening shared completion claims.

A delivery workflow concludes only after confirmed publication or deliberate user abandonment. Internal failures are
intermediate conditions RunWield repairs automatically, hidden from the user. Waiting for a real user decision or
external prerequisite preserves the workflow. The detailed requirements and scenarios belong to Core execution and
recovery above.

**Acceptance scenarios:**

- Given an approved Plan saved for later on one screen, when the user opens another supported surface, it remains
  approved for later rather than starting implicitly.
- Given locally validated work whose target publication failed, when any surface shows its outcome, it reports the
  ongoing delivery and automatic recovery without claiming success or treating the failed attempt as a conclusion.
- Given a supported same-owner continuation, when the user changes screens, an idle open screen does not force a
  separate conversation or reserve the work.

### Durable capability requirements and planning memory

**Scope and maturity:** Lasting product promise; capability authoring guidance is agreed here, while richer team
retrieval remains later scope.

**Requirement: Keep requirements and reusable outcomes discoverable.**

Users can find what a capability must do in its owning PRD, why architecture was chosen in an ADR, what work is planned
in a Plan, and what completed work taught the team in a Work Record. Requirements stay organized by capability with
named observable outcomes and acceptance scenarios. Shared requirements have one owner and references; current, target,
and deferred behavior remain distinct. A Plan or record is not proof that an unmet target already works.

Project artifacts remain repository-owned Markdown and usable outside RunWield. They survive surface changes without
conversion to proprietary document-only storage. Work Records distill results and lessons rather than becoming raw
review logs or replacing Git’s commit history. Operational memory remains separate from these durable artifacts.

Detailed owners:
[Core capability-organized product requirements](runwield-core-prd.md#capability-organized-product-requirements),
[Work records](runwield-core-prd.md#work-records), and
[project context](runwield-core-prd.md#project-context-and-initialization). Workspace owns
[durable knowledge search](runwield-workspace-prd.md#durable-knowledge-search) and later
[team planning intelligence](runwield-workspace-prd.md#team-planning-intelligence).

**Acceptance scenarios:**

- Given a changed capability, when its implementation is delivered, its owning PRD and scenarios are reconciled in the
  same change and references remain useful without hunting through old Plans.
- Given an unimplemented proposal, when someone reads the living PRD, target scope stays distinguishable from current
  behavior.
- When a user plans related work later, relevant eligible records are available with their completion confidence,
  without treating raw transcript debate as settled requirements.

### Independent adoption and private working space

**Scope and maturity:** Lasting product promise; team roles and governance remain later Workspace scope.

**Requirement: Support independent use without exposing private conversations.**

Users can adopt Core, Workspace, or Connect for the value each provides. Core remains independently useful locally;
Connect is a supported destination rather than a deliberately weakened trial. Workspace earns adoption through browser
continuity, shared planning, review, and intelligence. Hosted execution follows those outcomes rather than leading the
product.

Working conversations remain private-first. Shared knowledge comes from deliberate artifacts and synthesized outcomes.
Teams choose responsibilities and optional stricter governance; RunWield does not impose job-title roles, external
trackers, or forge pull-request review as universal prerequisites.

Detailed owners: [Connect first-class use](runwield-connect-prd.md#first-class-connect-use),
[artifact privacy](runwield-connect-prd.md#artifact-privacy-and-records), and later Workspace
[team governance](runwield-workspace-prd.md#team-planning-and-governance),
[team privacy](runwield-workspace-prd.md#team-artifact-privacy-and-authorship), and
[team review and delivery](runwield-workspace-prd.md#team-code-review-and-delivery).

**Acceptance scenarios:**

- Given a developer who uses only local Core or stays in Connect, when they perform supported work, feasible
  capabilities are not withheld merely to force Workspace adoption.
- Given a shared artifact, when another permitted person reads it, they do not automatically receive the author’s
  private conversation.
- Given a team choosing forge-hosted or dual review, when it adopts that policy, each gate keeps its own decisions;
  RunWield-native review remains the default product direction.

### Public documentation

**Scope and maturity:** Target until `docs.runwield.dev` is deployed from the release-aligned documentation branch.

**Requirement: Find usable instructions.** Users can search and navigate a public manual for installing, using,
configuring, and troubleshooting RunWield. Internal PRDs, Plans, audits, research, and product proposals do not appear
as manual pages or search results.

**Requirement: Read documentation for the latest Stable release.** The public manual identifies and describes the latest
Stable release. Candidate and unreleased `main` behavior does not replace those instructions.

**Requirement: Correct documentation independently.** Maintainers can correct the current Stable manual without
publishing or changing a product release. Corrections remain present when the next Stable release updates the manual.

**Shared requirements:** [Core installation and updates](runwield-core-prd.md#installation-and-updates) owns truthful
package availability. [Core execution, validation, and recovery](runwield-core-prd.md#execution-validation-and-recovery)
remains authoritative for product delivery and recovery.

**Acceptance scenarios:**

- Given a new user, when they open the documentation home, they can reach installation, first-use, configuration, and
  troubleshooting guidance without navigating internal product records.
- Given a Candidate or an unreleased change on `main`, when it changes documentation, the public manual continues to
  identify and describe the latest Stable release.
- Given an error in Stable documentation, when a reviewed correction is published, the manual changes while the Stable
  product tag and assets remain unchanged; the correction is retained in the next Stable manual.
- Given a failed or stale documentation deployment, when publication stops or is retried, the last valid manual remains
  live and an older release cannot replace a newer one.

<a id="8-delivery-and-references"></a>

## Delivery and References

Core delivers the useful local planning-to-record loop. Personal Workspace makes that work usable from a browser and
phone. Connect brings the same workflow to supported external agent hosts. Collaborative SaaS follows with shared
planning, review, and records; hosted execution is later scope.

The linked Core, Workspace, and Connect PRDs define their release outcomes. Architecture is recorded in [ADRs](../adr/);
implementation work is tracked in [Plans](../plans/).

### Living Product Requirements

These five PRDs own current product intent: RunWield summarizes the product, Core owns shared local behavior, Workspace
owns browser and collaboration journeys, Connect owns external-host use, and ACP owns external-client compatibility and
chat-channel integration. Feature PRDs explore unfinished proposals. After delivery, fold lasting requirements and
meaningful unresolved scope into the appropriate living PRD, update references, and remove the completed feature PRD.
Git history preserves its earlier text; Work Records preserve delivery evidence. Completion does not make historical
implementation restrictions current product policy.

<a id="9-product-non-goals"></a>

## Product Non-Goals

- Do not frame RunWield as agent fleet management.
- Do not lead with hosted execution as the first SaaS wedge.
- Do not compete through issue-tracker, ticket, Scrum, or Agile vocabulary.
- Do not persist raw chat traces as team planning memory by default.
- Do not make Git, GitHub, pull requests, or any external tracker mandatory artifact schema concepts.
- Do not make RunWield Workspace dependent on job-title-specific roles.
- Do not treat forge pull requests as the default human review loop; forge-hosted review is an opt-in per repository or
  team.
- Do not treat Work Records as the audit history of the target branch; the git log owns commit-level history.

<a id="10-success-metrics"></a>

## Success Metrics

Core metrics:

- speed to first useful Plan
- percentage of planned work reaching verification
- percentage of verified planned work producing Work Records
- quality of recovered context when resuming Plans
- reduction in repeated planning questions caused by missing history

Workspace metrics:

- successful Session start and TUI → phone → TUI continuation with both screens left open
- user effort required to resume work remotely

- Plan review cycle time
- number of active teams using Plans as the main planning object
- percentage of new Plans using retrieved Work Records, PRDs, or ADRs
- cross-project retrieval usefulness as rated by users
- Work Record edit/override rate after Recorder generation
- team retention driven by planning memory and collaboration value

[Mnemoteca]: https://github.com/gandazgul/mnemoteca
