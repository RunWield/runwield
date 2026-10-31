---
planId: "836cfa2e-3c96-46f8-bae2-9bb4633d2c49"
classification: "PROJECT"
complexity: "HIGH"
summary: "Add an owner-triggered publication workflow that takes a verified Epic branch to the primary branch through a temporary worktree, an integration merge, re-run integrated validation, a compare-and-swap update, and durable Delivery Evidence."
affectedPaths:
    - "docs/plans/"
    - "src/shared/worktree.js"
    - "src/shared/worktree-registry.js"
    - "src/shared/workflow/"
    - "src/shared/epic-artifacts.ts"
    - "src/plan-store.js"
    - "src/plan-front-matter.js"
    - "src/cmd/plans/"
    - "src/tools/"
    - "src/ui/tui/"
    - "src/ui/workspace/"
    - "docs/plan-lifecycle.md"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-08-17T12:00:18-04:00"
status: "draft"
---

# Epic Branch Publication Workflow

## Context

The earlier package and frontend Plans were removed on 2026-10-26. The
[Plan Store PRD](../prd/plan-store-prd.md) owns the Plan storage direction.

This proposal assumes the Epic branch is proven and ready to merge at `verified`. The merge stays a manual `git`
operation by the owner. This works, but it leaves the last step of the release outside RunWield:

- The proof is against the Epic branch alone. An Epic branch can live for weeks while the primary branch moves, and the
  one thing most likely to break the release — other work landing underneath it — is never checked.
- There is no Delivery Evidence at the level that now matters. Every child records how it reached the Epic branch;
  nothing records how the Epic reached the primary branch.
- Conflict resolution during that merge has no owner, no bounded context, and no return path. It happens in the primary
  checkout, which is the one place uncommitted work is least safe.

RunWield already solved this problem one level down. Child publication synthesizes the merge in an isolated worktree,
validates the result, updates the target reference with a compare-and-swap, and retries against the newer head when the
target moves. This PROJECT lifts that pattern to the Epic and puts an owner decision in front of it, because merging an
Epic is a release and releases are scheduled by people.

Before this PROJECT begins, re-audit the current Epic branch, Epic `implemented`, and integrated-validation authorities.
The earlier prerequisite and sibling Plans were removed on 2026-10-26; use the Plan Store PRD for Plan storage direction.

## Objective

Add one owner-triggered publication workflow that moves a verified Epic from `verified` to a new terminal `published`
state:

- publication never starts on its own. The owner triggers it from a command and from the Plan Board, and the Epic stays
  at `verified` for as long as the owner wants;
- publication runs in a temporary worktree created from the Epic branch. The Epic still owns no durable worktree, and
  the primary checkout is never used as the merge surface;
- publication merges current primary-branch content into that worktree first, so the thing that gets validated is the
  thing that will ship;
- a genuine content conflict dispatches Engineer inside the publication worktree with bounded context: the Epic
  contract, the conflicting content, and nothing else. RunWield keeps every piece of lifecycle bookkeeping to itself;
- integrated validation runs again on the merge result. A pass is required, and the earlier `verified` result does not
  carry over;
- the primary branch reference is updated with a compare-and-swap. If the primary branch moved during publication, the
  attempt re-merges against the newer head and re-validates instead of forcing the update;
- success records Epic Delivery Evidence, sets `published`, and cleans up the temporary worktree; any other outcome
  preserves the Epic branch, the Epic status, and a durable recovery record with plain-English owner actions;
- an interrupted or process-lost publication is resumable and never leaves a half-updated primary branch; and
- publication is available to Epics only in this PROJECT. FEATURE Plans keep their existing child publication path
  unchanged.

The option set aside is publishing automatically when integrated validation passes. The owner asked for the opposite,
and the reason holds: an Epic branch is the kind of change that needs release planning, coordination with other work,
and a deliberate moment. Automatic publication would also make a passing validation run irreversible without anyone
choosing it.

## Vertical Slice Findings

