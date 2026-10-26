---
planId: "e3db158c-4efc-4368-9545-3b3409ef367e"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/git-snapshot.ts"
    - "src/shared/workflow/review-diff-tool.js"
    - "src/shared/workflow/validation-semantic.ts"
    - "src/shared/workflow/epic-integration.ts"
    - "src/shared/worktree.js"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-25"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
status: "reviewed"
---

# Review diffs do not depend on the user's Git settings

## Context

AI review can approve a non-empty change without reading any of it. The cause is the user's Git configuration.

All Core review diffs come from `src/shared/workflow/git-snapshot.ts`:

- `diffTrees` runs `git diff <base>..<current>` with no format flags.
- `getWorkflowDiff` without a baseline runs a bare `git diff`.

User settings change that output. A test against Git 2.55 confirms each row:

| Setting                                 | Effect on output                | Override                          |
| --------------------------------------- | ------------------------------- | --------------------------------- |
| `diff.noprefix`, `diff.mnemonicPrefix`  | no `a/`/`b/`, or `i/`/`w/`/`c/` | `--src-prefix=a/ --dst-prefix=b/` |
| `diff.srcPrefix`, `diff.dstPrefix`      | custom prefixes                 | same                              |
| `color.ui`/`color.diff` set to `always` | color codes before `diff --git` | `--no-color`                      |
| `diff.external`, `GIT_EXTERNAL_DIFF`    | any output format               | `--no-ext-diff`                   |
| `diff.relative`                         | paths relative to a subfolder   | `--no-relative`                   |

`parseDiffFiles` (`src/shared/workflow/review-diff-tool.js:31`) accepts only `a/`/`b/` headers, so such a diff parses to zero files. Then `runReviewerRound` (`validation-semantic.ts:517`) builds a `ReviewInspection` with no required files. `inspection.feedback()` is empty, the `review_diff` tool lists zero files, and `review_complete` approval is accepted with no bytes read.

`hasImplementationDiff` (`validation-scope.ts:40`) deliberately treats an unparseable non-empty diff as implementation work. So validation enters review with the bad diff, and review is where the gap opens.

