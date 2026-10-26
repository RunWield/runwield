diffstat only, patch not produced. Full patch: git show -p <rev>
---

planId: "e3db158c-4efc-4368-9545-3b3409ef367e"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths: - "src/shared/workflow/git-snapshot.ts" - "src/shared/workflow/review-diff-tool.js" - "src/shared/workflow/validation-semantic.ts" - "src/shared/workflow/epic-integration.ts" - "src/shared/worktree.js" - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-25"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "1c96d22d44af1fce2b004a43ca8dc5f104de9316"
workRecord:
status: "generated"
recordId: "8ba6e378-6e59-41f9-a43f-e245b5450e8b"
path: "docs/work-records/2026-10-26-stable-review-diffs-and-unreadable-patch-rejection.md"
lastAttemptAt: "2026-10-26T03:41:11.572Z"
status: "verified"
---

# Review diffs do not depend on the user's Git settings

## Context

AI review can approve a non-empty change without reading any of it. The cause is the user's Git configuration.
All Core review diffs come from `src/shared/workflow/git-snapshot.ts`:

- `diffTrees` runs `git diff <base>..<current>` with no format flags.
- `getWorkflowDiff` without a baseline runs a bare `git diff`.
  User settings change that output. A test against Git 2.55 confirms each row:
    | Setting                                                                                                                                                                                                                                                                                                                                                                                   | Effect on output                | Override                          |
    | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------- |
    | `diff.noprefix`, `diff.mnemonicPrefix`                                                                                                                                                                                                                                                                                                                                                    | no `a/`/`b/`, or `i/`/`w/`/`c/` | `--src-prefix=a/ --dst-prefix=b/` |
    | `diff.srcPrefix`, `diff.dstPrefix`                                                                                                                                                                                                                                                                                                                                                        | custom prefixes                 | same                              |
    | `color.ui`/`color.diff` set to `always`                                                                                                                                                                                                                                                                                                                                                   | color codes before `diff --git` | `--no-color`                      |
    | `diff.external`, `GIT_EXTERNAL_DIFF`                                                                                                                                                                                                                                                                                                                                                      | any output format               | `--no-ext-diff`                   |
    | `diff.relative`                                                                                                                                                                                                                                                                                                                                                                           | paths relative to a subfolder   | `--no-relative`                   |
    | `parseDiffFiles` (`src/shared/workflow/review-diff-tool.js:31`) accepts only `a/`/`b/` headers, so such a diff parses to zero files. Then `runReviewerRound` (`validation-semantic.ts:517`) builds a `ReviewInspection` with no required files. `inspection.feedback()` is empty, the `review_diff` tool lists zero files, and `review_complete` approval is accepted with no bytes read. |
    | `hasImplementationDiff` (`validation-scope.ts:40`) deliberately treats an unparseable non-empty diff as implementation work. So validation enters review with the bad diff, and review is where the gap opens.                                                                                                                                                                            |
    | This breaks two requirements in [Semantic review and repair](../../prd/runwield-core-prd.md#semantic-review-and-repair):                                                                                                                                                                                                                                                                  |
    | ... more lines (truncated by snip)                                                                                                                                                                                                                                                                                                                                                        |
