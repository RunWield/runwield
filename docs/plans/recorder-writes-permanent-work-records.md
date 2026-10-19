---
planId: "902dea47-1004-4006-b519-b7915d0b064c"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/agent-definitions/recorder.md"
    - "src/shared/work-records/generation.js"
    - "src/tools/work-record-completed.ts"
    - "src/shared/work-records/schema.ts"
    - "src/shared/plan-deviations.ts"
    - "src/shared/publication-lifecycle.ts"
    - "src/ui/workspace/components/SessionTimeline.jsx"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-16"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "7d53440b903ea4338105fe8220bec5224647378e"
workRecord:
    status: "generated"
    recordId: "c87ac85f-2692-428c-9bdb-fbb2ceb0d36f"
    path: "docs/work-records/2026-10-17-permanent-work-record-content-and-stable-publication.md"
    lastAttemptAt: "2026-10-17T17:51:48.908Z"
status: "verified"
---

# Recorder writes permanent Work Records

## Context

A retrospective of all 238 Work Records in this repository and 26 in `brandchef.ai` found the same defects in both.
**The defects are in the Recorder, not in one project.** The retrospective covered every record, with three read-only
reviewers and scans.

The main cause: the Recorder copies the execution report into the record instead of distilling permanent facts.

| #   | Pattern                                                                                                     | Approximate count (RunWield) |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | Validation receipts in the Summary ("Verification passed with … full CI")                                   | ~160/238                     |
| 2   | Events from one run filed as Deviations or Deferred Work (flakes, reruns, ports, "non-interactive session") | ~60                          |
| 3   | `verified` records whose body says CI failed or validation is pending                                       | ~17                          |
| 4   | Test counts, commit hashes, token counts, timings, local paths                                              | ~35                          |
| 5   | Pending-publication text, which the caller already forbids                                                  | ~14, mostly October          |
| 6   | Changelog titles and Summaries ("Added…", "…shipped", mixed casing)                                         | ~110 titles                  |
| 7   | Lists of changed files instead of behavior                                                                  | ~60                          |
| 8   | Deferred Work mixes follow-up scope, non-goals, housekeeping, and known shipped defects                     | ~40                          |
| 9   | User-verification note pasted raw and stated twice                                                          | 13/15 `user_verified`        |
| 10  | No Future Planning Notes on large architectural work                                                        | ~50                          |
| 11  | done_enough Epics written as fully verified                                                                 | a few                        |
| 12  | Deferred items stay "remaining" after later work delivered them                                             | ~8 in July alone             |
| 13  | Plan-internal references ("feature 7", "OC3", "child 08")                                                   | ~10                          |

`brandchef.ai` added four more:

- **A missed behavior change.** The Plan said "without changing behavior", five runtime fixes shipped, and the record
  did not mention them. The owner added that section by hand later.
- **Machine-local tips filed as lessons** ("Use podman … on this machine").
- **RunWield process text inside another project's memory** ("RunWield Workflow Validation passed").
- **Duplicate records for one change.** This needs a separate investigation and is out of scope here.

Three structural causes sit outside the model:

- **`buildRecorderPrompt` holds rules in code.** In `src/shared/work-records/generation.js`, a long `instruction`
  string tells the Recorder to "Distill executionReport facts into the appropriate sections". Its prohibitions are
  invisible to anyone who reads `recorder.md`.
- **The Recorder owns a `deviationsFromPlan` field.** That field fills with run events. Recorded Plan Deviations
  already render deterministically.
- **`finalizedRecord` in `src/shared/publication-lifecycle.ts` rewrites every published record.** Since 2026-10-13, it
  replaces the Summary with delivery metadata and a commit hash, and quotes the real draft under "Historical
  pre-publication notes". It exists only because drafts contained pending text.

**Owning PRD capability:** `docs/prd/runwield-core-prd.md`, Work Records (around line 1225):

- **Changed:** "Preserve outcomes with truthful completion confidence". "Meaningful deviations, deferred scope" becomes
  recorded Plan Deviations, out-of-scope facts, and durable lessons. The delivery-stage bullet stops promising
  post-publication prose and a commit named in the record.
- **Kept:**
    - completion labels;
    - a pending record until the merge finalizes, and restart reuse;
    - best-effort recording and **Retry Work Record**;
    - the one corrective retry;
    - retrieval and supersession rules.

## Objective

A Work Record is permanent, authoritative memory of what is done, for any project RunWield runs on. **It holds only
what stays true after the next PR.**

After this change:

- `src/agent-definitions/recorder.md` is the only place that holds Recorder instructions. The caller sends source data
  only.
