---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/pages/projects/[projectId]/settings.astro"
    - "src/ui/workspace/pages/projects/index.astro"
    - "src/ui/workspace/islands/ProjectRootForm.tsx"
    - "src/ui/workspace/project-page-requests.test.js"
    - "src/ui/workspace/project-root-form.test.tsx"
    - "scripts/bun-test-files.json"
    - "docs/prd/runwield-workspace-prd.md"
tickets:
    - url: "https://github.com/gandazgul/runwield/pull/315"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-10-17"
status: "draft"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
planId: "59cd99ae-2682-4a76-8e79-047b2b4799e7"
---

# PR #315: Fix Review Findings, Resolve Conflicts, and Merge

## Context

PR #315 (`fix/audit-project-errors`, "fix(workspace): recover from rejected project requests") makes Project requests
recover from network failure. Today a rejected request leaves controls stuck or shows nothing. The PR adds pending and
failure feedback, retry, and duplicate-submit protection.

The PR has two review findings and three merge conflicts with `main`.

**Review findings:**

- **S315-1** — The pending states for maintenance (`settings.astro:56`) and relink (`settings.astro:94`) show only text.
  `docs/design-system.md` § Shared loaders requires the shared loader (`RunWieldThinkingDots`, or `.rw-thinking-glyph`
  in plain browser code) for every pending button action.
- **T315-1** — `project-page-requests.test.js` replaces `addEventListener` and calls the saved callback directly. The
  test ignores the event type. Handlers bound to `submit` instead of `click` still pass all 24 cases.

**Conflicts.** `main` merged #299 ("Warn before using home or system folders") after this PR branched. #299 replaced the
inline link form (`projects/index.astro`) and the inline relink form (`settings.astro`) with one React island,
`src/ui/workspace/islands/ProjectRootForm.tsx`. The PR edits the inline scripts that #299 deleted.

```text
                     PR #315 changes            main after #299
Link (index.astro)   inline script         ->   <ProjectRootForm />            (conflict)
Relink (settings)    inline script         ->   <ProjectRootForm projectId />  (conflict)
Maintenance buttons  inline script         ->   inline script, unchanged       (merges)
bun-test-files.json  +1 entry              ->   other entries added            (trivial)
```

**PRD.** The PR adds **Requirement: Recover from failed Project requests** and one acceptance scenario to
`docs/prd/runwield-workspace-prd.md` (Project settings capability). Both stay. After this change they must be true for
the island (link, relink) and for the inline maintenance script (enable, disable, remove, rescan). The #299 directory
confirmation behavior must survive.

## Objective

Merge PR #315 into `main` with both review findings fixed and the recovery behavior applied to the code that `main` now
uses for link and relink.

## Approach

**Resolve the conflicts in favor of `main`'s island, then port the recovery behavior into it.** The PR's inline
link/relink code is obsolete. Restoring it would remove #299's directory confirmation.

The island already has most of the PR's behavior: it disables inputs and the button while pending, blocks duplicate
submits with `inFlight`, keeps the typed values, and catches rejected fetches. Three gaps remain:

```diff
 submit()
   setPending(true)
-  setStatus("Linking Project...")             // text only
+  render <RunWieldThinkingDots label="Linking Project" /> while pending
   response = await fetch(...)
-  data = await response.json()                // throws on a non-JSON error body
+  data = await response.json().catch(() => ({}))
   ...
 catch
-  setStatus(error.message)                    // shows "Failed to fetch"
+  setStatus("Project link could not be confirmed. Check your connection and try again.")
+  (relink: "Project relink could not be confirmed. ...")
```

**Maintenance stays in the inline script.** Add a `.rw-thinking-glyph` element next to the "Updating Project..." text
while a request is pending, and remove it when the request settles. This is the documented form for plain browser code.

**Tests dispatch real events.** `project-page-requests.test.js` keeps happy-dom's native `addEventListener`. It
triggers maintenance with `button.click()` (or `dispatchEvent(new Event("click", { bubbles: true }))`). It drops the link
and relink cases, because that code no longer lives in the inline scripts. The island's network-failure behavior gets
cases in the existing `project-root-form.test.tsx`, which already renders the real island and submits real events.

