---
planId: resume-saved-publication
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Resume saved publication attempts

## Request

Operators need to resume a pending publication after a remote rejects a send. The service already saves the remote,
target, validated candidate, prepared commit, and last error. Add a public resume operation that uses this record
without asking callers to recreate the original request. A published attempt is complete and can be read again without
another send. Failed sends remain pending with diagnostic information. The caller continues to own candidate
validation and exclusive access to the repair workspace and attempt file.

## Approved steps

1. Add `retryPublication(workspace, attemptFile)` to the publication API.
2. Reuse the saved candidate and the existing target-branch lease publication flow.
3. Persist the result of each send and retain failure information when publication is still pending.
4. Cover normal publication, resuming a pending attempt, a repeated completed request, and remote rejection with real
   local Git repositories.

## Validation

Use Bun 1.4.3. Run `bun run test`. Temporary remotes, repair workspaces, and other writers must live outside this project
and be removed after each test.
