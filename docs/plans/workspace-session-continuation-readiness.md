---
planId: "8c55bf9e-f341-4156-a30b-7ad8cddbbd75"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/server/session-continuation.js"
    - "src/shared/session/session-runtime.js"
    - "src/shared/session/session-transcript-manifest.ts"
    - "src/ui/workspace/components/SessionActivationStatus.jsx"
    - "src/ui/workspace/islands/SessionSurface.jsx"
executionAgent: "engineer"
frontend: true
createdAt: "2026-09-07T23:05:28.350448-04:00"
status: "validated"
origin: "internal"
workRecord:
    status: "generated"
    recordId: "b9297c76-43e2-40d5-a225-d4575c787ced"
    path: "docs/work-records/2026-09-08-workspace-session-continuation-and-steering.md"
    lastAttemptAt: "2026-09-20T03:13:51.924Z"
---

# Restore Ordinary Workspace Session Continuation

## Objective

The same developer can start or continue a conversation in Workspace, move to the TUI, and return to their phone with
one updated Session. Long history, previous workflow context, and an idle open screen must not prevent continuation.
While work runs, the phone can steer it, answer its questions, queue a follow-up, or stop it.

Product intent: [Workspace PRD](../prd/runwield-workspace-prd.md). Architecture:
[ADR-015](../adr/015-file-authoritative-session-bundles.md).

## Resolved Gaps

- History pagination no longer prevents sending. Workspace opens at the latest messages and offers earlier pages.
- Historical execution context no longer makes an idle Session read-only. Actual running operations still serialize
  writes through Core.
- An open TUI synchronizes saved Workspace changes before its next turn. Workspace discovers new saved changes and
  current work automatically, preserving the draft.
- The first submitted message establishes a Session identity before the first response finishes. Reloading or switching
  screens reconnects to that Session.
- Workspace discovers live questions and activity in a separate TUI process. Answers, steering, and Stop reach the
  existing Core runtime through a temporary local connection. A question disappears from the other surface when
  answered.
- Opening an interrupted Session uses Core's existing recovery of saved history. The user can send the next message
  without a separate preparation or recovery step.
- Phone layout keeps the conversation and composer visible, with context details collapsed. Send follows the latest
  activity; reading earlier messages preserves the scroll position.
- A container setup (`Containerfile.wld-ux`, `compose.workspace.yml`) runs Workspace and TUI together against a mounted
  Git repository.

## Delivery Evidence

See the [Work Record](../work-records/2026-09-08-workspace-session-continuation-and-steering.md) for verification.
Implementation and automated validation are complete; this status does not claim owner acceptance testing.

## Boundaries

One developer, one machine or container, and the existing Core runtime. The local connection lasts for the running
operation. Browser follow-ups remain in that tab. Saved conversation history uses the existing Session files. Restarting
an agent process does not reconstruct an unfinished question or replay external effects; the owner asks it to continue.
