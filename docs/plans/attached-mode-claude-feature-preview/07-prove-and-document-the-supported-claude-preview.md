---
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/attached/claude/"
    - "src/shared/attached/"
    - "src/cmd/attached/"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/prd/runwield-core-prd.md"
    - "README.md"
    - "docs/"
    - "scripts/"
executionAgent: "engineer"
createdAt: "2026-10-07T03:22:49.110Z"
status: "draft"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 8
dependencies:
    - "06-publish-validated-work-and-record-the-outcome"
targetBranch: "epic/attached-mode-claude-feature-preview"
planId: "ba18cb45-fed2-4878-8521-b4450ade354b"
---

# Prove and document the supported Claude Preview

## Context

Children 1–6 implement the runtime FEATURE journey and own their own recovery tests. Unit and phase tests do not
establish the complete Connect promise. This child owns the combined supported-version release evidence and the
remaining update/disable/uninstall distribution journey.

The requirements are
[End-to-End Preview Acceptance Journey](../../prd/runwield-connect-prd.md#end-to-end-preview-acceptance-journey),
[Preview Acceptance](../../prd/runwield-connect-prd.md#preview-acceptance),
[compatibility and honest availability](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability), and
[first-class Connect use](../../prd/runwield-connect-prd.md#first-class-connect-use). Stable Claude support, other
hosts, broader routing parity, and richer optional initialization are deferred.

## Objective

A declared Claude/Core/adapter combination has repeatable black-box evidence for the full FEATURE Preview journey, with
an install/update/disable/uninstall flow and guides that state only tested capability claims. A user can remain on
Connect without adopting Workspace or a Core-owned model session.

## Approach

Exercise the released plugin shape against supported Claude versions, not only mocked transport fixtures. Reconcile the
versioned capability matrix from actual results. Earlier child checks remain mandatory protection; this child exposes
gaps between them rather than replacing their responsibilities.

Documentation is release evidence's consumer, not its substitute. Keep public names as RunWield Connect for Claude Code.
Core owns shared workflow requirements; Connect links those requirements and owns host-specific availability.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/attached/claude/` — packaged plugin, supported-version black-box harness, update/disable/uninstall, and
  integrated acceptance.
- `src/shared/attached/` and CLI composition — compatibility evidence and any integration corrections exposed by the
  full journey.
- `README.md` and applicable `docs/` host guides — installation, activation, permission/trust, review, recovery,
  privacy, compatibility, and removal.
- Connect/Core PRDs — capability reconciliation and shared references, without duplicated policy.
- Packaging/build scripts only as required by discovered first-party plugin distribution.

## Reuse Opportunities

- All earlier child operation/host fixtures — keep one canonical operation surface and one run-time role-instruction
  resolver.
- Existing release, docs, link validation, and sandboxed test tooling — evidence and published guide integrity.
- Canonical Work Record and publication artifacts — observable acceptance endpoints rather than host chat claims.

## Implementation Steps

1. The packaged first-party plugin and documented compatible Core installation work through one supported onboarding
   flow with no separate model credentials or RunWield account. The capability matrix contains exact tested
   versions/ranges, required capabilities, limits, and evidence provenance.
2. One repeatable supported-version black-box journey covers all 16 PRD acceptance steps: inactive ordinary use,
   uninitialized repository, explicit FEATURE activation, Triage/Plan, Feedback/revision/approval/readiness, Core
   worktree, implementation, CI, independent AI review/repair/re-verification, configured code review, publication, Work
   Record/memory, interruption recovery, and ordinary use afterward.
3. The integrated journey proves a planning/review interruption and an execution/validation interruption, with
   fresh-process continuation, closed host-owned endpoints, retained work, no blind replay, and no false lifecycle
   advance.
4. Update rejects an adapter whose contract version Core does not speak, with precise update guidance. Disable/uninstall
   removes the host integration, restores ordinary Claude behavior, and preserves canonical artifacts and recovery
   checkpoints. Compatible reinstall can resume active work; incompatible continuation gives precise version guidance.
5. Architecture and privacy instrumentation prove no Core-owned model calls, hidden SessionRuntime, transcript
   ingestion, adapter-owned domain mutation, or copied validation policy across the full journey. Privacy-safe metrics,
   if emitted, exclude prompts, transcripts, source content, secrets, and sensitive paths.
6. README, host guides, Connect capabilities, and affected references match tested Preview availability and the actual
   install/update/removal flow. Shared Core requirements change only where shared behavior changed; unmet
   stable/later-host scope remains explicitly deferred.

## Verification Plan

- Automated: run `deno run -A scripts/run-tests.js src/attached/claude/ src/shared/attached/ src/cmd/attached/` for
  integrated release and compatibility fixtures. Planner must determine the exact real-host harness command/version
  installation steps; they are not yet present, and mocked tests cannot satisfy the release objective.
- Integrated Epic gate: `deno task ci`, including the zero-seam and architecture checks. Run tests only through the
  sandboxed runner, never direct `deno test`. Validate changed links with `deno task doc-links:check` and use the normal
  docs checks where applicable.
- Manual pair acceptance: install the packaged plugin on a declared supported Claude version in an uninitialized trusted
  Git repository. Complete all 16 PRD steps, including real blocking review/repair, configured code review, publication,
  record/memory inspection, and the two process-loss recoveries.
- Headed browser: prove Plan Feedback/resubmission/approval and configured code review using actual MCP-owned review
  endpoints; confirm they stop when Claude closes and reopen only through supported reactivation. Planner discovers the
  integrated launch command/URLs from delivered children; development fixtures alone are insufficient.
- Black-box removal/update: exercise a stale Core, update, disable/uninstall during active work, ordinary unrelated
  prompts, and compatible reinstall. Compare retained Plans, records, Git/worktree registry, and Attached checkpoints
  before and after.
- Expected: every claimed version passes the complete journey and inactive no-op/privacy/model-ownership checks. A
  passing unit suite or documentation review cannot stand in for this evidence. Verify the Compatibility Matrix glossary
  relationships remain true and PRD release claims do not exceed results.

## Edge Cases & Considerations

- Host-version access and host trust prompts may require a human. Record the exact blocked prerequisite rather than
  claiming the unrun scenario passed.
- A test that lists a documented host API is not capability proof; actual command, MCP, worker, permission, and worktree
  behavior must be exercised.
- Integration defects belong to their owning runtime/domain areas; this child must not work around them by weakening the
  plugin's gates.
- This child establishes Preview readiness only. It does not promise all routing intents, stable support, other hosts,
  or a persistent daemon.
