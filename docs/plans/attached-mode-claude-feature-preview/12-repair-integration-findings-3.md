---
planId: "0a23b8e6-c2f3-4304-90b4-4246818948a8"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/publication-revalidation.ts"
    - "src/shared/workflow/validation-engine.ts"
    - "src/shared/workflow/validation-semantic.ts"
    - "src/shared/workflow/validation-checkpoint.ts"
    - "src/shared/workflow/validation-scope.ts"
    - "src/shared/attached/review-host.ts"
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/shared/attached/compatibility.ts"
    - "src/shared/attached/operations.ts"
    - "src/shared/attached/coordinator.ts"
    - "src/shared/attached/role-instructions.ts"
    - "src/shared/session/skill-catalog.ts"
    - "src/shared/session/session.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/adr/014-attached-workflow-coordination-boundary.md"
    - "docs/user-documentation/connect-claude-code.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-25T01:49:30.675Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 12
dependencies: []
targetBranch: "epic/attached-mode-claude-feature-preview"
userVerifiedAt: null
validatedCommit: "d4d7570dd8be264c47fc238a937f68133bc0d100"
status: "verified"
---

# Repair integration findings 3

## Context

The integration gate checked the Epic branch `epic/attached-mode-claude-feature-preview` at
`2c6765e026328e54e7781b9986907f09c439a10f` and reported 8 findings. The full report is
`docs/plans/attached-mode-claude-feature-preview/integration-report.md` in the primary checkout. After this child is
delivered, the integration gate runs again on the whole Epic.

Planning sorted the findings:

| Finding                                          | Decision              | Reason                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1 Project checks fail                           | **Dismissed**         | Environmental, as in children 10 and 11. The gate checkout `wld-epic-gate-cjmcrt` had no `node_modules` ("Cannot find package 'typescript'", "Cannot find module '@astrojs/check'", no `astro.mjs`) and no initialized `third_party/plannotator` submodule.                                                        |
| #2 No Planning Gate                              | **Dismissed**         | Owner decision (children 10 and 11): Connect adds no hooks or tool restrictions, as in Core. ADR-014 and the Epic on this branch say so. The gate reads main's old Epic copy, which still has the removed Planning Gate text (lines 215, 235, 261 on `main`).                                                      |
| #4 Two Attached workflows implement one worktree | **Dismissed**         | Owner decision (child 10 #4, child 11 #3): an Attached Workflow Record references its Plan and does not own it. The Epic puts single-Plan ownership out of scope. `execution-start.ts` reuses an active worktree the same way for Core. Main's old Epic copy still has "One workflow has one consequential owner". |
| #3, #5, #6, #7, #8                               | **Fix in this child** | Real defects, described below.                                                                                                                                                                                                                                                                                     |

> [!NOTE]
> **The gate can raise #1, #2, and #4 again**
>
> Until the separate gate fixes land (dependencies in the gate checkout, Epic read from the Epic branch), the next gate
> run can report these findings again. They are dismissed on purpose.

The fixes keep these requirements:

- Epic Outcome Evidence, **Verified has one meaning**: `verified` only after Mechanical Validation, configured CI,
  independent Semantic Review, optional human review, and safeguarded merge-back.
- [Core: Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair), **Bind saved human
  approval to the current candidate** and its **Diff-bound approval** scenario.
- [Connect: Shared Plan and verification outcomes](../../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes):
  "Approve & Run authorizes immediate execution after readiness. Approve for Later stops at Ready For Work."
- Epic **Claude owns process lifetime**: closing Claude stops the MCP server and its review endpoints.
- [Connect: Compatibility and honest availability](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability):
  a host API list or a version number alone is not evidence of tested support.
