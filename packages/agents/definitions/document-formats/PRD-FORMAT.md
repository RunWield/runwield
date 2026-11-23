# PRD Format

Read this guidance before writing or revising a PRD, or deriving an Epic or Plan from one. Follow the user's project
document locations and conventions; use `docs/prd/<feature-name>.md` when none exist. Preserve the user's decisions and
existing substantive content when revising a document.

Use the structure below as the default. Scale the detail to the product question; headings are a guide to a coherent
proposal, not a reason to invent content. Existing PRDs may organize the same information differently. Do not copy an
old PRD's implementation-heavy sections merely because they already exist.

## Document Roles and Lifecycle

Discover which PRDs the project treats as lasting product guidance and which are feature proposals. A small project may
have one PRD; a larger product may have several owners.

Living PRDs own lasting product principles and capability requirements. Feature proposals describe a desired change and
link to the affected capability in its owning PRD. Keep each requirement authoritative in one place; other documents
link to it and describe only their own additional behavior. If no owner exists, use the project's existing convention or
propose the smallest useful home rather than creating a parallel spec system.

After implementation, reconcile changed capability requirements and scenarios with the delivered behavior and accepted
product decisions. Preserve unresolved requirements as target or deferred scope, with remaining work in Plans. Follow
the project's policy for retaining, consolidating, archiving, or removing completed proposals. Never delete unique
requirements or imply something shipped merely because a Plan or proposal exists.

## Capability Requirements

Organize requirements inside the PRD by **capability**: a coherent behavior users or downstream systems rely on, such as
signing in, reviewing work, or exporting data. Use recognizable product terms, not internal modules or a list of agents.
Keep the problem, audience, value, and scope around these requirements; a scenario catalog alone is not a PRD.

Each capability needs:

- **A stable heading or key** that Plans and other PRDs can link to. Reuse the existing name; preserve or update links
  when renaming. Requirement IDs are optional unless the project already uses them.
- **Scope and maturity:** distinguish current supported behavior, agreed target behavior, and deferred or unresolved
  proposals. Label a mixed capability's individual requirements where needed. A requirement is a product commitment, not
  proof of implementation or a new Plan lifecycle status.
- **Named, observable requirements:** what the user can do, what result they receive, and relevant constraints. Use
  plain language; MUST/SHOULD notation is optional. Keep library choices, storage schemas, internal locks, algorithms,
  and implementation steps in ADRs and Plans unless they are explicit user-facing commitments.
- **Representative acceptance scenarios:** a starting condition, action or event, and observable result. Cover the
  normal journey and consequential boundaries such as refusal, cancellation, missing access, or recovery when relevant.
  Scenarios specify behavior; they are not automatically executable tests. Do not invent edge cases or guarantees to
  fill a template. Detailed test cases and commands belong in Plans.
- **Links to shared requirements** instead of copies. Cross-capability journeys may reference several owners and state
  the additional outcome at their intersection.

For a change, identify the requirements being added, changed, or removed and the existing behavior that must survive.
Use prose or a short change list in the proposal; no separate delta-spec files or mandatory new tooling. Do not rewrite
current behavior as already delivered while planning. As part of planned change plans, update the owning capability and
its scenarios at the same time as the code, retain unmet product intent explicitly, and fix affected references. A
workaround or passing test does not silently redefine the owner's intended product.

Ideator shapes capability outcomes and scenarios with the user. Planner links affected capabilities from the Plan, turns
their scenarios into discriminating verification, and includes required PRD updates in implementation scope. Architect
preserves those outcomes across the Epic and identifies which child work must fulfill and update them. None should
require the user to rewrite unrelated PRDs before a bounded change can proceed.

## Template

