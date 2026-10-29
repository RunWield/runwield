---
classification: PLANNED_CHANGE
workKind: BUG
complexity: MEDIUM
parentPlan: connect-codex
order: 5
targetBranch: epic/connect-codex
affectedPaths:
    - src/plan-store.js
    - src/plan-identity-registry.integration.test.ts
    - docs/prd/runwield-core-prd.md
createdAt: "2026-10-29"
status: draft
---

# Repair catalog identity collisions

## Context

The [Epic](../connect-codex.md) requires CI repair before delivery. Linux PR CI exposed an existing catalog defect:
registered document authority can replace an unrelated Plan that shares its ID when that Plan is enumerated first.
The later identity guard then cannot see the collision. Reordering real fixture creation reproduces both failures on
macOS without changing production code or weakening the expected rejection.

The owning capability is Core's [execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery).
This repair preserves existing Plan identity and document authority; it does not expand Codex workflow scope.

## Objective

Registered authority overlays its own Plan by name and cannot hide another Plan's conflicting ID. Catalog listing,
identity preparation, and explicit backfill reject collisions consistently, independent of filesystem enumeration.

## Approach

Preserve unrelated catalog entries while resolving the registered Plan's document authority. Apply the same ownership
rule when an authority is missing or archived. Keep collision detection in the existing Plan store and identity paths;
do not add injection seams, duplicate catalogs, or new lifecycle policy.

## Implementation Steps

- Reproduce the CI failure with real Git/Plan fixtures whose creation order exposes the unrelated Plan first.
- Narrow authority replacement/removal to the registered Plan while retaining conflicting entries for identity checks.
- Cover both enumeration orders and explicit backfill modes; reject without changing either source document.
- Preserve missing-authority recovery behavior and update the owning Core acceptance scenario.
- Run focused identity/catalog regressions and static checks, obtain independent three-axis review, then merge into the
  epic and rerun its GitHub CI.

## Verification Plan

Use the isolated Bun runner for the identity integration file and relevant catalog/authority tests. Keep the existing
rejection assertions. The final PR must pass every source and Golden shard.