- The Recorder writes a Title, a Summary, optional Out of Scope, and optional Future Planning Notes. It writes no
  receipts, counts, hashes, delivery status, run events, to-dos, or known defects.
- **Deviations from Plan** appears only when Plan Engineers recorded Plan Deviations. RunWield renders those entries.
  The Recorder adds no deviation prose and no commentary about deviations.
- **Out of Scope** replaces Deferred Work for new records. It states what the work did not include, as fact.
- RunWield writes the completion-label sentences (user verified, closed without verification, done enough). The
  Recorder never writes them, so they appear exactly once.
- When behavior changed against a constraint the Plan stated, the Summary says so as fact.
- Publication changes only the record's `status` to `approved`. The body is the delivered body. **The delivered commit
  lives only in the source Plan's Delivery Evidence**, reached through `provenance.sourcePlans` (owner decision A).

## Approach

### Where each fact comes from

```text
Recorder (LLM, recorder.md)           RunWield (deterministic)
- Title                               - front matter, status, completionMode
- Summary body                        - completion-label sentence (prepended)
- Out of Scope                        - Deviations from Plan (recorded planDeviations only)
- Future Planning Notes               - Required Record Notes
- supersessionProposals               - delivered commit -> source Plan Delivery Evidence
```

### Caller sends data only

```diff
 buildRecorderPrompt(source, successorRecordId, settledSupersedes)
-  instruction: "Generate a concise Work Record body draft ... Distill executionReport facts ..."
   successorRecordId
   settledSupersedes
   source:
-    deliveryState: "pending publication; do not claim merged or delivered"
     name, path, planId, scope, completionMode, closureReason,
     userVerificationNote, userVerifiedAt, executionReport, attrs,
     planDeviations, body, children
```

The first-attempt suffix "Submit the sections by calling work_record_completed…" goes too. `recorder.md` already says
this.

### Output contract

```diff
 work_record_completed {
   title, summary,
-  deviationsFromPlan?,
-  deferredWork?,
+  outOfScope?,
   futurePlanningNotes?,
   supersessionProposals?
 }
```

### Body assembly

```diff
 buildBody
   # Title
   ## Summary          <- completion label (RunWield) + Recorder summary
-  ## Deviations from Plan   <- mergeRecorderDeviationText(recorded, recorder prose)
+  ## Deviations from Plan   <- renderPlanDeviationsForWorkRecord(recorded) only; omitted when none
-  ## Deferred Work
+  ## Out of Scope
   ## Future Planning Notes
   ## Required Record Notes
```

### Publication

```diff
 finalizedRecord(sealedRecord)
-  if pending_verification: rewrite body with delivery metadata, commit, quoted draft
-  return approved
+  return sealed body with status: approved
```

### `recorder.md` target shape

The prompt stays small: one rule, its test, one definition per section, and one five-row table. The examples are
project-neutral, so the prompt works in any repository. The Engineer may tighten the wording but must keep every rule
and every row.

```md
## The Rule

A Work Record is permanent memory of what is done. Future planning in this project treats it as authoritative.
Write only what stays true after the next change. Test every sentence: "Will this still be true and useful in a year?"

## Input

(one short list: successorRecordId, settledSupersedes, and the source fields, including executionReport,
planDeviations, children, and the Plan body. The execution report is evidence to read, not content to copy.)

## Sections

- Title: a noun phrase that names the outcome, in sentence case. No status words (shipped, delivered, verified,
  completed) and no leading past-tense verb.
- Summary: one short paragraph, about 3 to 5 sentences. State the project's resulting behavior in the present tense,
  with the product or capability as the subject. Say why future planning should care.
- Out of Scope: what this work did not include, as fact ("This work does not include X."). Omit it when empty.
- Future Planning Notes: durable rules or constraints a later Plan in this area must respect. Omit it when no lesson
  exists. Not backlog, not machine-local setup.

## Do Not Write

| Do not write                                                                                             | Write instead                                                               |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Run evidence: "Focused tests passed (147); full CI green", "rerun passed", "port 5175", "commit 7dba8e4" | Nothing. completionMode carries confidence.                                 |
| Status: "Publication remains pending", "not yet merged", "full CI still pending"                         | Nothing. RunWield owns delivery state.                                      |
| Changelog: "Added cache.ts; updated tests, docs and help text"                                           | "Search results now come from a local cache that ..."                       |
| To-dos and defects: "Resolve the toolbar overlap in a follow-up"                                         | Nothing, or a scope fact: "This work does not include keyboard reordering." |
| Raw notes: "│ done with codex │ see 789bb3c"                                                             | Nothing. RunWield adds the cleaned user note once.                          |

## Rules

- completionMode is the truth. Do not restate validation results. When the execution report disagrees, follow
  completionMode and leave the disagreement out.
- Do not write completion-label sentences (user verified, closed without verification, done enough). RunWield adds
  them.
- When the Plan stated a constraint (for example "no behavior change") and the execution report shows behavior that
  changed anyway, state each change in the Summary as fact.
- Do not write deviations or comment on them. RunWield renders recorded Plan Deviations.
- Name things directly. No Plan-internal IDs ("feature 7", "OC3", "child 08").
- Do not describe RunWield's own process (agents, review rounds, validation runs, sessions).
- For Epics, describe the combined outcome. Mention a child only when it explains the result or the out-of-scope
  boundary.
```