- [Connect: Host-owned reasoning](../../prd/runwield-connect-prd.md#host-owned-reasoning): "RunWield may inject its
  Agent prompts and Skills." ADR-014: role instructions are resolved at run time; the plugin ships no generated Skills.

## Objective

Fix findings #3, #5, #6, #7, and #8 on the Epic branch so that:

- **#3** Code that changes after Semantic Review passes runs Mechanical Validation, CI, and Semantic Review again before
  a new human Code Review can approve it. This applies to Core and Attached, because the gap is in the shared engine.
- **#5** A Plan page poll during the move to code review cannot block code-review hosting or MCP shutdown.
- **#6** The Attached Plan review button says **Approve & Run**, which is what it authorizes.
- **#7** Preflight rejects a host other than Claude Code before any workflow change.
- **#8** Claude-hosted roles receive the effective RunWield Skill catalog (project, home, external, bundled) with each
  role's instructions.

## Approach

Each fix goes through the module that already owns the behavior. No new workflow state, record field outside the
validation checkpoint, or seam.

### #3 Changed code returns to validation

Today nothing records which candidate passed Semantic Review. After the human-review wait rejects a stale approval
(`validation-interactions.ts` hashes `diffText`), `start_validation` re-enters the engine with status `reviewed`.
`preparePublicationRevalidation` returns `null` because no publication attempt exists, so `resolveNextPhase` goes to
delivery and `runHumanReviewPhase` shows the new diff. Approval then seals the current files
(`checkpointExecutionWorktree`). Core has the same gap after "Stop / come back later", an edit, and `load-plan`.

The fix records a candidate identity when Semantic Review passes and checks it in the existing pre-phase owner:

```diff
 runValidationPhase (validation-engine.ts, under the Plan lock, before phase selection)
   preparePublicationRevalidation(projectRoot, planName)
-    no publication attempt -> null
+    no publication attempt, status reviewed, checkpoint has candidateIdentity,
+    and current identity differs
+      -> same reset as a changed publication source:
+         status implemented, humanReviewDecision null, rounds 0, checkpoint cleared
+         return PUBLICATION_REVALIDATION_MESSAGE (or a candidate-specific message)
   resolveNextPhase(...)
```

```text
candidateIdentity(diffText, planName)        # validation-scope.ts, next to isPlanDocumentPath
  drop file sections whose path isPlanDocumentPath
  sha-256 of the rest
```

- The diff is `getWorktreeReviewDiff(executionCwd, worktreeBaseBranch)`, the same diff the human review shows.
- Plan documents are excluded. Front matter writes during validation (status, checkpoint) must not look like a code
  change, or every re-entry would reset.
- The identity is written at every `semantic_review_passed` site in `validation-semantic.ts` (the reviewed pass and the
  skip sites), so a feedback repair that skips Semantic Review still records the repaired candidate.
- `humanReviewDecision` is cleared, so the `changes_requested` bypass (`validation-semantic.ts` ~106) does not skip
  Semantic Review for edits made outside a review.

The Attached coordinator needs no change. In the same `start_validation` call the engine runs CI, then raises a
reviewer request, which `coordinator.ts` already turns into a `validation`/`reviewer` next action.

> [!WARNING]
> **Core behavior changes in one edge case**
>
> A Core user who stops at Code Review, edits implementation files, and resumes with `load-plan` now reruns CI and
> Semantic Review before the new Code Review. Today that edit goes straight to human review and can be published
> without CI.

> **Question (core-revalidation-scope):** Fix #3 in the shared validation engine, so Core also reruns CI and Semantic Review when code changes after Semantic Review passed? (No = Attached-only check in the coordinator, leaving the Core gap.)
>
> **Answer:** Yes (answered in review)

Set aside: an Attached-only check in the coordinator. It leaves the same Core gap and puts candidate policy in a
second module.

### #5 Plan polling cannot block the code-review handover

The cycle today:

```text
GET /api/review/conversation (old Plan server, server.js)
  await conversation.refresh()                     # review-host.ts, key changed to code_review
    await ensureReviewHosted -> ensureCodeReviewHosted
      await existing.surface.stop()               # review-host.ts ~289
        server.shutdown() -> Bun stop(false)       # waits for in-flight requests, incl. this GET
```

The fix uses the pattern already at `review-host.ts` ~169 ("A reload can be inside this server; let its response
finish before shutdown waits for it"):

```diff
-        if (existing?.type === "plan") await existing.surface.stop();
+        if (existing?.type === "plan") stopDetached(existing.surface);
```

`stopDetached` starts the stop, catches its rejection (the server already reports stop errors to `onOutput`), and
keeps the promise in a module-level set. `stopHostedAttachedReviews` awaits that set after the `opening` promises
settle. MCP close is not inside a review handler, so waiting there is safe, and closing Claude still waits for every
review server to stop. The site at ~169 uses the same helper.

Related defect fixed here: the refresh calls `ensureReviewHosted(projectRoot, status.workflow)` without a browser port,
so a background poll uses the system browser port even when the hosting call passed `NO_OPEN_BROWSER_PORT`.
`conversationFor` receives the hosting call's `BrowserPort`, and the refresh passes it on. The new test needs this.

Set aside: making only the refresh not await hosting. An opening started by MCP `status` still waits for the Plan
server to drain, and a poll can join that opening.

### #6 Approve & Run in Attached Plan review

`PlanReviewSurface.tsx` overrides the Attached labels to "Approve & Ready" and says "Execution handoff is a later
Preview step", but the primary button submits `run`, and the coordinator starts execution. The Connect PRD and the
Claude guide already say Approve & Run. The fix removes the override, so the default **Approve & Run** / **Run** labels
apply. Approve for Later stays in the split menu.

The Attached outcome copy then follows what was submitted:

- `approved-run` — "Approved & Run" / "Claude starts implementation in a RunWield worktree."
- `approved-later` — "Approved for later" / "The Plan is Ready For Work. /runwield:implement starts it."
- `feedback` — unchanged ("Claude can retrieve your feedback…").

### #7 Reject non-Claude hosts

`assessCompatibility` never reads `evidence.host`. The fix compares it with `CLAUDE_COMPATIBILITY_MATRIX.host`
(`"claude-code"`) before any other check:

```diff
 export function assessCompatibility(evidence) {
+    if (evidence.host !== matrix.host)
+        return { status: "unsupported_host", message: "RunWield Connect supports Claude Code only. <host> is not a supported External Agent Host." }
     if (!matrix.supportedAdapterContracts.includes(evidence.adapterContract)) ...
```

`runAttachedOperation` rejects `unsupported_host` with the same rejection path as `incompatible_adapter`, and
`AttachedRejectionCode` gains `"unsupported_host"`. Status stays readable, as for a stale adapter.

> [!NOTE]
> **Claude Code reports `claude-code`**
>
> The Claude Code 2.1.303 binary constructs its MCP client as `{name:"claude-code",title:"Claude Code",…}`, and
> `mcp.ts` already defaults to `"claude-code"`. The fix does not reject the tested host.

### #8 Skills in Attached role instructions

`resolveAttachedRoleInstructions` returns the role prompt, the tool-name map, and addenda. Core Sessions also expand
`{{SKILLS}}` from `listSkills({ cwd })` (`session.js` ~1705). Attached never does, so Claude roles see "Check Skills"
with no catalog, and `.wld/skills` or home overrides never apply.

The fix moves the catalog rule into `skill-catalog.ts` so both runtimes use one rule:

```ts
/** Visible Skills for one Project, each with its catalog line. */
export async function listVisibleSkillCatalog(cwd: string): Promise<{ skill: SkillRecord; line: string }[]>;
// filter: name && description && !disableModelInvocation
// line:   `- ${name} - ${description} (read: ${path})`
```

- `session.js` uses it for `{{SKILLS}}` and its context projection items. Its output does not change.
- `resolveAttachedRoleInstructions` adds a `## Skills` section with a short Claude preamble ("Use Claude Code's Read
  tool to load a Skill's file when the task matches its description. Use the exact path shown.") and the catalog lines
  when the role's Core `systemPrompt` contains `{{SKILLS}}`, the same rule `session.js` uses. The reviewer gets none,
  as in Core (`validation-prompts.test.ts`). When the catalog is empty, the section is left out.
- Nothing is installed in the plugin. The catalog is resolved on every response, as role instructions are, so the
  separate `runwield-skills` plugin stays separate.

> **Question (attached-skill-catalog):** How should Claude-hosted roles get RunWield Skills?
>
> **Answer:** Recommended: list the effective RunWield Skill catalog (names, descriptions, paths) in each role's run-time instructions; nothing ships in the plugin (answered in review)

Cost of the recommendation: about 1.8K more tokens per role-instructions fetch (Engineer today has 19 Skills).

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/validation-scope.ts` — `candidateIdentity` next to the Plan-document rule (#3).
- `src/shared/workflow/validation-checkpoint.ts` — `ValidationCheckpoint.candidateIdentity` (#3).
- `src/shared/workflow/validation-semantic.ts` — record the identity at each `semantic_review_passed` (#3).
- `src/shared/workflow/publication-revalidation.ts` — reset a `reviewed` Plan whose candidate changed (#3).
- `src/shared/workflow/validation-engine.ts` — treat that reset like the existing publication revalidation (#3).
- `src/shared/attached/review-host.ts` — detached Plan surface stop, shutdown waits for it, browser port reaches the
  refresh (#5).
- `src/ui/workspace/react/PlanReviewSurface.tsx` — default approval labels and run/later outcome copy (#6).
- `src/shared/attached/compatibility.ts`, `operations.ts`, `coordinator.ts` — `unsupported_host` (#7).
- `src/shared/session/skill-catalog.ts`, `session.js`, `src/shared/attached/role-instructions.ts` — one Skill catalog
  rule for both runtimes (#8).
- `src/attached/claude/plugin/commands/*.md` — the compatibility stop line names `unsupported_host` too (#7).
- `docs/prd/runwield-core-prd.md`, `docs/prd/runwield-connect-prd.md`, `docs/adr/014-attached-workflow-coordination-boundary.md`,
  `docs/user-documentation/connect-claude-code.md` — delivered behavior.
- Tests named in the Verification Plan.

Out of scope: findings #1, #2, #4; the stale code-review action that `start_validation` returns while a decision is
pending (it cannot publish, because the approval is rejected). `docs/domain-language.md` needs no change; no term is
added or redefined.

## Reuse Opportunities

- `preparePublicationRevalidation` reset body and `PUBLICATION_REVALIDATION_MESSAGE` handling in
  `validation-engine.ts` (#3).
- `getWorktreeReviewDiff` (`git-snapshot.ts`), `extractDiffPaths` and `isPlanDocumentPath` (`validation-scope.ts`) (#3).
- The detached stop at `review-host.ts` ~169 and its test "a Core-advanced browser reload returns its position without
  waiting on its own shutdown" (#5).
- `attachedValidationFixture`, `toDelivery`, `approveSemantic`, `fixture.ciCount()` in the Attached delivery tests
  (#3, #5).
- `NO_OPEN_BROWSER_PORT` (`browser-port.ts`) (#5).
- `listSkills` (`skill-catalog.ts`) (#8).

## Implementation Steps

### Changed candidate revalidation (#3)

- `validation-scope.ts` exports `candidateIdentity(diffText, planName)`. It returns a SHA-256 hex digest of the diff
  with every file section whose path is a Plan document removed. Two diffs that differ only in `docs/plans/**/*.md`
  give the same identity; a change to any other file gives a different identity.
- `ValidationCheckpoint` has an optional `candidateIdentity: string`. Every `semantic_review_passed` record in
  `validation-semantic.ts` (the reviewed pass and each skip site) stores the identity of
  `getWorktreeReviewDiff(executionCwd, worktreeBaseBranch)` at that time. Non-Git in-place execution stores none.
- `preparePublicationRevalidation` (or a sibling exported from `publication-revalidation.ts` and called at the same
  point in `validation-engine.ts`) resets the Plan when all are true: no publication attempt, Plan status `reviewed`,
  the checkpoint has `candidateIdentity`, and the current identity differs. The reset sets status `implemented`,
  `humanReviewDecision: null`, review rounds 0, clears the checkpoint, and runs under the Plan lock before phase
  selection.
- The engine handles that reset as it handles the existing publication revalidation: the session workflow resets and
  the user sees a revalidation message that says the code changed after review.
- A checkpoint without `candidateIdentity` keeps today's behavior.
- The Core Code Review page and the Attached code-review page still bind approval to the shown diff; that check is
  unchanged.

### Plan polling handover (#5)

- `ensureCodeReviewHosted` does not await the old Plan surface's stop. The stop promise is kept in a module-level set
  and its rejection is caught. The site at `review-host.ts` ~169 uses the same helper.
- `stopHostedAttachedReviews` waits for pending openings, then for the detached stops, then stops the hosted surfaces.
  It resolves after every review server has stopped.
- `conversationFor` receives the `BrowserPort` of the hosting call, and `conversation.refresh` passes it to
  `ensureReviewHosted`.

### Approve & Run (#6)

- In Attached Plan review (`reviewRevisionUrl` set), the primary approval button reads **Approve & Run** (mobile
  **Run**) and submits `run`. The split menu still offers **Approve for Later**.
- No Attached copy contains "Approve & Ready" or "later Preview step".
- After `approved-run`, the outcome title is "Approved & Run" and the subtitle says Claude starts implementation in a
  RunWield worktree. After `approved-later`, the title is "Approved for later" and the subtitle says the Plan is Ready
  For Work and `/runwield:implement` starts it.

### Host check (#7)

- `CompatibilityAssessment.status` and `AttachedRejectionCode` include `"unsupported_host"`.
- `assessCompatibility` returns `unsupported_host` when `evidence.host !== CLAUDE_COMPATIBILITY_MATRIX.host`, before
  the adapter-contract and version checks. The message names the reported host and says Connect supports Claude Code
  only.
- `runAttachedOperation` rejects `unsupported_host` before dispatch, with no record, Plan, or worktree change. `status`
  stays readable.
- The plugin command files that stop on `incompatible_adapter` or `unsupported_host_version` also stop on
  `unsupported_host`.

### Skill catalog (#8)

- `skill-catalog.ts` exports `listVisibleSkillCatalog(cwd)`. It owns the visibility filter and the catalog line
  format. `session.js` uses it to fill `{{SKILLS}}` and build its context projection items; Core prompt text is
  unchanged.
- `resolveAttachedRoleInstructions(projectRoot, role)` includes a `## Skills` section, with the Claude preamble and
  one catalog line per visible Skill for `projectRoot`, exactly when the loaded agent's `systemPrompt` contains
  `{{SKILLS}}`. No role list is hard-coded. A `.wld/skills/<name>/SKILL.md` in the project replaces the bundled Skill of
  the same name in the next response.
- `reviewer` instructions contain no Skills section.
- No Skill file is added to `src/attached/claude/plugin`.

### Documentation

- [Core PRD](../../prd/runwield-core-prd.md#semantic-review-and-repair), **Saved Attached Code Review** scenarios, gain
  **Changed candidate re-verification**: given a reviewed candidate that changes before approval, the next validation
  run reruns Mechanical Validation, CI, and Semantic Review before a new Code Review. The **Bind saved human approval**
  requirement says this applies to Core and Attached. The Code Review "close and come back later" paragraph says changed
  code is validated again.
- [Connect PRD](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability): a host other than Claude
  Code rejects before dispatch with `unsupported_host`; an acceptance scenario says so.
- [Connect PRD](../../prd/runwield-connect-prd.md#host-owned-reasoning) and ADR-014's run-time role instructions
  paragraph: each role response (except the independent reviewer) carries the effective Skill catalog with paths,
  resolved from project, home, external, and bundled Skills; the plugin still ships no Skills.
- `docs/user-documentation/connect-claude-code.md`: Skill overrides in `.wld/skills` apply to Claude roles; only Claude
  Code is a supported host.

## Verification Plan

Run focused tests with `bun scripts/run-tests.js <paths>`. RunWield runs the full `bun run ci` after implementation.

Each new or changed test below fails on the current Epic branch:

- **#3 Attached** — `src/shared/attached/delivery.test.ts`, the test at ~182–203 (code changed during the human-review
  wait). After the rejected approval, `start_validation` returns `nextAction.kind === "validation"` with
  `request.kind === "reviewer"`, and `fixture.ciCount()` is 2. After `approveSemantic`, a new `code_review` diff contains
  `value = 9`. Today it returns `code_review` directly with one CI run.
- **#3 Core** — `src/shared/workflow/validation-loop-human-review.test.js`: Semantic Review passes, the user stops at
  Code Review, a non-Plan file is edited, and `runValidationLoop` runs again. CI runs again, Semantic Review is
  requested, and the Plan leaves `reviewed` before the new Code Review.
- **#3 owner** — `src/shared/workflow/publication-revalidation.test.ts`: a `reviewed` Plan with no publication attempt
  and a changed candidate resets to `implemented` with a cleared checkpoint. A change only to the Plan document does not
  reset. A checkpoint without `candidateIdentity` does not reset.
- **#5** — `src/shared/attached/review-host.test.ts`, new test "Plan polling during the code-review transition does not
  block hosting or shutdown": host a Plan round with `NO_OPEN_BROWSER_PORT`, advance the same workflow to
  `code_review`, send a Plan conversation GET, and call `ensureReviewHosted` while that GET is in flight. Both resolve
  within 5 seconds, the GET returns 200, and the review URL is a code-review URL. `stopHostedAttachedReviews()` then
  resolves within 5 seconds and both ports refuse connections. Today the GET and hosting time out. Extend the fixture to
  pass through a Plan review round, or seed one with `writeAttachedWorkflowRecord`.
- **#6** — `src/ui/workspace/react/plan-review-saved-conversation.test.tsx` (~106) clicks **Approve & Run**, expects a
  `run` decision, and expects "Approved & Run". A second case clicks **Approve for Later** and expects "Approved for
  later" and a `later` decision. No rendered text contains "Approve & Ready".
- **#7** — `src/shared/attached/compatibility.test.ts`: `{ host: "codex", hostVersion: "2.1.303", adapterContract: 1 }`
  returns `unsupported_host`; `claude-code` with the same values returns `compatible`. In `coordinator.test.ts`,
  `activate` with `host: "codex"` rejects with `unsupported_host` and writes no workflow record.
- **#8** — `src/shared/attached/role-instructions.test.ts`: in a project with `.wld/skills/diagnose/SKILL.md` (name
  `diagnose`, a test description), Engineer and Planner instructions contain a `## Skills` section with the project
  description and project path for `diagnose`, and not the bundled `diagnose` path. Reviewer instructions contain no
  Skills section. In `skill-catalog.test.ts`, `listVisibleSkillCatalog` omits a `disable-model-invocation: true` Skill.

Existing coverage:

- **Must still pass unchanged:** `session-prompt.test.js` and `session-catalog.test.js` (Core `{{SKILLS}}` output),
  `validation-prompts.test.ts` (reviewer has no Skills), `review-host.test.ts` existing cases (Core-advanced reload),
  `mcp-review-recovery.test.ts`, `mcp-shutdown.test.ts`, `delivery-review.test.ts`, `code-review-chat.test.ts`,
  `validation-loop-delivery.test.js`, `validation-host-turn-decisions.test.ts`, `validation-review-cancellation.test.ts`,
  the rest of `delivery.test.ts` (including the canceled code review test), `execution-plugin.test.ts`, and
  `publication-revalidation.test.ts` existing cases.
- **Expected to change:** the `delivery.test.ts` changed-code test now expects CI and Semantic Review again (rewrite,
  do not delete). `plan-review-saved-conversation.test.tsx` clicks "Approve & Run" instead of "Approve & Ready".
- **Behavior that stops:** changed code going straight from a stale review to a new human review; the "Approve & Ready"
  label; `compatible` status for a non-Claude host.

Documentation check: the Core PRD, Connect PRD, ADR-014, and Claude guide describe the delivered behavior for #3, #7,
and #8 and still say Connect adds no hooks or tool restrictions.

## Edge Cases & Considerations

- **Plan front matter in the diff:** validation writes Plan status and checkpoints. The identity excludes all
  `docs/plans/**/*.md` paths, so these writes never trigger a reset loop.
- **Old checkpoints (assumption, reviewable):** a `reviewed` Plan saved before this change has no identity and keeps
  today's behavior. It avoids an unexpected rerun for Plans in flight; the cost is that such a Plan keeps the old gap
  until its next Semantic Review.
- **Human Feedback repair:** feedback already records `validation_failed`, which clears the checkpoint and reruns CI;
  the skip site then records the repaired candidate. Its behavior is unchanged.
- **Edits between CI and Semantic Review:** out of scope. In Attached, the reviewer request is built in the same Core
  call as CI, and the reviewer resume is bound to its diff.
- **Detached Plan stop failure:** the rejection is caught; the server already reports it. Shutdown still waits for the
  stop to settle.
- **Skill catalog size:** about 1.8K tokens per role fetch. The lazy catalog draft (`docs/plans/lazy-skill-catalog-retrieval.md`)
  would shrink both runtimes through the same `listVisibleSkillCatalog` rule.
- **Re-raised findings:** #1, #2, and #4 can return on the next gate run until the separate gate fixes land.