Today publication is a child-level concept. `src/shared/worktree.js` owns worktree creation, merge synthesis, and the
target reference update; `src/shared/workflow/validation-merge-repair.ts` owns conflict continuation; and
`src/shared/workflow/validation-delivery-hierarchy.ts` owns Delivery Evidence. All of it is reached from the validation
loop of an executing Plan, and an Epic never executes.

The target boundary is a separate owner-triggered workflow that reuses those mechanics without entering the validation
loop:

```text
Epic verified                       branch is proven, owner decides when
  |
  | owner triggers publication
  v
temporary worktree from Epic branch      Epic still owns no durable worktree
  |
  v
merge current primary branch in
  |
  +-- content conflict --> Engineer, bounded context, in this worktree
  |
  v
integrated validation on the merge result     the same Epic validation.md
  |
  +-- fail --> stop, preserve everything, report
  |
  v
compare-and-swap the primary branch
  |
  +-- lost the race --> re-merge against the newer head, validate again
  |
  v
published        Delivery Evidence recorded, temporary worktree removed
```

`published` is a new terminal status. `verified` cannot absorb it: the two states differ in what is true of the primary
branch, and the owner needs to see the difference on the board. The existing terminal set (`verified`, `user_verified`,
`closed_without_verification`) has no member that means "merged and proven against what shipped".

Three existing invariants constrain the design and are not open for renegotiation:

- Primary-branch movement during publication is normal. It is not a conflict and it does not make the Epic stale. Only
  real content conflicts are conflicts.
- The validated Epic branch stays immutable. The merge result is synthesized in the temporary worktree; the Epic branch
  is not rewritten to make the merge easier.
- Lifecycle bookkeeping is RunWield's, not an Agent's. Engineer resolves conflicting source content. Status, evidence,
  registry entries, worktree metadata, and publication attempts are written mechanically.

## Files to Modify

- `src/shared/worktree.js` and `src/shared/worktree-registry.js` — generalize publication worktree synthesis,
  compare-and-swap target update, retry-on-moved-head, and registry lifecycle so an Epic can use them outside the
  validation loop.
- `src/shared/workflow/` — add the publication workflow, its resumable stages, bounded conflict repair dispatch,
  integrated re-validation, and Delivery Evidence at Epic level.
- `src/shared/epic-artifacts.ts` — record the publication result beside the Epic's other artifacts.
- `src/plan-store.js` and `src/plan-front-matter.js` — add the `published` status, its transition, publication-attempt
  metadata, and Epic Delivery Evidence fields.
- `src/cmd/plans/` — the owner-facing publication command, its confirmation, and its resume path.
- `src/tools/` — a typed publication-conflict completion boundary for the bounded repair role, separate from
  implementation and validation completion.
- `src/ui/tui/` and `src/ui/workspace/` — offer publication on a verified Epic, show publication progress and stage, and
  present a failed or interrupted attempt with concrete owner actions.
- `docs/plan-lifecycle.md`, `docs/domain-language.md`, and `docs/prd/runwield-core-prd.md` — define `published`, the
  publication workflow, and its owner-facing behavior.

## Reuse Opportunities

- Existing child publication machinery: isolated merge synthesis, compare-and-swap reference update, retry against a
  moved head, and `merge_conflict` classification that excludes ordinary target movement.
- Existing worktree registry, transition journal, Plan locks, and durable recovery records for transactional lifecycle
  mutations that span Git and Plan metadata.
- Existing bounded repair segment pattern, which already gives a repair Engineer a fresh persisted segment under a
  stable Session with a frozen contract and no inherited planning history.
- Existing Delivery Evidence structures and validation-delivery hierarchy.
- Re-audit integrated validation against the current implementation. The earlier package Plans were removed on
  2026-10-26; the Plan Store PRD owns Plan storage direction.
- Existing Plan Board and TUI action surfaces for owner-triggered Plan operations.

## Verification Plan

- Trigger children must prove publication is offered only for a `verified` Epic, never starts without an owner action,
  and is not offered for FEATURE Plans or for Epics in any other status.
- Isolation children must prove publication creates and uses a temporary worktree, never operates in the primary
  checkout, and leaves the Epic without a durable worktree in every outcome.