```md
# <Product or Feature Title>

## Background

One paragraph: what this is, the initial context, the key problem, and why we want to address it.

## Problem Description

Explain how users are underserved today, the pains observed, and the evidence behind them. State the goals and
non-goals. For internal work, explain the operational problem; for a business initiative, identify the acquisition,
activation, retention, revenue, cost, or other product goal. Distinguish observed facts from assumptions.

## Why Are We Building It?

Describe the outcomes this enables: user journeys unlocked, value to the user, contribution to business goals, and the
improvements we expect. Explain why the work matters now. Connect each major feature to an outcome rather than listing
features as their own justification.

## Audience

Name the intended users and their relevant situations, needs, and constraints. Distinguish the primary audience from
secondary beneficiaries or buyers when that matters. State who the initial version is for and who is outside its scope.

## Product Fit, Prototypes, and Descriptions

Describe where this fits in the existing product, how users discover it, and the main journey before and after the
change. Use user stories or concrete scenarios to explain the expected behavior and important experience choices.

Link available prototypes, wireframes, screenshots, design-system references, or examples from other products. Explain
what each reference demonstrates and which parts apply. Label inspiration and proposed designs separately from existing
product behavior. If visual references are not available, describe the experience clearly; do not invent links or make
producing a prototype an automatic prerequisite.

## Capability Requirements

### <Stable capability name>

**Scope and maturity:** Current, target, or deferred; identify mixed scope explicitly.

**Requirement: <Observable behavior>.** State the outcome and relevant product constraints.

**Acceptance scenarios:**

- Given <starting condition>, when <action or event>, then <observable result>.
- Given <consequential boundary>, when <action or event>, then <expected refusal, preservation, or recovery>.

**Shared requirements:** Link the owning capability for behavior this capability depends on; omit if unnecessary.

Repeat for the capabilities affected by this PRD. Keep proposed additions, changes, and removals distinguishable from
current behavior. A short PRD may have only one capability.

## Success Metrics

Explain what success looks like and how we will measure it. Choose a small set of outcome measures relevant to the
problem, such as successful journey completion, time to first value, adoption, retention, or reduced support effort. For
each, state the baseline and target when known, the evidence or measurement method, and the observation period when
agreed. Mark unknowns as open rather than inventing numbers or requiring a new analytics system.

Link the capability acceptance scenarios rather than copying them here. Scenarios show whether the required behavior is
present; outcome measures show whether it helped. Add a cross-capability acceptance journey only when it proves
something the individual scenarios do not.

## Delivery

Define the smallest useful release or MVP and how users will receive it. Describe meaningful milestones, any staged
rollout or pilot, and the dependencies that affect shipping. State what ships first and what is deliberately deferred.

Link the implementing Plan for a bounded change or the Epic for work requiring several coordinated Plans when those
artifacts exist. Otherwise identify the expected planning handoff without creating an Epic, dates, or implementation
commitments merely to fill this section. Milestones describe usable outcomes, not modules, database migrations, or task
checklists.

## Attached Research and Other Evidence

Link or attach the research and evidence supporting the proposal: user interviews, observed pain points, usage data,
support requests, experiments, competitive research, or other relevant material. Summarize what each source supports and
any limits or uncertainty. Distinguish direct observations from hypotheses and references used only for inspiration.

## Risks and Mitigations

Brainstorm what could go wrong with the team and relevant partner teams. Consider risks to the user experience,
adoption, business outcomes, delivery, and dependencies. For each material risk, describe its likely impact and an
appropriate mitigation; identify the responsible person or team when agreed. Keep mitigations proportionate to the risk,
and distinguish input actually received from assumptions still needing discussion.

## Open Questions

Collect unresolved questions while the spec is in progress. Note what decision or evidence would resolve each one, who
can help when known, and whether it affects scope, delivery, or how success will be judged. As answers arrive,
incorporate them into the relevant section and remove the resolved question. Do not let this become a permanent
discussion log.
```

## Supporting Material

Add other sections only when needed to understand the proposal, such as sourced product constraints or proposed domain
language. Keep proposed terminology distinct from the implemented glossary. Link architectural decisions for rationale
and constraints; link Plans for implementation details and remaining work. Do not turn supporting material into a second
implementation specification.

## Product Requirements

A PRD defines what users need, why it matters, and how success will be judged. It is not an implementation design. Apply
this distinction when reading, writing, or turning a PRD into an Epic or Plan.

- Start with the problem, intended users, business goal, and expected value.
- Describe the user's journey and stories: "As a [user], I can [action], so that [benefit]." Plain scenarios are equally
  useful; do not force every requirement into a template.
- State observable outcomes, scope, exclusions, and acceptance scenarios. Use agreed success measures; do not invent
  latency targets, delivery guarantees, or additional product obligations to make a document look complete.
- Include technical constraints only when they are explicit product commitments or necessary external constraints.
  Explain their user impact and source. Put internal architecture in an ADR or technical design, and implementation
  steps in the Plan. Link to those documents instead of copying their machinery into the PRD.
- Locks, database schemas, transaction phases, internal APIs, file layouts, and recovery algorithms are implementation
  choices. They are not user stories or success measures. For example, "I can continue on my phone while my idle TUI
  stays open, and see the reply when I return" is a product requirement; "acquire a fenced activation lease" is not.
- Separate current capability, known implementation gaps, and desired behavior. A temporary rollout restriction, old
  test, archived Plan, Work Record, or retrieved memory does not turn an implementation limitation into product intent.
  Check current source and architectural guidance, then apply the user's current decision.
- Architect and Planner preserve the PRD's scope when designing the solution. A best-effort notification does not imply
  a persistent acknowledgement system; one user changing screens does not imply simultaneous multi-user collaboration.
  Reuse existing Core behavior before proposing another state model or coordination layer.
- Keep the PRD concise enough for the owner to review. Before finalizing it, check that each requirement explains a user
  need, an observable outcome, or a sourced product constraint. Move implementation detail to the appropriate document.

## Ideator Completion

These steps apply when Ideator writes or revises a PRD at the user's request, after the interview has resolved the major
product decisions. They do not change Planner or Architect workflows.

1. **Choose the document.** Follow the project's document conventions; use `docs/prd/<feature-name>.md` when none exist.
   Prefer an existing owner for lasting capability guidance. Describe proposed additions, changes, and removals there or
   in a linked proposal without claiming delivery. Keep synthesis tied to the user's request.
2. **Write and check the PRD.** Follow the structure and product requirements above. Keep proposed terms separate from
   the current glossary in a `Proposed Domain Language` section. Include their definitions, avoided aliases, affected
   existing terms, and stable relationships. Use local time, not UTC, for dates and timestamps.
3. **Register the document.** Immediately after writing it, call `artifact_written` with its Project-relative path and
   kind `prd` so the RunWield Session can show it in every surface.
4. **Preserve the conclusion.** Use `memory` with `action: "store"` to save one consolidated memory containing the
   crystallized direction and a pointer to the artifact, not a duplicate of its contents.
5. **Hand off to planning.** Direct the user to `/agent planner` to turn the PRD into an executable Plan. Do not write
   the Plan as Ideator.
