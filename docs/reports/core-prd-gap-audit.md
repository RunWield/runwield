# Core PRD Gap Audit — Planning Handoff

Audit date: 2026-09-12, America/New_York. Source baseline: `600f3e83`, including the working-tree changes present during
inspection. No implementation was changed. No tests or browser journeys were run.

## Purpose and limits

Preserve the investigation behind the
[ordered TODO section](../../TODO.md#core-prd-gaps-recommended-implementation-order) so Planner does not have to start
again. This is an evidence report, not an executable Plan. The work groups below need Planner-owned draft Plans. They
describe observed gaps and required outcomes, not a chosen implementation.

The [Core PRD](../prd/runwield-core-prd.md) is the product authority. Existing tests and old Plans can explain current
behavior, but they cannot override it. In particular, a delivery workflow ends only after confirmed publication or the
user's deliberate abandonment. A stopped Agent or failed automatic attempt does not establish either outcome.

Most Core capabilities have implementation and test support. This audit found gaps in recovery, review, user control,
and retained context. It is not evidence that every other journey works. No completion percentage is justified.

### Evidence quality

- **Observed during this audit:** Work Record search failed with
  `Invalid Work Record: Markdown body must include a
  non-empty ## Summary section.`
- **Source-confirmed paths:** The remaining findings come from source, prompts, and test inspection. Their examples are
  proposed reproductions, not claims that a runtime test was executed.
- **Existing coverage:** A cited test shows what the repository currently asserts. It was not run in this audit.
- **Future scope:** Compressed Project Brief, broader long-run context resilience, manual/imported Work Records, richer
  attribution, and further code intelligence remain separately labeled proposals. Do not turn them into baseline bugs.

### Current work to preserve

The checkout already contained changes to `docs/plans/fix-recovery-worktree-discard-cleanup.md`,
`src/plan-front-matter.js`, `src/plan-store.js`, `src/shared/workflow/controller-registry.ts`, `controller-state.ts`,
and the load-plan hold/recovery files. It also contained untracked `docs/plans/acp-shared-slash-commands.md` and
`docs/runwield-pm-context.md`.

The audit included those on-disk files. Recheck the working tree before drafting; do not overwrite, duplicate, or assume
those changes have shipped. The cleanup Plan was marked `feedback` when inspected.

## Recommended work groups

The numbers below match the TODO order. Quick wins appear in their own section at the end. Priority is not a dependency
chain: independent changes can ship separately.

## 2. Browser Pair decisions

**Owner:**
[Frontend engineering and pair execution](../prd/runwield-core-prd.md#frontend-engineering-and-pair-execution).
Workspace adds the browser experience; Core owns the decision meanings.

**Required outcome:** A user can revise, continue, switch to autonomous work, or stop with work preserved. An
unsupported host can use autonomous work, but a host must not claim Pair support and then misread its user's answer.

**Current path:**

```text
Workspace claims interaction support
  Pair checkpoint supplies its prompt and metadata, without choice options
  Browser presents generic text input
  Browser returns a text response
  Core accepts only a selected response as a Pair decision
  Unrecognized response switches execution to autonomous
```

**Evidence:**

- `src/ui/workspace/server/session-continuation.js:925`: interaction support claim.
- `src/tools/pair-checkpoint.ts:173`: checkpoint request; `:226`: selected-only decision extraction; `:295`: fallback.
- `src/ui/workspace/components/SessionTimeline.jsx:442,487`: typed-response mapping and generic interaction card.

**Failure example:** The user types “stop” or asks for a visual revision. The answer is not treated as that decision;
autonomous execution can continue. This is a user-control defect, not a missing visual refinement.

**Existing strengths and boundaries:** TUI Pair stop preserves the active Plan and blocks completion
(`pair-checkpoint.ts:280–291`, `task-completed.ts:170–181`, `engineer-runner.ts:99–104`). ACP explicitly declines Pair
(`src/acp/interaction-mapper.js:71–92`). Frontend ownership, autonomous fallback, and content-free metrics exist.
Preserve those behaviors; do not introduce new Pair semantics for Workspace.

**Evidence still needed:** Real browser decisions for revise, continue, autonomous, stop, and cancellation; proof that
stop does not dispatch more implementation or report completion. Test the actual browser response through Core, not only
a helper with an already-correct response shape.

**Related work:** `docs/plans/record-pair-plan-deviations.md` was `ready_for_work`. It concerns recording scope
deviations; it does not establish that browser checkpoint decisions work. Check for overlap without expanding this into
that feature.

## 3. Package extension consent

**Owner:** [Theme selection](../prd/runwield-core-prd.md#theme-selection) and
[Work protection](../prd/runwield-core-prd.md#work-protection).

**Required outcome:** Installing a theme does not enable accompanying executable extensions without explicit consent.
Interruption or failure before consent must remain safe.

**Evidence:** `src/cmd/install/index.ts:77` installs and persists the package before asking about compatible extensions
at `:91`. Only a refusal disables extensions at `:93`; the failure handler does not undo persistence. The installed Pi
package manager persists new sources without an extension restriction
(`node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:640`). Later loading uses
`src/shared/extensions/wld-extension-manifest.js:138` and `src/shared/session/session.js:2232`.

**Failure example:** Install a package containing a theme and a compatible extension, then interrupt the process before
answering the consent prompt. On a later Session, the saved package can supply executable extensions without confirmed
consent. This is a source-based interruption case, not a claim that it happened during this audit.

**Why this needs a Plan:** The safe result depends on package persistence, executable-resource filtering, interruption,
and later Session startup—not merely the prompt wording. Verify the current dependency contract before selecting the
change. Preserve normal theme installation and explicitly accepted extensions.

**Evidence still needed:** Restart behavior after refusal, interruption, and installation failure, plus successful
consent. A test that checks only whether the prompt was shown does not establish safety.

## 4. Unpublished workflow recovery

**Owner:** [Execution, validation, and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery) and
[Plan lifecycle](../prd/runwield-core-prd.md#plan-lifecycle).

**Required outcome:** Keep the same workflow available until proven publication or deliberate abandonment. Repair
RunWield-owned records automatically. Ask users only for actual outcome decisions or external prerequisites. Preserve
work and truthful publication evidence.

### Findings

**User verification removes validation continuation.**

- `src/shared/workflow/plan-lifecycle.js:468` clears the validation checkpoint on `manual_user_verified`; `:550` sets
  `user_verified`.
- `src/shared/workflow/validation-checkpoint.ts:42` has no continuation phase for that status.
- `src/cmd/load-plan/plan-recovery-flow.ts:353` therefore offers execution continuation rather than the saved
  validation/publication continuation.
- Example: attest to work at `validated_reviewer`, before publication. The user did not abandon delivery, but the saved
  validation path is removed. This is not confirmed deletion of the worktree.
- `src/shared/workflow/plan-lifecycle.test.js:411` tests attestation from implemented and reviewer-validated states, but
  does not establish continued delivery.

**Internal bookkeeping remains a user task.**

- `src/cmd/load-plan/plan-recovery-flow.ts:324,329` offers restoring a worktree record and closing unfinished updates.
- `src/cmd/load-plan/plan-recovery-actions.ts:204` asks the user to attest that nothing is unpublished before closing
  unresolved records.
- `src/cmd/plans/doctor.ts:653` reports an unreadable registry with manual actions rather than rebuilding it.
- `src/cmd/load-plan/plan-recovery-flow.test.ts:348` explicitly tests user attestation closing unresolved records.
- Refusing to invent publication evidence is correct. Making the user settle internal records is the gap. Determine
  actual external state where possible; preserve the open workflow where it cannot yet be established.

**Unexpected Reviewer errors stop the automatic path.**

- `src/shared/workflow/validation-semantic.ts:594` maps caught exceptions to provider `legacy_text` failures.
- `validation-operational-errors.ts:229–235` treats unclassified failures as fatal.
- `validation-recovery.ts:214–224` returns `kind: terminal` with no next action; semantic review returns `failed`.
- `validation-self-healing.integration.test.ts:174` and `validation-loop-review.test.js:438–465` expect stopped attempts
  for thrown Reviewer errors. Recognized provider retry is covered at `validation-loop-review.test.js:468`.
- The supervisor retains active workflow state. Do not describe this as proven permanent workflow loss. The confirmed
  gap is halted recovery without the immediate continuation required by the PRD.
- The Reviewer manager is local to a call (`validation-semantic.ts:403`). Pause saves findings but not that conversation
  (`:409–419`), which also challenges the promised same-conversation nudge.

**Hold is offered but rejected for unpublished validated work.**

- `plan-recovery-flow.ts:342` offers Hold; `src/cmd/load-plan/plan-hold.ts:90` and `plan-lifecycle.js:557` reject
  `validated`.
- Example: checks passed, publication awaits an external prerequisite, and the user chooses Hold. Delivery is
  unfinished, but the pause is rejected. Ordinary hold/resume tests at `plan-lifecycle.test.js:463` do not establish
  this case.

### Existing strengths and evidence still needed

Durable publication progress, remote-failure retry, dirty-checkout protection, and proof-based branch cleanup already
exist. See `validation-publication.ts`, `publication-machine.failure-matrix.test.ts:117`, and
`src/shared/worktree.js:1475–1605`. No destructive cleanup defect was confirmed in the inspected paths.

Required evidence must cross lifecycle and publication boundaries: attestation without delivery, interrupted internal
updates, stale records, unexpected Reviewer errors, hold/resume before publication, and deliberate abandonment
preserving unmerged work. Checking a status or message alone will not prove continuation.

### Related existing work

- `fix-recovery-worktree-discard-cleanup.md`: dirty, `feedback`; overlaps work preservation and cleanup.
- `guided-validation-repair.md`: `draft`; contains references to a Plan Workflow Lease. That is obsolete under
  [ADR-015](../adr/015-file-authoritative-session-bundles.md), not a requirement to restore.
- `offer-semantic-review-intervention.md`: `draft`; overlaps stalled-review choices.
- `fix-validation-repair-followup.md`: `ready_for_work`; covers repair handoff and subsequent messages.
- `archived/classify-validation-operational-errors.md`: historical explanation, not current acceptance evidence.

Planner should decide whether this group needs more than one independently deliverable Plan. Do not make unrelated
recovery fixes wait for a rewrite of the entire workflow engine.

## 5. Malformed Plan metadata

**Owner:** [Plan authoring and external adoption](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption).

**Required outcome:** Users own Plan prose. RunWield repairs its own metadata, preserves the latest body and decisions,
and leaves unrelated Plans usable. Ordinary listing must not mutate an external Markdown draft.

**Evidence:** `src/plan-store.js:1705` returns a malformed-file result without repair. At `:2733`, any unresolved active
Plan parse issue makes the whole listing throw. `src/cmd/load-plan/index.ts:300` rejects unknown status values.

**Failure example:** One Plan contains `status: [unterminated`. Listing other valid Plans fails. Loading does not
recover RunWield's lifecycle metadata. A separate body edit must not be lost while recovering this state.

**Existing tests:** `src/plan-store.test.js:968` expects listing to reject; `:1988` expects malformed metadata updates
to reject while preserving bytes. Byte preservation is valuable, but these tests do not prove automatic recovery.

**Existing strengths:** Read-only metadata-free drafts, deliberate adoption, original age, stable identity, and body
preservation have coverage at `plan-store.test.js:2848–2909`; adoption is implemented around `plan-store.js:3512`.

**Boundaries:** Do not relax review or infer that malformed metadata grants approval. Do not add a Plan-body parser. A
repair must preserve lifecycle evidence and recent edits, not merely make the file parse. The dirty Plan-store and
front-matter work needs inspection before choosing scope.

**Evidence still needed:** Mixed valid/malformed listings, unknown status recovery, concurrent body edits, interrupted
metadata repair, and unchanged ordinary external drafts. Recoverable metadata and genuinely missing evidence must be
handled without claiming certainty that does not exist.

## 7. Review correctness and retained feedback

**Owner:** [Semantic review and repair](../prd/runwield-core-prd.md#semantic-review-and-repair).

**Required outcome:** Two initial whole-change reviews, actual change inspection, independently verified findings, and
useful human feedback retained through repair. Preferences remain advisory. Human-driven review has no automatic round
limit that ends the workflow.

### Findings

**Round two is narrower than promised.** `src/shared/workflow/validation-semantic.ts:201` uses verification mode
whenever open findings exist. `src/agent-definitions/subagent-definitions/reviewer-verify-prompt.md:6` says two
discovery rounds have already happened. `validation-loop-review.test.js:616–620` explicitly expects round two to use
verification mode. Example: round one catches one defect but misses another elsewhere. Round two focuses on the repair
rather than providing the required second broad review.

**Listing files satisfies the change-inspection gate.** `review_diff("list")` emits the inspection event at
`src/shared/workflow/review-diff-tool.js:379`. The adapter reduces this to `Boolean(diffEvent)` at
`validation-session-adapter.ts:279`; review accepts it at `validation-semantic.ts:486,522`. The test helper at
`validation-loop-review.test.js:69–85` uses list-only inspection. A Reviewer can list filenames, read no hunks, and pass
the gate. This proves the gate is too weak; it does not prove every Reviewer actually skips reading code.

**Human-review conversation is discarded between successful repair cycles.**
`src/shared/workflow/validation-human-review.ts:97–108` starts fresh history. At `:223–250`, repair appends history and
returns; CI later invokes a new human-review phase with empty history. The next feedback can refer to a prior exchange
that is absent from the next repair packet. The chat test at `validation-loop-human-review.test.js:344–414` checks a
fresh diff and CI, not retained conversation.

The annotation-location defect is listed separately as quick win 6. Unexpected errors and stalled Reviewer continuation
belong to group 4; avoid duplicate ownership.

### Existing strengths and limits

`review-ledger.ts:89–150` and `validation-semantic.ts:487–580` retain finding identities, reject omitted findings, and
require independent verification. Focused repair prompts and immediate human images exist in
`validation-repair-prompt.ts`, `validation-human-review.ts:212–221`, and `validation-session-adapter.ts:317–324`. Human
feedback already returns through repair and CI directly to human review, without a human-round counter.

Two tests in `semantic-repair-segment-handoff.test.ts:108–117` assert local constants rather than production handoff
behavior. Do not treat them as proof of repair isolation. No escaped-defect measurement was established by this audit.

**Evidence still needed:** A defect outside the first repair remains discoverable on round two; list-only inspection
cannot establish a reviewed change; a second human-feedback turn can refer accurately to the first repair discussion.
Preserve focused context: retaining relevant feedback does not mean replaying unrelated implementation history.

**Related work:** `focused-semantic-review-after-human-feedback.md` was `ready_for_work` and may overlap or conflict
with review-round policy. Read it against the current PRD. `offer-semantic-review-intervention.md` and
`fix-validation-repair-followup.md` also overlap. Existing status does not prove the new journeys work.

## 8. Image access across Session handoffs

**Owner:** [Compaction and image context](../prd/runwield-core-prd.md#compaction-and-image-context) and
[Session continuity](../prd/runwield-core-prd.md#session-continuity).

**Required outcome:** Saved Session images remain available through execution, repair, and resume. Another Session must
not inherit access. A continuous visible transcript is not sufficient if its attachment references no longer resolve.

**Evidence:** `src/shared/session/image-attachments.ts:62–66,104–116` stores and looks up images using the current Pi
session ID. `src/shared/session/segment-rollover.ts:98–113` creates a new Pi ID. The inspected rollover path has no
image transfer or predecessor lookup. `src/tools/see-image.ts:94–98` supplies the current manager and cwd only.

**Failure example:** Attach a screenshot while planning, then begin execution. Ask `see_image` about the original
`attachment:<uuid>` in the same user-visible Session. Resolution checks the successor image directory and fails.

**Existing coverage:** `see-image.test.js:138` stores and reads with the same manager.
`segment-rollover.test.js:146,272` checks continuous transcript projection, not attachment access across that boundary.

**Evidence still needed:** Original attachment references before and after execution and repair rollover, resumed
access, and isolation between two Sessions. Include working-directory changes because execution can move into a
worktree.

**Boundary:** Keep the file-authoritative Session model in ADR-015 and the focused handoffs in ADR-012. Do not solve
this by copying all previous conversation into repair. Future Session deletion is not a current missing deletion
feature.

**Related work:** `fix-validation-repair-followup.md`, `workspace-session-continuation-readiness.md`, and archived
personal-workspace segment/rollover work. Their history may guide the investigation; none replaces attachment evidence.

## 9. Compaction with CLI execution backends

**Owner:** [Compaction and image context](../prd/runwield-core-prd.md#compaction-and-image-context) and
[Models and providers](../prd/runwield-core-prd.md#models-and-providers).

**Required outcome:** Changing backend keeps useful Session context. Compaction must not be silently undone by sending
all older messages again. Long CLI-backed Sessions need a usable continuation path and truthful feedback about limits.

**Evidence:**

- `/compact` requires `rootAgentSession.compact` in `src/shared/session/session-runtime.js:2372–2377`.
- CLI root wrappers expose only `kind`, `session`, and `dispose` in `execution-backend.ts:35–40`; their execution
  sessions do not expose compaction.
- `external-cli-conversation.ts:55–75` reconstructs the whole branch; its normalization at `:87–89` ignores compaction
  entries because they are not message entries.
- Claude uses that reconstruction at `backends/claude-cli/execution-session.ts:178,252`; Antigravity does at
  `backends/agy-cli/execution-session.ts:189–191`.

**Failure example:** Compact a long Pi conversation, then select a CLI backend. Old messages are reconstructed without
using the compaction summary. Manual compaction on the CLI root is unavailable. Actual provider overflow was not tested.

**Existing coverage:** Backend tests cover ordinary replay and named invocations, including
`src/shared/session/agy-cli-execution.test.ts:532,1076`. No compacted-history replay evidence was found.

**Related existing scope:** `automatic-session-context-resilience.md` is `ready_for_work`; its linked PRD is explicit
target scope for mid-run pressure, useful recovered headroom, retry restraint, and cancellation. That larger work does
not prove CLI replay honors an existing summary. Also inspect the `agy-cli-execution-backend/` Plans for current backend
constraints. Do not silently expand this group into a replacement summary algorithm or automatic model switching.

**Evidence still needed:** Backend switching after compaction, later user messages, resumed CLI history, and honest
manual-compaction behavior. Real backend limitations need current primary-source verification when Planner chooses
scope; this local audit did not research current CLI APIs.

## 10. Optional vision configuration and Project isolation

**Owner:** [Models and providers](../prd/runwield-core-prd.md#models-and-providers) and
[Compaction and image context](../prd/runwield-core-prd.md#compaction-and-image-context).

**Required outcome:** Bad optional image setup must not disable normal text use. Image submission must use the Session's
Project settings and preset precedence, and preserve typed text and previews when setup needs correction.

**Finding A:** `src/shared/session/session.js:2041–2044` eagerly resolves fallback for any text-only Pi Agent, without
requiring an image. `image-attachments.ts:194–224` throws for missing authentication, unknown models, or unsuitable
models. Example: old fallback credentials expire; starting a text-only Agent fails even for a text-only request.

**Finding B:** `src/shared/settings.js:617–629` resolves fallback without a Project root. The underlying reads default
to process cwd at `:548–550`. `session-runtime.js:2080–2095` does not supply the Session cwd. Example: Workspace runs in
Project A while handling a Session in Project B; it can choose A's fallback or reject B's valid setup.

**Existing coverage:** `image-attachments.test.js:158` checks fallback errors in isolation. At `:138–151`, tests change
process cwd to the Project being tested, hiding the multi-Project mismatch.

**Evidence still needed:** Text-only work with invalid optional fallback; two simultaneous Projects with different
fallback settings while process cwd remains fixed; preset precedence; image setup failure preserving the composer. Do
not weaken image validation merely to make text-only Agent creation succeed.

## 11. Malformed Work Record isolation

**Owner:** [Work records](../prd/runwield-core-prd.md#work-records).

**Required outcome:** One malformed record does not disable unrelated current records. Invalid material must not become
settled guidance. Existing canonical records and a usable derived index must remain recoverable.

**Observed failure:** `work_record_search` failed during this audit. Both of these records use `## Result` and lack the
required non-empty `## Summary`:

- `docs/work-records/2026-09-08-main-checkout-and-worktree-recovery-repair.md:17` — draft.
- `docs/work-records/2026-09-08-workspace-session-continuation-and-steering.md:17` — approved.

**Evidence:** `src/shared/work-records/store.js:92` parses every record without isolating a failure. Search scans
records before querying (`search.js:92`); read-by-ID also scans all (`store.js:106`). Validation throws at
`markdown.js:349`. The draft therefore blocks even current-only queries before filtering. Listing, backfill, and
rebuilding use the same scan. `index-adapter.ts:239–247` deletes the existing index before parsing all records.

**Distinguish two deliveries:** Quick win 1 fixes today's two documents. This group addresses the failure behavior when
another malformed document appears. Rebuilding alone cannot repair malformed Markdown.

**Existing strengths:** Generation deterministically sets source identity and completion confidence; generation failure
does not reverse a completed Plan. Filtering and historical notices exist. Backfill and confirmed supersession have
coverage. Preserve those rules while isolating errors.

**Evidence still needed:** Valid approved records remain searchable/readable with malformed draft and approved
neighbors; notices identify excluded material; failed rebuild retains recoverable search state; generation/backfill does
not create duplicates. Do not silently call malformed records valid or erase them.

**Related work:** `protect-plans-and-work-records-during-execution.md` may overlap document protection. Its presence was
found, but its full scope was not audited. Manual/external record creation remains deferred, not part of this repair.

## 12. Same-named Project knowledge isolation

**Owner:** [Project context and initialization](../prd/runwield-core-prd.md#project-context-and-initialization) and
[Work records](../prd/runwield-core-prd.md#work-records).

**Required outcome:** Separate repositories do not share project memories or overwrite each other's search index simply
because their directory names match. Preserve existing knowledge and intentional global-memory sharing.

**Evidence:** `src/extensions/mnemoteca/tools.ts:86–96` resolves the primary repository and uses its basename for the
memory collection. `src/shared/work-records/index-adapter.ts:59–65` uses the same kind of basename identity.

**Failure example:** `/client-a/app` and `/client-b/app` use the same memory collection name. Rebuilding one Work Record
index replaces indexed candidates for the other. Canonical filtering prevents foreign Work Records from being returned,
but it cannot recover the missing local candidates. This distinction matters: record leakage was not established; shared
memory and index collisions were.

**Domain constraint:** `docs/domain-language.md:655` documents the basename convention. That is current truth, but it
conflicts with the intended Project isolation. A new identity convention is not selected in this audit. Any change must
account for existing data; do not rename or discard it casually.

**Evidence still needed:** Same-basename repositories, linked worktrees of one repository, existing collection access,
independent index rebuilds, and unchanged global-memory behavior. This is not a quick string-format fix because users
already have data under the old names.

## Quick-win detail

### 1. Repair today's malformed Work Records

Correct the two records named in group 11 without changing source identity, status, confidence, or historical claims.
Check the complete canonical record format, not only the first reported error. A successful unrelated search is the
observable result. This is a bounded document correction; do not imply that it fixes malformed-record isolation.

### 6. Preserve annotation locations

`src/shared/workflow/validation-human-review.ts:307–324` deduplicates annotation text against free-text feedback without
checking its location. Example: free text says “Add a guard”; an annotation says the same at `handler.ts:42`.
Deduplication removes the only location. The repair packet must retain the useful reference. Include repeated text at
different locations; do not merge distinct findings just because their wording matches.

This appears bounded to feedback formatting and regression coverage. Group 7 owns retained conversation and broader
review policy. Promote this quick fix only if investigation reveals a wider annotation contract change.

### 13. Back up the same collection that Memory uses

Memory uses Git to resolve the primary repository (`src/extensions/mnemoteca/tools.ts:86–96`). Sleep uses the current
directory name (`src/cmd/sleep/index.ts:185–194`). In a differently named linked worktree, Sleep can back up the wrong
collection or fail to find it. Ordinary memory and maintenance must refer to the same collection.

This is a consistency correction, not the new Project identity policy in group 12. Verify primary-checkout and linked
worktree behavior. If group 12 ships first, follow its current collection rules.

### 14. Cancel theme preview back to the visible theme

`src/cmd/theme/index.ts:72` captures the saved theme name. Cancellation at `:89` reapplies it. If that theme is missing,
`src/ui/theme/theme-registry.ts:75–78` leaves the current preview active. The saved setting stays unchanged, but the
screen does not return to the usable fallback it showed before preview.

Example: start with a missing saved theme, preview an installed theme, then cancel. Restore the previous visible theme
or the built-in fallback without overwriting the saved choice. Ordinary preview/confirm/cancel already has tests at
`src/cmd/theme/index.test.ts:185`; add the missing-theme case rather than redesigning theme selection.

## Capabilities with substantial existing support

No material baseline gap was confirmed in the inspected routing dispatch, specialist follow-ups, ordinary Plan review,
external Markdown adoption, basic Epic decomposition, Agent customization, or capability-organized authoring guidance.
This is not blanket runtime certification.

Useful evidence includes:

- Routing and QUICK_FIX validation: `src/shared/workflow/orchestrator.ts:342–353,473–504`.
- Agent persistence: `agent-switching.js:173–213`, `active-agent-session.js:53–79,150–176` under `src/shared/session/`.
- Session continuation integration: `src/ui/workspace/session-continuation.integration.test.ts:263,731,945`.
- Plan review: `plan-review-actions.ts` and its tests under `src/shared/workflow/`.
- Epic decomposition: `workflow-slicer.ts`, its integration tests, and `plan-epic-flow.ts`.
- Customization: `src/shared/session/agents.js:511–519,564–568` and Session tool-policy tests.
- Work Record generation/filtering: `src/shared/work-records/generation.js:790–806`, `list.js:20–58`.

## Planner handoff constraints

Use the existing Core requirements rather than writing a replacement PRD. Find an existing owning Plan before creating
another. Confirm current symbols and line numbers; the working tree can change after this report. The selected groups
are product-level boundaries, not a requirement to create exactly ten Plans.

Carry the concrete failure examples and coverage limits into draft Plans. Preserve current versus proposed scope and
include owning PRD synchronization with behavior changes. Do not claim the source-based examples were reproduced.

Tests must use `deno task test` or `deno run -A scripts/run-tests.js <args>`, never raw `deno test`. The project
requires sandboxed HOME, real Git fixtures for owned workflow behavior, and no new injection seams for RunWield-owned
machinery. Browser Pair work needs real-browser evidence and the existing RunWield design system.

No new schema, storage layout, API, backend library, or migration strategy was selected by this audit. Those decisions
remain with the Agent that owns the Plan or any genuinely necessary architectural decision.