The existing supersession, settled-supersedes, and Work Record Retrieval guidance stays, shortened where it repeats.
`source.planDeviations` changes from "do not repeat or contradict" to "RunWield renders these; do not write about
them". The "User Verified sources" section becomes one rule: the label and note come from RunWield, and the Summary
must not claim that RunWield validation passed.

> [!TIP]
> **Why the completion labels move into code**
>
> Today both the prompt and `prepareGeneratedSections` add the user-verified label, so it appears twice (pattern 9).
> One owner gives exactly one sentence, and a test can check it.

One option was set aside: keep `deviationsFromPlan` with stricter rules. The retrospective found that field held run
events in almost every record. The deviation data the owner wants for later analysis is the recorded Plan Deviations,
which RunWield already renders.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/agent-definitions/recorder.md` — becomes the only home of Recorder instructions (rule, input, sections, table,
  rules).
- `src/shared/work-records/generation.js`:
    - `buildRecorderPrompt` sends data only;
    - `normalizeRecorderOutput` and `GeneratedWorkRecordSections` use `outOfScope`;
    - `buildBody` renders recorded deviations only;
    - `prepareGeneratedSections` owns all three completion labels;
    - the unused `synthesizeWorkRecordSections` is removed.
- `src/tools/work-record-completed.ts` — the tool schema drops `deviationsFromPlan` and `deferredWork` and adds
  `outOfScope`.
- `src/shared/work-records/schema.ts` — `WORK_RECORD_OPTIONAL_SECTION_TITLES` adds "Out of Scope" and keeps "Deferred
  Work", so existing records still read.
- `src/shared/plan-deviations.ts` — `mergeRecorderDeviationText` is removed. It has no remaining purpose.
- `src/shared/publication-lifecycle.ts` — `finalizedRecord` only changes the status. The retry matcher still accepts an
  already-wrapped record.
- `src/ui/workspace/components/SessionTimeline.jsx` — the `work_record_completed` block shows "Out of scope".
- Fixtures that build `work_record_completed` payloads:
    - `src/ui/workspace/server/dev-owner-fixtures.ts`;
    - `src/ui/tui/testing/scenario-runner.js`;
    - `src/ui/tui/golden-scenarios/concurrent-workflow.ts`.
- Tests:
    - `src/shared/work-records/work-records.test.js`;
    - `src/shared/publication-lifecycle.test.ts`;
    - `src/shared/plan-deviations.test.ts`;
    - `src/ui/workspace/workspace-session-ux.test.tsx`.
- `docs/prd/runwield-core-prd.md` — the Work Records requirement, the delivery-stage bullet, and the scenarios.
- `docs/domain-language.md` — the **Work Record** definition states permanence.
- `docs/product-strategy.md` (around line 252) — the reference to "Deferred Work" becomes "Out of Scope".

Deliberately left out:

- `src/shared/work-records/index-adapter.ts` keeps indexing an existing "Historical pre-publication notes" section. Five
  current records still use it until the separate cleanup unwraps them.
- `docs-site/src/content/docs/contributing/prd/` is a generated copy.
- ADR-016 already says only that publication approves the record. It needs no change.

## Reuse Opportunities

- `renderPlanDeviationsForWorkRecord` and `aggregatePlanDeviations` — already render recorded Plan Deviations,
  including Epic children.
- The `USER_VERIFIED_TEXT` and `SKIPPED_VERIFICATION_TEXT` constants and the `prepareGeneratedSections` pattern — extend
  them with a done-enough label instead of adding a new mechanism.
- The `runRecorderStep` option of `generateRecorderSections` — the existing test boundary for the Recorder turn (an
  agent turn, a valid seam).
- The `finalizeLocalPublicationLifecycle` fixture in `src/shared/publication-lifecycle.test.ts` — the real Git
  repository for publication tests.

## Implementation Steps

1. `src/agent-definitions/recorder.md` contains the sections in the target shape: The Rule (with the one-year test),
   Input, Sections (Title, Summary, Out of Scope, Future Planning Notes), the five-row Do Not Write table with
   project-neutral examples, Rules, Supersession, and Work Record Retrieval. It covers every rule listed in Approach.
   It does not mention `deviationsFromPlan`, `deferredWork`, or Deferred Work. Its output-contract example uses
   `outOfScope`. Its front matter, tools, and `sharedPractice: [user-authority]` are unchanged.
2. `buildRecorderPrompt` returns JSON with exactly the top-level keys `successorRecordId`, `settledSupersedes`, and
   `source`. It has no `instruction` key, and `source` has no `deliveryState` key. The first-attempt `userRequest` is
   the prompt alone. The second-attempt corrective message stays (see Edge Cases).
3. `work_record_completed` accepts `title`, `summary`, `outOfScope`, `futurePlanningNotes`, and `supersessionProposals`.
   With `additionalProperties: false`, a payload with `deviationsFromPlan` or `deferredWork` is rejected and the model
   corrects it. `normalizeRecorderOutput` returns the same five fields and ignores any others. The
   `GeneratedWorkRecordSections` typedef matches.
4. `buildBody` writes `## Deviations from Plan` only when `aggregatePlanDeviations(source)` is non-empty. Its content is
   exactly `renderPlanDeviationsForWorkRecord(...)`. "Additional Recorder notes" never appears.
   `mergeRecorderDeviationText` and its tests no longer exist.
