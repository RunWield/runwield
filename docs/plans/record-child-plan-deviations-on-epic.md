---
planId: "e4419e07-9327-4305-91b3-7570aadffa90"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/workflow/epic-review-context.ts"
    - "src/tools/plan-deviation.ts"
    - "src/shared/workflow/validation-publication.ts"
    - "src/shared/workflow/validation-semantic.ts"
    - "src/shared/workflow/epic-integration.ts"
    - "src/agent-definitions/subagent-definitions/integration-reviewer-prompt.md"
    - "src/shared/plan-deviations.ts"
    - "src/tools/__tests__/plan-deviation.test.ts"
    - "src/shared/workflow/epic-review-context.test.ts"
    - "src/shared/workflow/epic-integration.test.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
    - "docs/plan-lifecycle.md"
    - "src/skills/runwield/PLANS.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-24T21:57:31-04:00"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
sessionName: "Epic Deviation Recording"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "d8f2c19c7de5f5c09a2d2362534e7432b6e97289"
workRecord:
    status: "generated"
    recordId: "4da4c2b4-fec3-427a-80f8-deb6ec142bbf"
    path: "docs/work-records/2026-10-26-child-plan-deviations-in-epic-integration-context.md"
    lastAttemptAt: "2026-10-26T01:57:45.766Z"
status: "verified"
---

# Record Child Plan Deviations on the Epic

## Context

A confirmed Plan Deviation in a child Plan is recorded only on that child Plan. The Epic document never shows it.

Today the deviation reaches these surfaces:

| Surface                               | Sees child deviations? | Why                                                                                          |
| ------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| Child execution and child AI review   | Yes                    | `projectEngineerPlanBody` and the review request render the child's `planDeviations`.        |
| Epic Work Record                      | Yes                    | `aggregatePlanDeviations` in `src/shared/work-records/generation.js` collects child entries. |
| Epic document                         | **No**                 | Nothing writes to it.                                                                        |
| Integration review (Integration Gate) | **No**                 | `buildIntegrationReviewRequest` embeds only the Epic markdown and the files of each child.   |

The result: a user approves a scope change in child 2, and then the Integration Reviewer can report the dropped Epic
outcome as a missing feature. A person reading the Epic also cannot see that scope changed.

The same investigation found a related bug. `recordIntegrationNotes` writes notes to the Epic document in the
**primary checkout**. Nothing commits that copy to the Epic branch. The Integration Gate now reads the Epic document
from the exact Epic branch head (`runEpicIntegrationGate` loads `reviewEpic` from the gate checkout). So the notes never
reach the integration review. That breaks the Core PRD scenario "Given a child review with Integration Notes, the notes
appear in the Epic's subsection and reach the integration review."

> [!NOTE]
> **This Plan builds on the branch-head Epic read**
>
> The gate change that loads the Epic from the checked branch head (`reviewEpic` in `runEpicIntegrationGate`) is in
> the current checkout but not committed yet. This Plan depends on that behavior and must keep it.

Owning PRD capabilities in `docs/prd/runwield-core-prd.md`:

- [Plan deviations](../prd/runwield-core-prd.md#plan-deviations): **add** a requirement that a child's confirmed
  deviations are recorded on its Epic, with acceptance scenarios. The existing requirements stay: explicit
  confirmation, precedence in execution, AI review, and Work Records, idempotent retry, and no change on cancel or a
  stale revision.
- [Epic decomposition and hold](../prd/runwield-core-prd.md#epic-decomposition-and-hold): **change** the Integration
  Notes sentence so the notes travel with the child's delivery to the Epic branch. **Add** to the Integration Gate
  requirement that the integration review treats child deviations as user-approved. The existing scenario "notes …
  reach the integration review" must become true again.

### Decisions from the conversation

- **Storage:** the Epic document gets a RunWield-managed `### Child Plan Deviations` subsection. Each child has one
  marker block. RunWield writes the block in the child's execution checkout, so it lands on the Epic branch with the
  child's delivery.
- **Authority:** the integration review treats a confirmed child deviation as user-approved. A gap that only the
  deviation causes is not a finding. The reviewer names each affected Epic outcome in an advisory.
- **Integration Notes fix:** included. Notes use the same write path: the child's execution checkout, not the primary
  checkout.

## Objective

When a child of an Epic records a confirmed Plan Deviation, the Epic document on the Epic branch lists it under
`### Child Plan Deviations`. The Integration Reviewer receives that section and applies the user's approval: a gap
caused only by a confirmed child deviation is not a finding, and the reviewer reports the affected Epic outcome as an
advisory.

Integration Notes from a child's AI review reach the Epic branch the same way and appear in the integration review
request.

The child Plan's `planDeviations` stays the only authority. The Epic section is a projection of it. The Epic's own
`planDeviations` front matter and the Epic Work Record do not change.

## Approach

### One owner for the Epic's managed child blocks

`epic-review-context.ts` already owns "what a child's review needs from its Epic, and where its notes go." Its
`withIntegrationNotes` contains the marker-block logic: find the child's block and replace it, else insert it under a
managed heading, else create the heading in a named parent section. Generalize that logic into one private helper and
use it for both managed subsections. Two copies of the marker rules would be information leakage.

```text
withChildBlock(markdown, section, childPlanName, lines)
  section = { heading, parentHeading, intro, markerKind }
  if the child's start/end markers exist → replace that block
  else if `heading` exists → append the block at the end of that subsection
  else → create `heading` + intro at the end of `parentHeading`, or at the end of the document
  lines is empty → remove the child's block, keep the heading
```

| Managed subsection          | Parent section         | Marker kind             |
| --------------------------- | ---------------------- | ----------------------- |
| `### Integration Notes`     | `## Verification Plan` | `integration-notes`     |
| `### Child Plan Deviations` | `## Objective`         | `child-plan-deviations` |

The deviation section sits under `## Objective` because it changes what the Epic promises, and the Integration Reviewer
reads the Objective first.

### One sync function, called at record time and before each seal

The Epic block is a projection of the child Plan. A single function rebuilds it from the child's `planDeviations`:

```ts
/** Make the child's block in the Epic document in `checkoutRoot` match the child's confirmed deviations. */
export async function syncEpicChildPlanDeviations(checkoutRoot: string, childPlanName: string): Promise<string | null>;
```

```text
syncEpicChildPlanDeviations(checkoutRoot, child)
  load child Plan from checkoutRoot
  parent = child.attrs.parentPlan; stop if none
  load parent from checkoutRoot; stop if missing, not PROJECT, or type: sequence
  next = withChildBlock(parent.markdown, CHILD_DEVIATIONS, child, render(child.planDeviations))
  if next == parent.markdown → return null
  writePlanMarkdownWithRevisionLocked(checkoutRoot, parent, …, parent.revision)
  SharedPlanLockError → return null (the child record stays authoritative)
  return "docs/plans/<epic>.md"
```

Two callers keep the projection true:

```diff
 record_plan_deviation.execute
   … user confirms …
   savePlan(executionCwd, child, { planDeviations })
+  syncEpicChildPlanDeviations(executionCwd, child)
   return "recorded"
 (the alreadyCommitted retry path also calls the sync)

 validation publication (validation-publication.ts)
+  syncEpicChildPlanDeviations(executionCwd, planName)
   checkpointExecutionWorktree(candidate_checkpoint)
   …
+  syncEpicChildPlanDeviations(executionCwd, planName)
   checkpointExecutionWorktree(candidate_sealing)
```

The pre-seal calls repair an interrupted write. For example, the child Plan saved but the process stopped before the
Epic write. They also cover deviations recorded during the Code Review gate, which runs inside the AI review phase,
before publication.

### Integration Notes move to the execution checkout

```diff
 validation-semantic.ts (after a review round)
-  recordIntegrationNotes(context.projectRoot, epic, child, notes)
+  recordIntegrationNotes(context.executionCwd, epic, child, notes)

 recordIntegrationNotes(checkoutRoot, …)
-  resolveWorkflowPlanLocation(resolvePrimaryCheckoutRoot(…), epic) → primary copy
+  loadPlan(checkoutRoot, epic) → the execution checkout's copy
```

The child's execution worktree is based on the Epic branch and contains the Epic document. Delivery commits every
non-runtime edit and merges it into the Epic branch. So the notes and the deviation blocks reach the branch head that
the gate reads.

### The integration review applies the approval

`buildIntegrationReviewRequest` already embeds the branch-head Epic markdown, so the section is in the request. Add one
instruction line beside the Integration Notes line: `### Child Plan Deviations` lists replacements the user confirmed
during child execution. `integration-reviewer-prompt.md` gets the rule:

- A confirmed child deviation is user-approved. An Epic outcome gap that only the deviation causes is not a finding.
- For each Epic outcome a deviation changes, add one advisory that names the outcome and the child.
- Defects unrelated to the deviation, and work the replacement itself requires, are still findings.

The option set aside: no copy, and the reviews read deviations directly from the child Plans. That avoids duplicate
text and merge conflicts. But a person reading the Epic still cannot see the scope change, and you asked for a record
on the Epic.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/epic-review-context.ts` — owns both managed child subsections: the generalized marker helper,
  `syncEpicChildPlanDeviations`, and `recordIntegrationNotes` writing to the given checkout.
- `src/shared/plan-deviations.ts` — the rendering of one child's entries for the Epic block. It reuses the existing
  per-entry format, so the Epic, the prompts, and the Work Record cannot drift apart.
- `src/tools/plan-deviation.ts` — calls the sync after a recorded or already-committed entry. The confirmation prompt
  says the text is also saved on the Epic when the Plan is an Epic child.
- `src/shared/workflow/validation-publication.ts` — calls the sync before both execution checkpoints. The Epic
  document path must be accepted by the sealed-candidate check when it changes before the final seal.
- `src/shared/workflow/validation-semantic.ts` — passes `context.executionCwd` to `recordIntegrationNotes`.
- `src/shared/workflow/epic-integration.ts` — one request instruction line for `### Child Plan Deviations`. Keep the
  branch-head Epic read.
- `src/agent-definitions/subagent-definitions/integration-reviewer-prompt.md` — the deviation rule and the advisory
  requirement.
- Tests: `src/tools/__tests__/plan-deviation.test.ts`, `src/shared/workflow/epic-review-context.test.ts`,
  `src/shared/workflow/epic-integration.test.ts`, and one Git-backed delivery test (extend
  `src/shared/workflow/plan-deviation-lifecycle.integration.test.ts` or add a sibling file).
- `docs/prd/runwield-core-prd.md` — the two owning capabilities named in Context.
- `docs/domain-language.md` — **Plan Deviation** and **Integration Notes** entries.
- `docs/plan-lifecycle.md` (Epic Branches and the Integration Gate) and `src/skills/runwield/PLANS.md` (Validation,
  review, and repair) — describe where the Epic copies live and how they travel.

Deliberately not changed:

- Epic Work Record generation. `aggregatePlanDeviations` already collects child entries from child front matter. It
  must keep reading front matter, not the Epic section, so entries do not appear twice.
- The Epic's own `planDeviations` front matter. Child entries must not go there. The schema has no source-child field,
  and `projectEngineerPlanBody` would present them as Epic-level authority.
- `loadEpicReviewContext`. Sibling AI reviews judge only their own child, so earlier sibling deviations are not needed
  there.
- Sequence containers. Their children use ordinary validation and have no integration review.

## Reuse Opportunities

- `withIntegrationNotes`, `noteMarker`, and `renderNotesBlock` in `src/shared/workflow/epic-review-context.ts` — the
  marker-block logic to generalize.
- `formatPlanDeviationForPrompt` and `readPlanDeviations` in `src/shared/plan-deviations.ts` — entry format and
  normalization.
- `writePlanMarkdownWithRevisionLocked` in `src/plan-store.js` — the revision-checked body write that
  `recordIntegrationNotes` already uses.
- `isSequencePlan` in `src/shared/project-plan.ts` — excludes Sequence parents.
- Test fixtures: `makeSession` and `makePlan` in `src/tools/__tests__/plan-deviation.test.ts`; the worktree setup in
  `src/shared/workflow/plan-deviation-lifecycle.integration.test.ts`; `epicWithPendingSecondChild` and
  `scriptedReviewer` in `src/shared/workflow/epic-integration.test.ts`.

## Implementation Steps

- `src/shared/workflow/epic-review-context.ts` has one marker-block helper. Both `withIntegrationNotes` and the new
  child-deviations writer call it. No second copy of the start/end marker format or the insertion rules exists in the
  module.
- `withIntegrationNotes` output is unchanged for every case its existing tests cover: replace an earlier block, insert
  under an existing heading, create the heading at the end of `## Verification Plan`, and append at the document end
  when that section is missing.
- `syncEpicChildPlanDeviations(checkoutRoot, childPlanName)` is exported from `epic-review-context.ts`, with this
  behavior:
    - The child's block under `### Child Plan Deviations` lists every entry of the child's `planDeviations` in order:
      superseded requirement, replacement requirement, optional reason, and approval time.
    - The subsection is created at the end of `## Objective` when it is missing.
    - Repeated calls write nothing when the block already matches.
    - It writes nothing when the child has no `parentPlan`, when the parent is missing from `checkoutRoot`, or when the
      parent is not a PROJECT or is `type: sequence`.
    - Text outside the child's block does not change, and neither does any front matter field of the Epic.
- `record_plan_deviation` calls the sync with `workflow.executionCwd` after a successful `savePlan` and in the
  `alreadyCommitted` path. A sync failure never turns a recorded child entry into a failed tool result. The tool text
  states when the entry was also recorded on the Epic.
- The confirmation prompt in `record_plan_deviation` says the confirmed text is saved in the Plan, its Epic (for an
  Epic child), and the Work Record.
- `validation-publication.ts` calls `syncEpicChildPlanDeviations(context.executionCwd, args.planName)` immediately
  before the `candidate_checkpoint` checkpoint and before the `candidate_sealing` checkpoint. The sealed commit's Epic
  document contains a block equal to the rendering of the child's `planDeviations`. The sealed-candidate unchanged
  check does not refuse the Epic document for this reason.
- `recordIntegrationNotes` takes the checkout root to write in and writes the Epic document in that checkout.
  `validation-semantic.ts` passes `context.executionCwd`. The primary checkout's Epic document is not written during
  child validation.
- `buildIntegrationReviewRequest` in `epic-integration.ts` tells the reviewer that `### Child Plan Deviations`, when
  present, lists user-confirmed replacements. The gate keeps using `reviewEpic` from the branch-head checkout.
- `integration-reviewer-prompt.md` states the rules: a confirmed child deviation is user-approved; a gap that only the
  deviation causes is not a finding; each Epic outcome a deviation changes gets one advisory that names the outcome and
  the child; other defects remain findings.
- `docs/prd/runwield-core-prd.md` matches the delivered behavior in both owning capabilities:
    - Plan deviations has the new requirement and the scenarios from the Verification Plan.
    - Epic decomposition and hold states that Integration Notes and child deviation blocks travel with the child's
      delivery to the Epic branch. It also states how the integration review treats child deviations.
    - The existing Integration Notes scenario stays, and now describes true behavior.
- `docs/domain-language.md` is updated in the same change:
    - **Plan Deviation** states that an Epic child's confirmed deviations also appear in the Epic's managed
      `### Child Plan Deviations` subsection. That copy is a projection; the child Plan stays the authority.
    - **Integration Notes** states that the notes are written in the child's execution checkout and reach the Epic
      branch with the child's delivery.
- `docs/plan-lifecycle.md` (Epic Branches and the Integration Gate) and `src/skills/runwield/PLANS.md` (Validation,
  review, and repair) describe the same storage and travel rules.

## Verification Plan

Automated focused checks:

```sh
bun scripts/run-tests.js src/shared/workflow/epic-review-context.test.ts src/tools/__tests__/plan-deviation.test.ts src/shared/workflow/epic-integration.test.ts src/shared/workflow/plan-deviation-lifecycle.integration.test.ts
```

Add the new Git-backed delivery test file to that command if the Engineer creates one. Register any new test file in
`scripts/bun-test-files.json` when that inventory requires it.

Behavior the tests must prove:

- **Record on the Epic (tool test).** Use a temp project with an Epic (`classification: PROJECT`) and a child with
  `parentPlan`. Confirm a deviation. The child Plan has the entry, and the Epic document has a `### Child Plan
Deviations` block for that child with the exact superseded and replacement text. This test fails if the sync is a
  no-op.
- **Idempotent retry.** Running the same tool call id again leaves exactly one Epic block and one entry.
- **No change without confirmation.** Cancel, unsupported host, and stale revision leave the Epic document
  byte-identical.
- **Scope.** A Sequence parent and a standalone Plan leave the parent document unchanged.
- **Self-repair (unit test).** Delete the child's block from the Epic document, then run the sync. The block returns.
  A second sync call writes nothing.
- **Two children.** Blocks for child A and child B coexist. Updating B does not change A's block or user-owned
  Objective text.
- **Reaches the branch and the gate (Git-backed).**
    1. Create the child worktree from `epic/<name>`.
    2. Record a deviation.
    3. Run the sync and the execution checkpoint, then merge the child into the Epic branch with `merge --no-ff`, as
       delivery does.
    4. Assert that `docs/plans/<epic>.md` at the Epic branch head contains the block.
    5. Run the gate with `scriptedReviewer` and assert the review request contains the block text and the new
       instruction line.
       This test fails if the block is written only to the primary checkout.
- **Integration Notes reach the gate.** Rewrite the existing primary-write assertion in
  `epic-review-context.test.ts` (around lines 121–146). After the change, a child review with notes writes them to the
  execution checkout's Epic document, and the primary copy stays unchanged. In the Git-backed test, the notes appear
  in the gate request after delivery.

Behavior that must still be protected:

- Every existing `record_plan_deviation` result: recorded, already committed, canceled, unsupported, stale, and
  inactive.
- Child AI review precedence for deviations.
- `withIntegrationNotes` replace and insert behavior.
- The branch-head Epic read in the gate, including the pause when the Epic document is missing from the branch.
- The Epic Work Record lists each child deviation once.

Behavior expected to stop:

- Integration Notes written to the primary checkout's Epic document during child validation. Rewrite the test that
  asserts that write against the execution checkout. Do not delete it.

Manual check:

- Run a two-child Epic. In child 1, confirm a deviation that removes an Epic outcome. Deliver both children and run
  the Integration Gate.
- Expected: the Epic document on the Epic branch shows the block, the gate passes on that outcome with an advisory
  naming it, and the Epic Work Record lists the deviation once.

Documents:

- Confirm that the Core PRD scenarios, `docs/domain-language.md`, `docs/plan-lifecycle.md`, and
  `src/skills/runwield/PLANS.md` describe the delivered storage and travel rules. They must not claim anything this
  change does not make true.

## Edge Cases & Considerations

- **Concurrent siblings.** Two children can run at the same time. If both add a block at the same point of the Epic
  document, their deliveries can conflict. Mitigation: one block per child and replace-only updates keep most merges
  clean. A remaining conflict uses the existing publication merge repair, and the next sync rebuilds the child's
  block. Assumption: this rare case does not need a deterministic resolver now.
- **The Epic document is part of the child's diff.** The child's AI review sees the Epic edit. The review request
  already contains the child's Approved Plan Deviations, so the edit matches. The Integration Gate's diff also shows
  the Epic section, which is expected.
- **Recording after the final seal.** Assumption: a deviation is not recorded after the `candidate_sealing`
  checkpoint. The Engineer confirms whether the publication merge repair turn has `record_plan_deviation`. If it does,
  that path must neither break the sealed-candidate check nor drop the child entry.
- **Shared Epic document.** A `SharedPlanLockError` skips the Epic write. The child entry stays authoritative and the
  Epic Work Record still lists it. This matches how `recordIntegrationNotes` behaves today.
- **Abandoned child.** Its blocks stay in its worktree and never reach the Epic branch. This is correct: the
  deviation was never delivered.
- **Branchless legacy Epic.** The child worktree contains the Epic document, and the sync writes there. Delivery
  carries it to the child's target. These Epics have no Integration Gate, so the block serves only as the record for
  readers.