- Integration children must prove current primary-branch content is merged into the publication worktree before
  validation runs, and that validation runs against the merge result rather than the Epic branch alone.
- Conflict children must prove a real content conflict dispatches Engineer with bounded context inside the publication
  worktree, that no Agent writes Plan status, evidence, registry, or worktree metadata, and that resolution returns
  through integrated validation before any reference update.
- Concurrency children must prove that primary-branch movement during publication is not treated as a conflict or as
  stale evidence, that a lost compare-and-swap re-merges and re-validates against the newer head, and that the Epic
  branch content is never rewritten.
- Failure children must prove a failed validation, refused merge, or aborted attempt preserves the Epic branch, Epic
  status, and children, and writes a durable recovery record with plain-English owner actions.
- Resumability children must prove an interrupted or process-lost publication resumes from its recorded stage and can
  never leave the primary branch partly updated.
- Terminal-state children must prove `published` sets Epic Delivery Evidence, is reachable only through this workflow,
  and cannot be produced by board movement or attestation.
- Automated suites must run through `scripts/run-tests.js`, `deno task seams:check`, and `deno task ci`; Git behavior
  must be proven against real repositories through `defineGitFixture` rather than injected seams.

### Outcome Evidence

- **Publication is an owner decision** — a verified Epic waits indefinitely; nothing publishes it automatically; the
  owner triggers it from the command line and from the Plan Board and confirms before anything moves.
- **What ships is what was proven** — integrated validation runs on the Epic branch merged with current primary-branch
  content, and a passing run against the Epic branch alone is not accepted as publication proof.
- **Publication never touches the primary checkout** — the merge, the conflict work, and the validation run all happen
  in a temporary worktree that is removed on success and preserved for inspection on failure.
- **Conflicts have a bounded owner** — Engineer resolves conflicting source content with the Epic contract and the
  conflict in front of it, and no Agent edits lifecycle metadata at any point.
- **Moving targets are normal** — primary-branch movement during publication produces a re-merge and a fresh validation
  run, not a conflict, not stale evidence, and never a forced reference update.
- **Every outcome is recoverable** — success records Delivery Evidence and sets `published`; every other outcome leaves
  the Epic branch, its children, and its status intact plus a durable record naming what the owner can do next.
- **`published` means merged and proven** — the status is reachable only through this workflow, carries Delivery
  Evidence, and cannot be reached by board movement, attestation, or manual closure.
- **Existing behavior remains protected** — FEATURE child publication, worktree recovery, Plan Recovery, archive and
  restore, collaboration, Epic validation, and done-enough Epics continue to work unchanged.
- **Behavior expected to stop existing** — merging a finished Epic is no longer an untracked manual `git` operation, and
  no Epic reaches the primary branch without a validation run against current primary-branch content.

## Edge Cases & Considerations

- A done-enough Epic carries accepted gaps. Publishing it is legitimate, and the recorded evidence must show which
  contracted outcomes were never built so `published` is not read as complete coverage.
- Publication and child execution can overlap if a child is still running against the Epic branch. The workflow needs
  one rule for this — most likely it refuses to start — and refusing has to explain which child is holding it.
- Integrated re-validation after the integration merge may be slow. The owner needs progress and a way to stop, and
  stopping must be a clean abort rather than a partial publication.
- The primary branch may be protected, may require a pull request, or may not exist locally in the expected state. The
  workflow needs a defined behavior for a target it cannot update directly, and a pull-request path may be the honest
  answer for some repositories.
- A conflict repair changes content that no child ever validated. That content is covered by the integrated run, but it
  never passes semantic review, and the Plan should state whether that is acceptable or whether an Epic-level review
  step is required before the reference update.
- Publishing an Epic whose branch is already an ancestor of the primary branch, or is empty relative to it, should be a
  clear no-op with a clear message rather than an error.
- Nested Epics, if the foundation PROJECT allows them, need a defined publication order. The simplest answer is that a
  child Epic publishes into its parent's branch by the same rules.
- `published` joins a terminal set that archive, restore, board movement, and reporting all read. Every surface that
  enumerates terminal statuses has to learn it in the same change.