**Merge mechanics.** Work in a separate worktree on `fix/audit-project-errors`. Merge `origin/main` into the branch (no
force-push needed). Push, wait for CI, then squash-merge.

Option set aside: rebase onto `main`. It gives a linear branch history but needs a force-push. Squash-merge makes the
`main` history linear anyway.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/workspace/pages/projects/index.astro` — conflict resolved to `main`'s `<ProjectRootForm client:load />`; no
  inline link script remains.
- `src/ui/workspace/pages/projects/[projectId]/settings.astro` — conflict resolved to `main`'s relink island; the PR's
  maintenance recovery script stays and gains the shared loader glyph; the PR's relink status paragraph and relink
  script are removed.
- `src/ui/workspace/islands/ProjectRootForm.tsx` — shared loader while pending, connection-failure message, tolerant
  parse of non-JSON error bodies.
- `src/ui/workspace/project-page-requests.test.js` — native event registration and dispatch; maintenance operations
  only.
- `src/ui/workspace/project-root-form.test.tsx` — new cases for rejected fetch, non-JSON HTTP error, and loader.
- `scripts/bun-test-files.json` — conflict resolved by keeping both sides' entries in sorted order.
- `docs/prd/runwield-workspace-prd.md` — PR text kept; edit only if the delivered behavior differs from the requirement
  and scenario.

## Reuse Opportunities

- `src/ui/design-system/components/react/RunWieldPrimitives.tsx` — `RunWieldThinkingDots` for the island; it renders
  `role="status"` and an accessible label. See `PlanBodyEditor.jsx:220` for the in-button pattern.
- `.rw-thinking-glyph` in `src/ui/design-system/components.css` — the plain-browser loader for the inline script, as in
  `src/ui/workspace/static/workspace-shell.ts:848`.
- `src/ui/workspace/project-root-form.test.tsx` — existing harness that bundles and renders the real island under
  happy-dom with `withProcessGlobalTestLock`.

## Implementation Steps

- A separate Git worktree outside the primary checkout has `fix/audit-project-errors` checked out, tracking
  `origin/fix/audit-project-errors`. The primary checkout on `main` and its uncommitted changes are untouched throughout.
- `origin/main` is merged into the branch with a merge commit, and no conflict markers remain in any file.
- `src/ui/workspace/pages/projects/index.astro` matches `origin/main`: it renders `<ProjectRootForm client:load />` and
  contains no `data-project-register` inline script.
- `src/ui/workspace/pages/projects/[projectId]/settings.astro` renders `<ProjectRootForm projectId={...} client:load />`
  for the Project root card. It contains no `data-project-relink` form, no `data-project-relink-status` element, and no
  relink inline handler.
- The maintenance handler in `settings.astro` keeps the PR's behavior: it disables every `[data-project-action]` button
  in the card while pending, ignores clicks on a disabled button, shows server errors and the connection-failure message
  in `[data-project-action-status]`, clears the status on success, and re-enables buttons in `finally`.
- While a maintenance request is pending, the Maintenance card contains a `.rw-thinking-glyph` element (with
  `aria-hidden="true"`) beside the "Updating Project..." status text. When the request settles (success, HTTP error, or
  rejection), the glyph is gone and failure text remains visible.
- `ProjectRootForm.tsx` renders `RunWieldThinkingDots` while `pending` is true, labeled "Linking Project" or "Relinking
  Project". It renders no loader when idle. The status paragraph keeps failure text.
- `ProjectRootForm.tsx` shows "Project link could not be confirmed. Check your connection and try again." (link) or
  "Project relink could not be confirmed. Check your connection and try again." (relink) when `fetch` rejects. It does
  not navigate and keeps the typed root and display name.
- `ProjectRootForm.tsx` parses error bodies with a fallback, so a non-JSON HTTP error shows "Project operation failed."
  instead of a JSON parse error message.
- The #299 directory-confirmation flow in `ProjectRootForm.tsx` behaves as before: a `409`
  `directory_confirmation_required` response opens `RunWieldConfirmationDialog`, and Continue resubmits once with
  `directoryConfirmation`.
- `project-page-requests.test.js` does not override `addEventListener`. It triggers each maintenance operation (enable,
  disable, remove, rescan) by dispatching a real `click` event on the button. A handler registered for any other event
  type makes every case fail. It covers, for each operation: rejected fetch is visible and retryable, pending blocks
  duplicates, HTTP errors stay visible without navigation, success keeps its result, and the loader glyph is present
  only while pending.
- `project-root-form.test.tsx` covers, for both link and relink: rejected fetch shows the connection-failure message,
  keeps the input values, re-enables the button, and does not navigate; a later successful submit clears the failure and
  navigates; a non-JSON `500` shows the fallback message; `RunWieldThinkingDots` is present only while the request is
  pending.
- `scripts/bun-test-files.json` lists both `src/ui/workspace/project-page-requests.test.js` and every entry `main` added,
  sorted, with no duplicates.
- The **Recover from failed Project requests** requirement and its scenario in `docs/prd/runwield-workspace-prd.md`
  describe the delivered behavior for link, relink, enable, disable, remove, and rescan.
- The merge and fix commits are pushed to `origin/fix/audit-project-errors` without force-push. No commit message has a
  `Co-Authored-By` or other attribution trailer.
- GitHub reports PR #315 as mergeable and all required checks pass on the pushed head.
- PR #315 is squash-merged into `main` (`gh pr merge 315 --squash`), and `gh pr view 315` reports state `MERGED`.

## Approval Confirmation

No Work Records are proposed for `supersedes`.

## Verification Plan

Automated (in the worktree, after `bun run install:locked`):

- `bun scripts/run-tests.js src/ui/workspace/project-page-requests.test.js src/ui/workspace/project-root-form.test.tsx`
- `bun run fmt:check src/ui/workspace/islands/ProjectRootForm.tsx src/ui/workspace/project-page-requests.test.js src/ui/workspace/project-root-form.test.tsx`
- `git grep -n '^<<<<<<<\|^>>>>>>>' -- .` returns nothing.

Tests that prove the review findings are fixed:

- **T315-1:** temporarily change the maintenance handler's `addEventListener('click', ...)` to `'submit'`. Every
  `project-page-requests.test.js` case must fail. Revert.
- **S315-1:** the loader assertions in both test files fail if the loader markup is removed or rendered when idle.

Protected behavior after the change:

- #299 directory confirmation in `project-root-form.test.tsx` (Quit, Escape, confirm once, pending disables) still
  passes unchanged.
- Maintenance retry, duplicate blocking, HTTP error text, rescan diagnostics, and navigation after success stay covered.

Expected to stop existing:

- The link and relink cases in `project-page-requests.test.js`. Their code moved to the island; the new island cases
  replace them. Do not delete them without adding the island cases.

PRD scenario check: "When a link, relink, enable, disable, remove, or rescan request loses its connection..." maps to the
rejected-fetch cases in the two test files (one per operation).

Manual (optional; CI covers the behavior): run the Workspace, open a Project's settings, stop the server, click "Full
Session rescan" and submit Relink. Each shows the loader while pending, then the connection message, and the controls
are usable again.

Delivery: `gh pr checks 315 --watch` passes, then `gh pr merge 315 --squash`, then `gh pr view 315 --json state` reports
`MERGED`.

## Edge Cases & Considerations

- **Stale CI.** Current checks passed on the pre-merge head. Only checks on the new pushed head count. If CI fails, fix
  it on the branch and push again; do not merge with failing checks.
- **The primary checkout is not safe for this work.** `main` has unrelated uncommitted changes. All edits, merges, and
  test runs happen in the worktree. Do not run `git restore`, `git checkout`, or `git merge` in the primary checkout.
- **Duplicate loader status roles.** `RunWieldThinkingDots` has `role="status"`, and the island's paragraph also has
  `role="status"`. Keep the status paragraph empty while pending (the loader carries the label) so screen readers do not
  announce two messages.
- **Assumption: squash-merge.** The repository allows all three methods. Recent feature PRs land as single `(#NNN)`
  commits, so this Plan uses `--squash`.
- **Assumption: the test file stays JavaScript.** No ratchet blocks new `.test.js` files, and the reviewer did not ask
  for a conversion.
- **Assumption: one PR comment.** After pushing, reply on the PR that S315-1 and T315-1 are fixed and the link/relink
  recovery moved into `ProjectRootForm`. Skip this if the user does not want PR comments.
