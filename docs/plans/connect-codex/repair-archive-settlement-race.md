---
classification: PLANNED_CHANGE
workKind: BUG
complexity: MEDIUM
parentPlan: connect-codex
order: 6
targetBranch: epic/connect-codex
affectedPaths:
    - src/ui/workspace/server/session-continuation.js
    - src/ui/workspace/session-continuation.integration.test.ts
    - docs/prd/runwield-workspace-prd.md
createdAt: "2026-10-29"
status: draft
---

# Repair confirmed archive during turn settlement

## Context

The [Epic](../connect-codex.md) requires repairing CI failures before delivery. Linux CI exposed a baseline race in
Workspace's remote Session archive journey: a confirmed archive observes active work, but that work naturally settles
before the live stop lookup. The request then returns HTTP 409 instead of archiving the now-idle Session. The relevant
source is unchanged from `875f058b7`; removing a fixture delay reproduces the interleaving with a real Session.

The owning requirement is [Archive conversations from history](../../prd/runwield-workspace-prd.md#browser-sessions)
and its linked Core Session continuity authority. This repair preserves existing archive semantics.

## Objective

A confirmed archive succeeds when the observed turn settles before it can be stopped. Archive still requires Project
access and Session ownership, preserves running work without confirmation, and fails safely if work remains active or
its settlement cannot be established.

## Approach

Reconcile the missing live operation through existing authoritative Session state before concluding whether to archive.
Do not treat every stop error as success, weaken the active-work guard, introduce an owned-machinery injection seam, or
add a blanket delay. Keep archive policy in the current continuation path.

## Implementation Steps

- Reproduce the active-to-idle interleaving through the real Session and connection fixture.
- Handle confirmed archival after observed natural settlement through the existing authority.
- Pin success for settled work and preserve rejection for active or uncertain work.
- Update the owning acceptance scenario, run focused checks, and obtain independent three-axis review.
- Merge into the epic and rerun source and Golden CI.

## Verification Plan

Use the isolated Bun runner for Workspace continuation and relevant Session archive tests. Preserve the existing HTTP
200 assertion and use deterministic synchronization where the real fixture supports it. The final branch must pass all
CI shards. This Plan does not change Codex's entrypoint, permissions, or qualification claims.
