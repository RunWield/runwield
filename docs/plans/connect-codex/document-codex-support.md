---
classification: PLANNED_CHANGE
workKind: DOCUMENTATION
complexity: MEDIUM
parentPlan: connect-codex
order: 4
targetBranch: epic/connect-codex
affectedPaths:
    - docs/user-documentation
    - docs/prd/runwield-connect-prd.md
    - docs/adr/014-attached-workflow-coordination-boundary.md
    - README.md
createdAt: "2026-10-29"
status: draft
---

# Document Codex support

## Context

The [Epic](../connect-codex.md) adds a second Connect host. Existing public guidance says only Claude Code is supported.
Documentation must match the actual package and [acceptance evidence](prove-codex-execution-and-recovery.md).

## Objective

Desktop and CLI users can discover, install, start, resume, update and remove the Codex plugin with clear Core
prerequisites, permissions, supported scope and qualification limits.

## Approach

Add a dedicated Codex guide alongside Claude and update central references. Keep product requirements capability-owned;
describe host mappings without duplicating shared lifecycle semantics or claiming unobserved parity.

## Expected Change Surface

Codex guide, Claude guide references, docs staging/navigation, README, central Connect/root PRD, ADR-014 and glossary.

## Reuse Opportunities

Use the existing public docs pipeline and Claude guide structure. Link shared delivery settings, privacy and recovery
rules instead of inventing Codex-specific lifecycle behavior.

## Implementation Steps

- A public Codex guide documents verified native installation/invocation spelling for both surfaces, compatible local
  Core, explicit activation, current workflow selection, browser review, workers, validation, delivery and restoration.
- The guide describes update, disable/remove/reinstall, permissions, timeout behavior, local artifacts and privacy.
  It separates source-checkout testing from availability on the published default branch or released Core binary.
- Tested versions and support claims cite actual evidence and disclose unproven live/default-permissions behavior.
- README, public navigation and central PRDs show Codex's implemented scope; Claude's supported behavior remains
  accurate. ADR-014 explains native orchestration skills versus copied role definitions.
- The Epic integration report records child changes, CI/review outcomes, final objective review and remaining limits
  without inventing protected RunWield lifecycle metadata.

## Verification Plan

Run `bun run doc-links:check`, `bun run docs:check` and focused documentation tests. Check commands against current
installed Codex help and official docs. Compare every availability claim to the completed implementation/evidence.

## Edge Cases & Considerations

Avoid treating the local alpha CLI version as broad stable support. Do not require users to operate internal `wld
attached` commands, edit protected runtime files, or reconfigure model credentials to use Connect.
