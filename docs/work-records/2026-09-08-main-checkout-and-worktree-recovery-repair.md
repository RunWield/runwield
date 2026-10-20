---
kind: "work_record"
recordId: "8e8e7f09-3497-4862-958d-3487396b9e5c"
status: "draft"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-08T14:18:00.000Z"
provenance:
    sourcePlans:
        - "1e706d9e-56a0-43cc-8c6f-f3984fd7aea6"
---

# Main Checkout and Worktree Recovery Repair

## Summary

Recovered the pending Workspace Session continuation and steering work, removed the rejected persistent notification
implementation, and retained the simpler shared Core notification content and browser delivery. Live notifications
remain observable as the shared operation buffer rotates. Old transcript notification records no longer drive alerts.

Abandon, recreate, and held-Plan delete/reset verify the exact checkout and branch before cleanup. They cannot adopt or
remove the primary checkout. Unchanged branches can be deleted using their recorded starting commit even when main and
the target have diverged. Unique commits stay on a named rescue branch with an abandoned registry record. Partial
failures retain recovery evidence. Recreate validates its inputs and creates the replacement before deleting the
previous checkout. Each completed Git effect is returned to the existing transition journal before the next step.

Held-Plan reset clears its selected document reference and reloads the surviving Plan. Validation rejects
primary-checkout paths before branch restoration or registry reconciliation. Publication cleanup remains governed by
ADR-016.

## History Evidence

The rejected commit `7bc87a37` was replayed as `34e18059` by `rebase (continue)` on local main at 09:15:14 EDT,
September 8. The local remote-tracking reflog records its push at 09:16:02. The approved notification implementation
subsequently merged as `7c73f0d1`, retaining both implementations after conflict resolution. The primary checkout was
later left at `34e18059`, five commits behind that merge. The session implementation survived in stash `47d3b836`.

The reflog shows a checkout to main during an unfinished rebase. The user's `~/.bin/git-up` script caught pull failures
and continued switching branches, then returned to the initial branch and popped its stash. That is a proven unsafe
path; the available history does not prove which action first put the primary checkout on the wrong branch.

## Verification

- `deno task ci`: all checks passed, 359 test files passed, no failures. Workspace diagnostics: no errors or warnings.
- Real Git recovery tests preserve primary HEAD, branch, tracked edits, untracked files, stash, controller state, and
  registry evidence on blocked cleanup. Tests cover linked and missing-path cleanup against a divergent target, unique
  rescue commits, stale paths, invalid recreation inputs, symlinked missing paths, and checkout races after directory
  removal.
- A production `/load-plan` integration test abandons unique work, checks the named rescue branch, then merges it in the
  disposable repository and retries cleanup successfully.
- Session integration covers Workspace/TUI continuation, answering live TUI questions, steering, history, restart
  handling, and notification delivery across rolling-buffer updates.
- A disposable bare remote and two clones reproduce a conflicting `git up` rebase. The repaired script stops traversal,
  preserves its stash, refuses unfinished Git operations, and restores edits only after a successful update. It also
  handles linked-worktree paths containing spaces. The script change is local to `~/.bin/git-up`, outside this
  repository.
- TUI tests now use explicit image capabilities and semantic background expectations, so they do not depend on the host
  terminal's palette or image protocol. Existing TUI implementation changes are preserved.

## Checkout and Delivery

The repair was prepared and tested in an independent clone. Original tracked and untracked edits, the index patch, the
session stash patch, and the original `git-up` script were backed up at
`/private/tmp/runwield-main-repair-20260908-una183yj/backup` before any checkout repair. The original stash remains
intact.

Local main is based on the existing `origin/main` merge `7c73f0d1`. The TUI changes are committed as `e540c8cb`
(`Polish TUI tool titles and Quick Fix feedback`). Notification, Session, recovery, and documentation changes remain
uncommitted for review. The staged TUI snapshot passed formatting checks separately; the whole-file restaging hook was
disabled for this one commit to preserve the separate, unstaged Session changes in a shared test file. No remote history
is rewritten and nothing is pushed. Other branches and worktrees are preserved.