5. `buildBody` writes `## Out of Scope` from `outOfScope` and never writes `## Deferred Work`. `schema.ts` lists "Out of
   Scope" in `WORK_RECORD_OPTIONAL_SECTION_TITLES`, and `parseWorkRecordMarkdown` returns it in `optional`. An existing
   record with `## Deferred Work` still parses that section.
6. `prepareGeneratedSections` prepends exactly one completion-label sentence:
    - `user_verified`: the user-verified label plus `User verification note: <note>`. The note is cleaned first:
      box-drawing characters (U+2500–U+257F) are removed and whitespace collapsed. The user's words are otherwise kept.
    - `closed_without_verification`: the skipped-validation label plus the closure reason.
    - `done_enough`: a new `DONE_ENOUGH_TEXT` label ("The Epic was closed as done enough.").
    - `verified`: no label.
      The existing `includes` guards keep the label from repeating if the model writes it anyway.
7. `synthesizeWorkRecordSections` no longer exists in `generation.js`.
8. In `finalizedRecord` in `src/shared/publication-lifecycle.ts`, the result for a `pending_verification` record is
   the sealed body unchanged, with `status: approved`. No output contains "Delivery metadata has been finalized", the
   candidate commit, "Delivery destination", or "Historical pre-publication notes". A publication retry finds the
   record already approved and makes no write.

    A retry that finds a record already finalized by the earlier wrapper (an approved record with the same `recordId`
    whose body contains `## Historical pre-publication notes`) accepts it as finalized and leaves it unchanged. It does
    not throw "changed outside its sealed publication".

9. The `work_record_completed` block in `SessionTimeline.jsx` renders `outOfScope` under "Out of scope". It still
   renders `deviationsFromPlan` and `deferredWork` from older stored Session events under their old labels. The
   fixtures in `dev-owner-fixtures.ts`, `scenario-runner.js`, and `concurrent-workflow.ts` use the new payload shape,
   with no "None." placeholders.
10. In `docs/prd/runwield-core-prd.md`, the Work Records requirement says the following:
    - records hold permanent facts: outcome, recorded Plan Deviations, out-of-scope facts, and durable lessons;
    - they hold no validation receipts, delivery status, run events, to-dos, or known defects;
    - a record stays pending until the merge finalizes, and publication approves it without rewriting the body;
    - the delivered commit is in the source Plan's Delivery Evidence.

    The scenarios add three cases:
    - with no recorded Plan Deviations, the record has no Deviations section;
    - after publication, the record body equals the pre-publication body;
    - a user-verified record states the attestation and note once.

    The rest of the capability is unchanged.

11. In `docs/domain-language.md`, **Work Record** says it holds only facts that stay true after later changes: the
    delivered outcome, recorded Plan Deviations, out-of-scope facts, and durable lessons. Its _Avoid_ list adds "known
    issues list" and "validation receipt". `docs/product-strategy.md` names "Out of Scope" in place of "Deferred Work".

## Verification Plan

**Automated (focused):**

```sh
bun scripts/run-tests.js src/shared/work-records src/shared/publication-lifecycle.test.ts src/shared/plan-deviations.test.ts src/ui/workspace/workspace-session-ux.test.tsx src/shared/workflow/workflow-prompts.test.ts src/shared/session/agents-shared-practice.test.ts
```

