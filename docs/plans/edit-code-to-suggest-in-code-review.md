---
planId: "14000720-5bc1-4921-97ea-eaea9faf18a1"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/git-snapshot.ts"
    - "src/ui/workspace/routes/api/review-file-handlers.ts"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/server/session-continuation.js"
    - "src/ui/workspace/react/CodeReviewSurface.tsx"
    - "src/ui/workspace/react/PlanReviewSettings.tsx"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-11"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "plan/edit-code-to-suggest-in-code-review"
validatedCommit: "25f24a82a46a0d09b9fd58f4310207b54462e2e8"
workRecord:
    status: "generated"
    recordId: "60dc16d7-b2a5-43d0-a3a6-9b0883708c69"
    path: "docs/work-records/2026-10-16-edit-to-suggest-in-code-review.md"
    lastAttemptAt: "2026-10-16T03:41:18.220Z"
status: "verified"
---

# Edit Code to Suggest in Code Review

## Context

The user wants the Plannotator "Edit code to suggest" feature in RunWield Code Review. The reviewer clicks **Edit** on a
file in the all-files diff, types the change directly in the diff, and clicks **Suggest**. The net changes become
ordinary suggestion annotations in the review feedback. The browser never writes files. The agent applies the
suggestions when it repairs from the feedback.

The feature is experimental and off by default. The user turns it on with a setting. The user decided:

- **No announcement dialog.** Do not show `EditModeAnnouncementDialog` or any first-run prompt. Only the setting.
- **Both review screens.** The standalone review page (opened from the terminal) and the Workspace in-Session review
  page both get the feature.
- **Fix the Workspace file reader.** The Workspace review page must read files from the execution worktree, not the
  primary checkout.

### What exists today

Most of the feature is already in the vendored Plannotator code:

```text
third_party/plannotator/packages/review-editor/
├── components/AllFilesCodeView.tsx   # Edit button, edit toolbar; props enableEditSuggestions,
│                                     #   onAddSuggestionsForFile, onAddEditorCommentForFile
├── edit/useEditSession.ts            # one-file edit session; turns edits into SuggestionHunk[]
├── App.tsx                           # upstream handlers that turn hunks into annotations (reference only)
└── utils/exportFeedback.ts           # exports suggestedCode / selectedTextFromEdits into feedback
third_party/plannotator/packages/ui/config/settings.ts   # `editSuggestions` setting, default false
```

`CodeReviewSurface` already renders `AllFilesCodeView`, but it does not pass the three edit props. So Edit never shows.

### The blocking gap

The editor opens only when it has the full **before** and **after** text of the file. `useEditSession.ensureFullContent`
fetches `/api/file-content` and builds a full diff from both texts. Pierre throws on a partial diff, so without the
before text the session refuses with "Full file content unavailable".

Our `reviewFileContentApi` (`src/ui/workspace/routes/api/review-file-handlers.ts`) always returns `oldContent: null`.
Its comment says the baseline "is intentionally not guessed". That was correct: no shared owner exposed the baseline.
This Plan adds that owner.

The two hosts also differ in which checkout they read:

| Review screen             | Route                                                          | Reads files from                    | Knows the target branch?          |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------- | --------------------------------- |
| Standalone review page    | `createReviewServer` handler in `src/ui/workspace/server.js`   | execution worktree (`cwd`)          | yes, `reviewPayload.targetBranch` |
| Workspace in-Session page | `ownerInSituReviewFileContent` in `src/ui/workspace/server.js` | **primary checkout** (project root) | no                                |

The Workspace row is a bug today: "expand unchanged lines" can show text from the wrong copy of the file. With editing
on, a suggestion could be built from the wrong file. The session continuation service already stores the worktree path
and target branch for each live review in `codeReviewRefreshContexts`.

### PRD

