For local and manual-SSH authoring, submit the Markdown body below as `plan_written.contextMarkdown`, without YAML.
Use `planType: epic`, `targetBranch`, and typed `definition` facts including summary, complexity, affectedPaths and Tickets. Core supplies classification and lifecycle fields.
Core assigns identity and creation time. Never write `plan.wld.json`. Managed-remote workflows retain their existing
admitted metadata contract until their separate storage migration.

# <Plan Title>

## Context

What problem/request this plan addresses and the intended outcome.

When PRDs inform the Epic, link their owning capability headings and distinguish existing behavior from proposed
additions, changes, and removals. Preserve user outcomes across capability and eventual child-Plan boundaries.

## Objective

Clear statement of what changes and why. Reference any ADRs created. Name the main option you did not take and what it
would have cost.

For consequential choices, explain the commitments, what changing direction involves, and the evidence supporting the
chosen approach. State how material uncertainties will be resolved, why any added flexibility is useful, and what would
justify reconsidering the decision. Scale this detail to the choice's consequences and link applicable ADRs.

## Vertical Slice Findings

Brief summary of what you traced deeply and how it informs the plan. Show the paths you walked — a call path, a small
`mermaid` flow or state diagram, a shallow file tree of what owns what, a diff of a boundary that moves — wherever that
reads faster than prose.

## Expected Change Surface

The boundaries this Epic is expected to touch. This list is guidance, not an allowlist: each child Plan verifies the
real footprint during implementation and changes whatever its Implementation Steps need. Discovery that changes approved
intent — another subsystem joins the Epic, public behavior or architecture shifts, migration risk grows — comes back to
the user, not to the file list.

- `path/to/file` — what changes here and why
- `path/to/another-file` — what changes here and why

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `path/to/existing/module.ts` — what to reuse
- `path/to/utility.ts` — what to reuse

## Verification Plan

- Automated: exact command(s) to run
- Manual: precise user flows / checks
- Expected results for key scenarios

### Outcome Evidence

An Epic is not executed directly, so it does not carry runnable checks of its own. What it owes its children is the
thing only the Epic knows: **what must be observably true when this architecture is real.**

For each Epic outcome, state the evidence that proves it — concrete enough that a child Plan can turn it into a command
that is red before the work and green after. "The migration is complete" is not evidence; "no module outside `storage/`
constructs a database handle" is. Outcomes stay exact prose; a diagram earlier in the Epic does not stand in for one.

- `<Outcome>` — observable evidence a child Plan can assert against.

Connect outcomes to the relevant PRD acceptance scenarios. Identify which eventual child outcomes must update the owning
capability requirements and references when delivered, including cross-child journeys that no single child proves. Leave
decomposition to Slicer; do not mark target capabilities delivered while writing the Epic.

Also state, across the whole Epic:

- which existing behavior must still be protected when every child has landed;
- which behavior is expected to stop existing.

Only the Epic knows that difference. Left unsaid, a child deletes a test that no longer compiles and the suite still
passes.

## Edge Cases & Considerations

- Risk 1 + mitigation
- Compatibility or migration concerns
- Open assumptions (if any)