This breaks two requirements in [Semantic review and repair](../prd/runwield-core-prd.md#semantic-review-and-repair):

- **Read the change before deciding** — rounds must read the complete diff of every changed file.
- **Review one proposed branch patch** — the same patch supplies AI review, repair context, and Code Review. Workspace Code Review reads the same `getWorktreeReviewDiff` output (`src/ui/workspace/server.js:729`), so it also gets wrong headers today.

> [!NOTE]
> **The Connect Epic has a second consumer**
>
> Integration finding #7 of `attached-mode-claude-feature-preview` reports the same gap through the Epic's host-resume branch and `assertHostReviewerCandidate`. Those paths exist only on the Epic branch. This Plan fixes the shared Core owners on `main`; the Epic wires its host paths to `requiredReviewDiffFiles` after it merges `main`.

## Objective

Make every Core review diff use one fixed output format, whatever the user's Git settings. When a non-empty review diff still has no readable file headers, the review round fails with a clear reason before any Reviewer runs. It never approves.

## Approach

The fix has two parts, each with one owner.

**Producer: `git-snapshot.ts`.** One exported constant holds the format flags:

```ts
export const REVIEW_DIFF_FORMAT_ARGS = [
    "--no-color",
    "--no-ext-diff",
    "--no-relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
] as const;
```

```diff
 diffTrees(cwd, base, current)
-  git diff <base>..<current>
+  git diff ...REVIEW_DIFF_FORMAT_ARGS <base>..<current>
 getWorkflowDiff(cwd, undefined)
-  git diff
+  git diff ...REVIEW_DIFF_FORMAT_ARGS
 epic-integration.ts gate diff
-  git diff --no-color --no-ext-diff <base> <head>
+  git diff ...REVIEW_DIFF_FORMAT_ARGS <base> <head>
```

`getWorktreeReviewDiff`, the repair diff, Workspace Code Review, and plan recovery all reach Git through `diffTrees` or `getWorkflowDiff`, so they get the fix with no further edits. The bare `git diff` fallback in `getWorktreeStatus` (`src/shared/worktree.js:1044`) also uses the constant, so no review-adjacent path keeps a raw call.

With default settings the output is byte-identical (checked with `cmp`), so existing candidate identities and diff hashes do not change.

**Fail closed: `review-diff-tool.js`.** One new helper next to the parser:

```text
requiredReviewDiffFiles(text)
  if text is empty or whitespace  -> return []
  files = parseDiffFiles(text)
  if files is empty               -> throw ReviewDiffParseError
  return files
```

`runReviewerRound` calls it once, on the required scope (full diff in discovery, repair diff in verify), before it builds `ReviewInspection` and before any Reviewer session starts. It turns `ReviewDiffParseError` into `{ kind: "failed", reason }`. The existing caller at `validation-semantic.ts:278` already records `validation_failed` and returns a failed phase result for that shape.

> [!TIP]
> **Why `parseDiffFiles` itself does not throw**
>
> Guided review, standalone AI review, the `review_diff` tool, and the browser review also call `parseDiffFiles`. Those display paths need a soft empty result. Only the approval gate needs a hard failure, so the gate gets its own helper.

Set aside: making `parseDiffFiles` accept any prefix. It would hide color codes and external diff formats badly and would still not fail closed on the next unknown format.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/git-snapshot.ts` — owns `REVIEW_DIFF_FORMAT_ARGS`; `diffTrees` and baseline-less `getWorkflowDiff` use it.
- `src/shared/workflow/epic-integration.ts` — the integration gate diff (line 748) uses the constant instead of its partial flag list.
- `src/shared/worktree.js` — the bare `git diff` fallback in `getWorktreeStatus` uses the constant.
- `src/shared/workflow/review-diff-tool.js` — adds `ReviewDiffParseError` and `requiredReviewDiffFiles`; `parseDiffFiles` behavior is unchanged.
- `src/shared/workflow/validation-semantic.ts` — `runReviewerRound` gets its required file list from the helper and fails the round on a parse error.
- `src/shared/workflow/git-snapshot.test.ts`, `review-diff-tool.test.js`, `validation-loop-review.test.js` — regression tests below.
- `docs/prd/runwield-core-prd.md` — the Semantic review and repair capability gains the requirement and scenarios.

Deliberately out of scope: standalone `wld review` patches from a forge (`src/shared/standalone-review/`), which Git config on this machine does not produce.

## Reuse Opportunities

- `defineGitFixture` (`src/shared/git-test-fixture.ts`) — real repositories with repo-local `git config` for the setting matrix.
- The real-Git validation setup in `src/shared/workflow/validation-loop-review.test.js` (lines 42–66) — drives `runValidationLoop` through `getWorktreeReviewDiff`.
- The existing `{ kind: "failed"; reason }` branch of `runReviewerRound` and its caller — no new failure machinery.

## Implementation Steps

- `src/shared/workflow/git-snapshot.ts` exports `REVIEW_DIFF_FORMAT_ARGS` containing exactly `--no-color`, `--no-ext-diff`, `--no-relative`, `--src-prefix=a/`, and `--dst-prefix=b/`.
- `diffTrees` passes `REVIEW_DIFF_FORMAT_ARGS` to `git diff` before the tree range, and `getWorkflowDiff` passes it in its baseline-less `git diff` call.
- `src/shared/workflow/epic-integration.ts` builds its gate `diffText` with `REVIEW_DIFF_FORMAT_ARGS`; no review-diff producer in `src/shared` keeps its own copy of these flags.
- `getWorktreeStatus` in `src/shared/worktree.js` uses `REVIEW_DIFF_FORMAT_ARGS` in its fallback `git diff` call.
- `src/shared/workflow/review-diff-tool.js` exports `ReviewDiffParseError` (an `Error` subclass) and `requiredReviewDiffFiles(text)`. The helper returns `[]` for empty or whitespace-only text, returns the `parseDiffFiles` entries when there is at least one, and throws `ReviewDiffParseError` for non-empty text with no readable `diff --git a/… b/…` header.
- `parseDiffFiles` still returns `[]` for `"no header here"` and does not throw.
- `runReviewerRound` in `src/shared/workflow/validation-semantic.ts` builds its `ReviewInspection` from `requiredReviewDiffFiles` on the required scope. On `ReviewDiffParseError` it returns `{ kind: "failed", reason }` before `args.session.runIsolatedAgentSession` is called. The reason tells the user RunWield could not read the changed files from the review diff and that the change was not approved.
- `docs/prd/runwield-core-prd.md#semantic-review-and-repair` states that the review patch has one fixed format independent of the user's Git display settings, and that a non-empty patch with no readable files stops the review instead of approving. It adds the acceptance scenarios listed in the Verification Plan.

## Verification Plan

Automated, focused:

```sh
bun scripts/run-tests.js src/shared/workflow/git-snapshot.test.ts src/shared/workflow/review-diff-tool.test.js src/shared/workflow/validation-loop-review.test.js src/shared/workflow/review-contract.test.ts src/shared/workflow/epic-integration.test.ts
```

New tests and what each proves:

- **`git-snapshot.test.ts`, setting matrix.** In a `defineGitFixture` repo with a change under a subfolder, set each row of the table as repo-local config (`diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix`/`diff.dstPrefix`, `color.diff=always`, `diff.relative`, and `diff.external` pointing at a script that prints a fixed string). For each, `getWorktreeReviewDiff`, `diffTrees`, and baseline-less `getWorkflowDiff` produce output whose `parseDiffFiles` paths equal the repository-root paths of the change. This fails if any flag is missing from the constant or a call site skips it.
- **`git-snapshot.test.ts`, stability.** With no user config, `diffTrees` output equals plain `git diff <base>..<current>` byte for byte. This protects existing candidate identities and diff hashes.
- **`review-diff-tool.test.js`.** `requiredReviewDiffFiles("")` and `("  \n")` return `[]`. A real diff returns its entries. `"diff --git x/f y/f\n…"` and an ANSI-colored header throw `ReviewDiffParseError`. `parseDiffFiles("no header here")` still returns `[]`.
- **`validation-loop-review.test.js`, fail closed.** Call `runReviewerRound` with a non-empty diff whose headers use no prefix. It returns `kind: "failed"` with the new reason, and the session port records zero `runIsolatedAgentSession` calls. A version that skips the helper reaches the Reviewer and fails this test.
- **`validation-loop-review.test.js`, end to end.** In the real-Git setup, set `diff.noprefix=true` in the repo and run validation with a faux Reviewer that calls `review_diff(list)` and then approves without `show`. The approval is rejected with the "Review is incomplete" feedback naming the changed file. Before this fix the approval is accepted, so the test fails on today's code.

Behavior that must stay protected:

- Existing `review-contract.test.ts` and `review-diff-tool.test.js` parser cases (quoted paths, renames, binary, nested paths) pass unchanged.
- An empty diff still skips review through the existing `semantic_skipped` path; an empty repair diff in verify mode still yields zero required files.
- Guided review and Workspace review still render diffs; their inputs are now correctly prefixed.

No behavior is expected to stop existing except approval of a non-empty, unreadable diff.

PRD synchronization: the Core PRD capability gains these scenarios, each matched by a test above:

- Given user Git settings that change diff prefixes, colors, external diff, or relative paths, review lists every changed file with its repository path and requires reading it.
- Given a non-empty review patch with no readable file headers, the review round stops with a clear reason and no Reviewer approval is recorded.

## Edge Cases & Considerations

- **`--no-relative` needs Git 2.28 or later.** Older Git rejects the flag and every review diff fails. Mitigation: RunWield already depends on modern Git features; record the minimum if the docs list one. Assumption: no supported user runs Git older than 2.28.
- **Textconv drivers from `.gitattributes`** still change hunk content, not headers. Review should see what the repository declares, so this Plan leaves textconv alone. Assumption, reviewable.
- **The Epic integration review** has no full-read gate by design; it gets the producer fix only, not the fail-closed helper.
- **Merge into the Connect Epic.** The Epic moved `parseDiffFiles` into `review-diff.ts`. When `main` merges into the Epic, `requiredReviewDiffFiles` and `ReviewDiffParseError` move with the parser, and the Epic's host-resume branch and `assertHostReviewerCandidate` adopt them. That wiring belongs to the Epic's repair child, not to this Plan.