The owning capability is [Core: Semantic review and repair](../prd/runwield-core-prd.md#semantic-review-and-repair). It
covers Code Review.

- **Preserved:** "Requirement: Use one proposed branch patch." It says one shared comparison owner produces the patch
  and review interfaces must not create another Git comparison. The before text must come from that same owner.
- **Preserved:** human feedback and annotations survive the repair handoff.
- **Added:** a named requirement for suggesting code by editing the diff, with acceptance scenarios. See Implementation
  Steps.

No domain-language change. "Suggestion" here is the existing Plannotator term for reviewer-proposed code. The glossary
avoids "suggestion" only as an alias for Review Issue, which this Plan does not touch.

## Objective

When the setting is on, a reviewer on either review screen can edit a modified or added file in the all-files diff and
turn the edits into suggestion annotations that reach the repair agent in the feedback. When the setting is off, nothing
changes.

To make that possible, `/api/file-content` returns the correct before text on both screens, read from the execution
worktree's merge-base with the target branch.

## Approach

### 1. One owner for the review base

Split the base calculation out of `getWorktreeReviewDiff` so the diff and the file reader use the same function:

```diff
 src/shared/workflow/git-snapshot.ts
+resolveWorktreeReviewBaseTree(cwd, targetBranch) -> tree id
+    # target commit, HEAD, merge-base, ^{tree}; same errors as today
+readWorktreeReviewBaseFile(cwd, targetBranch, path) -> string | null
+    # contents of path in that tree; null when the path is not in the tree
 getWorktreeReviewDiff(cwd, targetBranch)
-    # inline target / HEAD / merge-base / tree logic
+    baseTree = resolveWorktreeReviewBaseTree(cwd, targetBranch)
     diffTrees(cwd, baseTree, captureWorktreeTree(cwd))
```

> [!TIP]
> **Why the file reader must not compute its own base**
>
> If the file reader used a different base (for example the execution baseline tree or `main`), the before text would
> not match the diff. `isContentConsistentWithPatch` would then refuse the edit, or worse, accept text from the wrong
> revision. The Core PRD requires one comparison owner.

### 2. `/api/file-content` returns the before text

`reviewFileContentApi` gets an optional `targetBranch` option:

```text
reviewFileContentApi(request, { cwd, targetBranch })
  validate path / oldPath  (unchanged)
  newContent = current worktree file   (unchanged)
  if targetBranch
    base = readWorktreeReviewBaseFile(cwd, targetBranch, oldPath || path)
    oldContent = base ?? (newContent != null ? "" : null)   # added file -> ""
    on WorktreeReviewTargetError / WorktreeReviewComparisonError -> oldContent = null
  else
    oldContent = null                                        # unchanged behavior
```

A comparison failure must not break the response. The after text still returns, so "expand unchanged lines" keeps
working, and Edit shows its existing "Full file content unavailable" reason.

### 3. Each host passes the right checkout and target

```text
standalone:  /api/file-content -> reviewFileContentApi(request, { cwd, targetBranch: reviewPayload.targetBranch })

workspace:   /api/file-content -> ownerInSituReviewFileContent
               referer = /projects/<p>/sessions/<s>/review/code?operation=<o>&interaction=<i>
               checkout = sessionContinuation.getLiveCodeReviewCheckout({ p, s, o, i })
               if checkout -> reviewFileContentApi(request, checkout)          # { cwd, targetBranch }
               else        -> reviewFileContentApi(request, { cwd: projectRoot })  # today's behavior
```

`getLiveCodeReviewCheckout` applies the same liveness checks as `getLiveCodeReview` (running operation, matching
project, Session, and live interaction of type `code_review`). It returns the stored refresh context or `null`. It does
not expose the worktree path to the browser.

### 4. Wire the editor into `CodeReviewSurface`

- Read `useConfigValue("editSuggestions")`.
- Pass `enableEditSuggestions`, `onAddSuggestionsForFile`, and `onAddEditorCommentForFile` to the **retained all-files**
  `AllFilesCodeView` only.
- Do not pass them to the Guided Review explainer's `DiffRenderer`. Upstream excludes Guided Review because it unmounts
  editors while the reviewer scrolls.

The two handlers live in a small new module so the annotation shape is tested directly. They follow upstream
`handleAddSuggestionsForFile` / `handleAddEditorCommentForFile` in `App.tsx`, adapted to our annotation records
(`crypto.randomUUID()` ids, `createdAt`, no `withPRContext` or `author`).

### 5. The setting

Add an "Edit code to suggest" switch, labeled experimental, to the **Display** tab of `PlanReviewSettings` in
`mode="code"` only. It reads and writes `configStore` key `editSuggestions`.

The earlier idea of a new "Editor" tab came from the dialog text. Without the dialog it adds a tab for one switch, so
the Display tab is the smaller choice.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/git-snapshot.ts` — extract the review base tree; add the base-file reader.
- `src/shared/workflow/git-snapshot.test.ts` — base-file reader tests next to the existing `getWorktreeReviewDiff`
  fixtures.
- `src/ui/workspace/routes/api/review-file-handlers.ts` — `targetBranch` option; return `oldContent`; update the
  "intentionally not guessed" comment.
- `src/ui/workspace/routes/api/review-file-handlers.test.ts` (new) — handler behavior against a real Git fixture.
- `src/ui/workspace/server.js` — standalone route passes `targetBranch`; in-situ route resolves the live review checkout
  from the referer.
- `src/ui/workspace/server/session-continuation.js` — `getLiveCodeReviewCheckout`.
- `src/ui/workspace/workspace-code-review.integration.test.ts` — in-situ file content reads the execution worktree.
- `src/ui/workspace/workspace-review.test.js` — standalone `/api/file-content` returns the merge-base before text.
- `src/ui/workspace/react/code-review-edit-suggestions.ts` (new) and its test — hunk and selection-comment to annotation
  conversion.
- `src/ui/workspace/react/CodeReviewSurface.tsx` — pass the edit props to the all-files view only.
- `src/ui/workspace/react/PlanReviewSettings.tsx` — the code-mode Display switch.
- `docs/prd/runwield-core-prd.md` — new named requirement and scenarios under Semantic review and repair.

Deliberately left out:

- `third_party/plannotator/**` — no vendored changes. The dialog and its `needsEditModeAnnouncement` helpers stay
  unused.
- `src/ui/workspace/pages/api/file-content.ts` — the Astro dev route has no review context; it keeps returning
  `oldContent: null`.
- `docs/design-system.md` — the switch uses the existing settings switch pattern; no new visual pattern.

## Reuse Opportunities

- `getWorktreeReviewDiff` internals in `src/shared/workflow/git-snapshot.ts` — the target, HEAD, and merge-base
  resolution and its error types become `resolveWorktreeReviewBaseTree`.
- `runGit` and `isMissingRevisionError` in `git-snapshot.ts` — for reading the blob.
- `hasSafeCandidate` / `stripLineReference` in `review-file-handlers.ts` — existing path validation also guards the
  base-file path.
- `getLiveCodeReview` in `session-continuation.js` — its liveness checks; share them instead of copying.
- `ownerReviewProjectId` in `server.js` — referer parsing; extend it to also return Session, operation, and interaction.
- Upstream `handleAddSuggestionsForFile` / `handleAddEditorCommentForFile` in
  `third_party/plannotator/packages/review-editor/App.tsx` — the annotation shape, including the "remove these lines"
  text for an emptied suggestion.
- Existing settings switches in `PlanReviewSettings.tsx` (`CodeDisplaySettings`) — the switch markup.
- `defineGitFixture` (`src/shared/git-test-fixture.ts`) — real Git repositories for the server tests.

## Implementation Steps

1. `src/shared/workflow/git-snapshot.ts` exports `resolveWorktreeReviewBaseTree(cwd, targetBranch)`. It returns the tree
   id of the merge-base of `refs/heads/<targetBranch>` and execution `HEAD`. It throws the same
   `WorktreeReviewTargetError` and `WorktreeReviewComparisonError` cases that `getWorktreeReviewDiff` throws today.
   `getWorktreeReviewDiff` calls it and contains no merge-base logic of its own.
2. `git-snapshot.ts` exports `readWorktreeReviewBaseFile(cwd, targetBranch, path)`. It returns the file text at `path`
   in the tree from `resolveWorktreeReviewBaseTree`, or `null` when the path is not in that tree. It does not read the
   working tree, the execution baseline tree, or any other branch.
3. `src/shared/workflow/git-snapshot.test.ts` proves, with real repositories:
    - a modified file returns the merge-base text, not target-branch text added after the merge-base (reuse the "excludes
      target work imported after the execution baseline" setup);
    - a file added only in the worktree returns `null`;
    - a missing target branch rejects with `WorktreeReviewTargetError`.
4. `reviewFileContentApi` accepts `options.targetBranch`. With a target branch it returns:
    - `oldContent` equal to the merge-base text for a modified file, using `oldPath` when present (renames);
    - `oldContent: ""` for a file absent from the base that exists in the worktree;
    - `oldContent: null` when the comparison fails, with `newContent` still set.

    Without a target branch, `oldContent` stays `null`. The base-file path passes the same path safety checks as the
    worktree path. The response field names and status codes are unchanged. The function comment no longer says the
    baseline is not guessed.

5. `src/ui/workspace/routes/api/review-file-handlers.test.ts` covers each case in step 4 against a `defineGitFixture`
   repository. It also covers a `..` path returning 403. The modified-file test fails if `oldContent` is `null` or
   equals `newContent`.
6. The standalone review server's `/api/file-content` handler in `src/ui/workspace/server.js` passes
   `targetBranch: reviewPayload.targetBranch` when it is a string. The token check is unchanged.
7. `src/ui/workspace/server/session-continuation.js` exports
   `getLiveCodeReviewCheckout({ projectId,
runwieldSessionId, operationId, interactionId })`. It returns
   `{ cwd, targetBranch }` from `codeReviewRefreshContexts` only when the same liveness checks as `getLiveCodeReview`
   pass, and `null` otherwise. Both methods share one liveness check.
8. `ownerInSituReviewFileContent` in `src/ui/workspace/server.js` reads the Session, `operation`, and `interaction` from
   a referer of the form `/projects/<p>/sessions/<s>/review/code?operation=…&interaction=…`. When
   `ctx.state.sessionContinuation.getLiveCodeReviewCheckout` returns a checkout, it calls `reviewFileContentApi` with
   that `cwd` and `targetBranch`. In every other case it keeps today's project-root behavior.
9. `src/ui/workspace/workspace-code-review.integration.test.ts` has a test with a live code-review interaction whose
   execution worktree and primary checkout hold different text for the same file. The in-situ `/api/file-content`
   response returns the worktree text as `newContent` and the merge-base text as `oldContent`. The test fails if the
   route reads the project root.
10. `src/ui/workspace/workspace-review.test.js` has a test that the standalone review server's `/api/file-content`
    returns the merge-base `oldContent` for a modified file in a review with a `targetBranch`.
11. `src/ui/workspace/react/code-review-edit-suggestions.ts` exports:
    - `editHunksToAnnotations(filePath, hunks)` — one `type: "comment"`, `scope: "line"`, `side: "new"` annotation per
      hunk, carrying `lineStart`, `lineEnd`, `suggestedCode`, and `originalCode`. An empty `suggestedCode` becomes
      `text: "Suggested change: remove these lines."` with no `suggestedCode`. An empty `originalCode` is omitted.
    - `editorCommentToAnnotation(filePath, comment)` — a line comment with trimmed `text`, `selectedText`, and
      `selectedTextFromEdits: true` when `comment.exact` is false. It returns `null` for blank text.
12. A test for that module proves the shapes in step 11. It also proves that `exportReviewFeedback` output for an
    `editHunksToAnnotations` result contains the suggested code block for that file and line range.
13. `CodeReviewSurface.tsx` passes `enableEditSuggestions` (from `useConfigValue("editSuggestions") === true`),
    `onAddSuggestionsForFile`, and `onAddEditorCommentForFile` to the retained all-files `AllFilesCodeView`. The
    handlers append the step 11 annotations to `annotations`. The Guided Review explainer's `diffProps` do not include
    these props. Nothing imports `EditModeAnnouncementDialog` or `editModeAnnouncement`.
14. `PlanReviewSettings.tsx` shows an "Edit code to suggest" switch, marked experimental, in the Display tab only when
    `mode === "code"`. It reflects and sets `configStore` key `editSuggestions`. Plan review settings do not show it.
15. `docs/prd/runwield-core-prd.md#semantic-review-and-repair` has a named requirement, "Suggest code by editing the
    diff", stating: off by default and changed in Code Review settings; Edit is offered in the all-files diff on both
    the standalone and Workspace review pages, one file at a time, and not in Guided Review; finished edits become
    suggestion annotations in the feedback; the browser never writes project files; the before text comes from the
    shared proposed-branch comparison. The section's acceptance scenarios include the scenarios in the Verification Plan
    below.

## Verification Plan

### Automated

- `deno run -A scripts/run-tests.js src/shared/workflow/git-snapshot.test.ts`
- `deno run -A scripts/run-tests.js src/ui/workspace/routes/api/review-file-handlers.test.ts`
- `deno run -A scripts/run-tests.js src/ui/workspace/workspace-code-review.integration.test.ts`
- `deno run -A scripts/run-tests.js src/ui/workspace/workspace-review.test.js`
- `deno run -A scripts/run-tests.js src/ui/workspace/react/code-review-edit-suggestions.test.ts`
- `deno task seams:check` — no new injection seam. The server tests use real Git fixtures.

The tests that prove the objective, not only "nothing broke":

- Step 5's modified-file case fails if the handler still returns `oldContent: null`.
- Step 9 fails if the Workspace route still reads the primary checkout.
- Step 12 fails if the handlers drop `suggestedCode` or the export omits it.

### Must still be protected

- All existing `getWorktreeReviewDiff` tests in `git-snapshot.test.ts` pass unchanged. The extraction must not change
  the patch.
- `workspace-code-review.integration.test.ts` "reload reads the latest proposed branch patch" passes unchanged.
- `/api/file-content` still requires the review token on the standalone server and still returns 403 for unsafe paths.
- No existing behavior is expected to stop existing.

### Manual (headed browser)

Use a real Plan that reaches Code Review in a Git worktree, with at least one modified file and one added file.

1. **Setting off (default).** Open the standalone review link from the terminal. No Edit control appears on any file. No
   announcement dialog appears.
2. **Turn it on.** Settings → Display. The "Edit code to suggest" switch is visible and marked experimental. Turn it on.
   Open Plan review settings and confirm the switch is not there.
3. **Edit a modified file.** In the all-files diff, click Edit on the modified file. The editor opens without "Full file
   content unavailable". Change one line, add one line, then click Suggest. Two suggestion annotations (or one per
   contiguous region) appear in the annotations sidebar with the suggested code.
4. **Annotate mid-edit.** Start another edit, select text in the editor, make an annotation, then click Discard. The
   comment annotation stays. The file text in the diff returns to its original state.
5. **Added file.** Click Edit on the added file. The editor opens. Suggest a change; it becomes an annotation.
6. **Guided Review.** Generate or open Guided Review. No Edit control appears in its diffs.
7. **Files untouched.** Run `git status` in the execution worktree. No file changed because of the edits.
8. **Feedback.** Send feedback. The repair Agent's received feedback contains the suggested code blocks for the edited
   file and lines.
9. **Workspace page.** Run the same flow from the Workspace Session's Code Review page. Before editing, make the primary
   checkout's copy of the edited file differ from the worktree copy. The editor shows the **worktree** text, and step 3
   behaves the same.

### Expected results

- Given the setting is off, when the reviewer opens Code Review, then no Edit control and no announcement dialog appear.
- Given the setting is on, when the reviewer edits a modified file and clicks Suggest, then each changed region becomes
  a suggestion annotation and the project files are unchanged.
- Given a Workspace in-Session Code Review whose worktree differs from the primary checkout, when the reviewer edits a
  file, then the editor shows the worktree text.
- Given the review target branch cannot be compared, when the reviewer clicks Edit, then the editor shows its
  unavailable reason and the diff still renders.
- The Core PRD names the new requirement and these scenarios. It does not claim behavior beyond what was delivered.

## Edge Cases & Considerations

- **Target branch moves during review.** Each file-content request recomputes the merge-base. If the target moved, the
  before text may not match the rendered patch. `isContentConsistentWithPatch` refuses with "File changed since the diff
  was captured". The reviewer reloads to get the current patch. Acceptable; no extra handling.
- **Review without a target branch** (non-worktree execution). `oldContent` stays `null`, so Edit shows its unavailable
  reason. This matches today. The Workspace fallback uses the project root, which is also the execution checkout in that
  case.
- **Deleted files.** `newContent` is `null`, so Edit is unavailable. There is nothing to edit.
- **Renames.** The base text is read from `oldPath`. The rename must still pass the path safety checks.
- **Referer missing or stripped.** The Workspace route falls back to today's behavior. Edit may then refuse on a
  mismatch, which is safe. Do not add a new query parameter to the vendored fetch for this.
- **Side effect: expand unchanged lines.** `AllFilesCodeView` also uses `oldContent` to expand context. Modified files
  now expand correctly on both screens. This is an improvement, not a regression.
- **Setting scope.** `editSuggestions` is stored per browser by the vendored config store, like the other Plannotator
  display settings. It is not a project or global `/settings` value. Reviewable assumption.
- **Switch placement.** The Display tab in code mode. Reviewable assumption; the dialog's "Settings → Editor" text no
  longer applies because the dialog is not used.