Required tests (each fails against the current code):

- **The prompt is data only** (`work-records.test.js`, replacing the "Generate a concise Work Record body draft"
  assertion). It captures the prompt through `runRecorderStep`, parses it, and asserts the key set is exactly
  `successorRecordId`, `settledSupersedes`, `source`, with no `instruction` and no `source.deliveryState`.
- **Deviations come only from recorded entries.** A generated record whose Recorder step returns `deviationsFromPlan`
  has no `## Deviations from Plan` when the source has no `planDeviations`. With one recorded deviation, the section
  equals the rendered entry and contains no "Additional Recorder notes".
- **Out of Scope:** `outOfScope` renders `## Out of Scope`. `deferredWork` from a Recorder step renders nothing.
  `parseWorkRecordMarkdown` reads both "Out of Scope" and the legacy "Deferred Work".
- **Completion labels appear once.** For `user_verified`, `closed_without_verification`, and `done_enough`, the label
  sentence appears exactly once, even when the Recorder summary already contains it. A note with `│` characters is
  stored without them.
- **Publication keeps the body** (`publication-lifecycle.test.ts`, rewriting the current wrapper assertions):
    - the finalized record body equals the sealed body;
    - the status is `approved`;
    - the body contains neither the candidate commit nor "Historical pre-publication notes";
    - a second finalize run writes nothing;
    - a record already in the old wrapped form is accepted unchanged.
- **Tool schema:** `work_record_completed` rejects `deviationsFromPlan` and accepts `outOfScope`.

**Behavior that must stay protected:**

- the corrective retry and the protocol diagnostic;
- supersession validation;
- settled supersedes;
- Ticket aggregation;
- Required Record Notes;
- index rebuild of existing records (including the legacy historical section);
- publication identity checks and target-branch finalization for both `autocrlf` settings.

**Behavior expected to stop existing**, so delete the tests:

- `mergeRecorderDeviationText`;
- the delivery-metadata wrapper assertions ("Delivery destination", "no additional or full test suite is claimed",
  the quoted draft lines);
- the prompt-instruction text assertion.

**Manual Recorder evaluation (real model, no commits):** in a throwaway clone, run `generateRecorderSections` from a
scratch script for these sources, and print the sections:

- the source Plan of `docs/work-records/2026-10-16-edit-to-suggest-in-code-review.md` (`docs/plans/edit-code-to-suggest-in-code-review.md`): its report has receipts and pending text;
- one `user_verified` source;
- one `done_enough` Epic;
- a fixture Plan that says "without changing behavior" and whose `executionReport` lists two behavior fixes.

Expected results:

- no test counts, commands, commit hashes, ports, or pending or merged text;
- outcome-noun titles in sentence case;
- the Summary states behavior in the present tense;
- Out of Scope written as facts, with no to-dos or defects;
- no completion-label sentence from the model;
- the behavior-change fixture names both fixes in its Summary.

Record the outputs in the execution report.

**Docs:** the Core PRD Work Records requirement and scenarios match the delivered behavior. The glossary describes only
implemented behavior. `grep -rn "Deferred Work" docs/prd docs/domain-language.md docs/product-strategy.md` returns only
legacy-reading mentions, if any.

## Edge Cases & Considerations

- **Existing records keep "Deferred Work" and the old wrapper.** The schema still reads both. Rewriting the 238
  existing records is a separate cleanup session, which runs after this change.
- **A publication interrupted across the upgrade.** The earlier code may already have written the wrapped record. Step
  8 accepts that form as finalized, so recovery never asks the user to repair a record.
- **The corrective retry message stays in code.** Assumption: that message reports a runtime fact (no accepted
  submission) and adds no content rules. The PRD requires one corrective turn. Everything about record content lives in
  `recorder.md`.
- **Older Session events in Workspace.** Stored `work_record_completed` events keep `deviationsFromPlan` and
  `deferredWork`. The timeline still renders them, so historical Sessions do not lose content.
- **The model may still write a forbidden phrase.** The prompt reduces this, and the `includes` guards stop duplicate
  labels. There is no deterministic phrase filter: one would encode a style decision in code, and it could delete true
  facts.
- **Behavior-change detection is limited to the Plan and the report.** The Recorder does not read the diff. A change
  that the execution report does not mention can still be missed.
- **Out of scope for this Plan:**
    - cleaning existing records;
    - the duplicate-record investigation (`brandchef.ai` Mailchimp pair);
    - the Planner work-record-search retrospective;
    - cross-record analysis of Plan Deviation patterns.
