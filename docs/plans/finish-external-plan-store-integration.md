---
planId: "a2b67ac4-20ce-49af-bfba-1f356f670d79"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "HIGH"
affectedPaths:
    - "src/plan-store/index.ts"
    - "src/plan-store/documents.ts"
    - "src/plan-store/workflows.ts"
    - "src/plan-store/agent-files.ts"
    - "src/plan-store/managed.ts"
    - "src/shared/project-runtime-home.ts"
    - "src/agent-definitions/guide.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-18"
origin: "internal"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
deliveryBranch: "epic/external-plan-store"
status: "implemented"
---

# Finish External Plan Store integration

## Context

The 15 delivered Plans established personal Plan and Work Record ownership. The final Epic review found defects in writes, action admission, managed retries and qualification. Main converted or moved several of the same modules. The partial integration contains both staged and unstaged work. [Core Plan authoring](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption) and [execution and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery) own the affected guarantees.

## Objective

Deliver a validated Epic that includes main, preserves existing Projects and attempts, and proves the ownership model in ordinary and managed SSH sessions. Present the Epic for a separate landing decision.

## Approach

Complete and review main integration before product repairs. Keep one persistence interface across Workspace, tools and remote callers. Review the result of each stage on the Epic. A new merge from scratch would discard reviewed integration work.

## Expected Change Surface

- Plan Store operations, workflow callers, Doctor and Workspace adapters affected by main integration.
- The runtime home resolver, attached agent guidance and the Core, Connect and Workspace requirements for personal storage.
- The integration fixtures for retention, managed operations, linked clones and lifecycle edits.

## Reuse Opportunities

- `src/plan-store/index.ts` exposes the owning operations. Reuse the store’s locking and revision checks and the existing lifecycle state machine.
- Reuse managed operation receipts, the isolated Bun runner and the live SSH migration qualification procedure.

## Implementation Steps

### 1. Finish main integration

Resume in `/Users/gandazgul/web/runwield-epic-final-20261118`. The merge started at Epic `ad68d83c3` and main `d00ee1246`. It has 48 unresolved paths, and main has advanced to `340aebee2`. Preserve both the index and unstaged work. Record a checkpoint before changing the merge base.

- Finish the in-progress merge first. Map main’s Plan Store and lifecycle changes to their owners on the Epic. Carry over main’s project-move handling, Doctor diagnostics, repair verification, Workspace review links, and TypeScript interfaces. Inspect the already-resolved files as well as the remaining conflicts.
- Route Plan access through the public Plan Store interface. Keep lifecycle decisions in the state machine and persistence in the store. Check production imports and tests for direct filesystem access, retired modules, duplicate ADRs, and obsolete paths.
- Incorporate the newer main commits, record the tested SHA, and inspect their changes for affected callers. Run the locked install, type and Workspace checks, ownership boundary check, and focused local, SSH, and linked-clone journeys. Verify existing projects and retained attempts can resume.
- Run full CI on the combined tree. The Epic baseline recorded 1,032 passing files, three failing files, and one skipped file. Verify the fixture identity repair for project continuity. Diagnose the scenario wait-clock and semantic-round-limit Golden failures independently. Keep evidence for any remaining failure and inspect the skipped file. Run a clean-context review of the integration before starting product repairs.

### 2. Fix Plan edits and stale action admission

At the owning write operation, verify Plan identity, revision, archive status, and edit permissions under the same lock as the write. Apply the lifecycle decision for a material edit and persist the new review state with the document. If an action was prepared against an old revision, return a stale-action result and preserve the intervening change.

Prove through Workspace and agent entry points that an approved Plan loses execution readiness after a material edit, an archived Plan rejects edits, and a rename or archive between selection and action cannot authorize stale work. Check unchanged content and stale concurrent edits as controls.

### 3. Fix protected paths and managed create retries

Make the file tool and the Plan Store classify the same resolved target before selecting a writer. Cover supported home-relative and alternate path spellings, an ordinary source file, and protected package metadata. Keep metadata changes behind the Plan Store interface.

Give each intentional managed creation its own operation identity. Preserve that identity when retrying an uncertain result. Test a lost response and retry, then a successful create, rename, and fresh create under the original name. Verify the latter creates a distinct Plan and the renamed Plan survives.

### 4. Correct retention evidence and guidance

Give the laptop and execution host distinct filesystem roots. Put a decoy at the equivalent laptop path, prune a remote delivery copy, and verify the remote copy disappears while the decoy survives. Seed retention with distinct old and new IDs whose ordering disagrees with age. Check exact survivors around the count limit and the age cutoff.

Update the bundled Guide, backup and restore instructions, and the owning PRD scenarios. Verify that an attached agent can read Plans and read or search Work Records with delivery copies disabled. Update ADR descriptions of shipped behavior and leave formal status changes for owner acceptance.

### 5. Support both Linux HOME layouts and qualify them on the k8s server

The account’s configured home may resolve through a symlink. Resolve and verify the account home as the starting directory for personal storage. Both spellings must select the same store and locks. Keep checks against redirection inside the store. If the mapping changes during an operation, fail safely without writing elsewhere. Cover both layouts, target changes, and an unsafe descendant in automated tests.

Use disposable, unprivileged test accounts or an equivalent pair of isolated account configurations on the k8s server. One configured login HOME is a physical directory. The other is a symlink to a directory owned by the test account. Use ordinary SSH logins and record the effective user, configured HOME, resolved HOME, build, and test project. A process-scoped HOME override does not qualify this journey.

For each layout, run manual SSH followed by wld and verify the remote account owns the Plan and Work Record. Then run wld remote from the laptop and verify laptop ownership and remote execution. Exercise create, edit, reconnect, historical read, and retention against disposable data. Verify the expected store and delivery copies on both hosts. Remove only accounts and directories created for this run, then verify cleanup. Capture redacted results before removal.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

- Install with `bun run install:locked` using the supported Bun range. Run `bun scripts/run-tests.ts src/plan-store/remote-operations.test.ts src/shared/work-records/package-store.test.ts src/shared/attached/project-continuity.test.ts` on the combined tree.
- Re-run the baseline Golden and scenario-clock failures with `bun scripts/run-tests.ts src/ui/tui/golden-scenarios/validation-workflow-semantic-round-limit-stop.test.ts src/ui/tui/testing/scenario-wait-clock.test.ts`. Confirm the skip’s cause.
- Through Workspace, edit a material section of a ready Plan and check its state before attempting execution. Through the agent entry point, confirm a stale edit or archived write cannot change stored bytes. Exercise lost-response retries and rename followed by fresh creation through managed SSH.
- Record the two-by-two Linux matrix, ownership evidence and cleanup described above. Run the full validation suite on the final Epic SHA after a locked install and confirm it includes the recorded main SHA. Have a clean-context reviewer trace an ordinary local edit and a managed SSH attempt end to end. Repair and rerun affected checks, then record the final CI verdict, Linux matrix, and remaining limitations before presenting the Epic for landing. Keep existing Windows automated checks. Defer live Windows qualification.

## Edge Cases & Considerations

- A linked checkout or interrupted attempt must retain its original owner and recovery evidence through integration.
- HOME alias resolution must preserve owner identity and detect replacement during use. Use test accounts and disposable data for cleanup.
- Existing Windows automated checks stay in scope. Live Windows qualification is deferred.
