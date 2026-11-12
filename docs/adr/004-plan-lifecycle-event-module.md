---
status: accepted
---

# ADR-004: Plan Lifecycle Transitions Are Centralized

## Local home-store activation

Ordinary local and manual-SSH Plan and Work Record access now uses the executing account's personal Project store
under [ADR-0020](0020-home-project-state-and-launch-mode-ownership.md). Project catalog authority is separate from
revision-checked workflow selection. Explicit import preserves original execution ownership until publication is proven
or the user deliberately abandons the attempt; it never starts a replacement attempt or weakens publication evidence.
Session bundle authority and managed-remote personal ownership retain their existing contracts.

## Product constraints

[Core execution and recovery](../prd/runwield-core-prd.md#execution-validation-and-recovery) owns the completion
contract: delivery concludes only with confirmed publication or deliberate user abandonment. Internal inconsistencies,
failed attempts, locks, settings, storage, and synchronization are RunWield's responsibility to repair automatically.
These constraints guide the architecture; they do not certify that every existing failure path already conforms.

## Decision

RunWield workflow code records Plan Events into a single Plan Lifecycle module instead of directly mutating Plan Status
at each call site. The lifecycle module owns allowed transitions, timestamps, failure details, execution baseline
metadata, and the meaning of executable states. This keeps router, review, readiness, execution, validation, and
recovery code decoupled from the state machine so future workflow changes do not recreate conflicting status semantics.

Transitions either commit all owned state or retain durable evidence from which recovery can reconcile partial effects.
For irreversible effects, inspect repository facts before proceeding; never guess success, blindly replay uncertain Git
operations, or claim a rollback that did not occur. A failed transition remains an intermediate workflow condition.

Legacy metadata transitions compare front matter identity and preserve the latest user-written body. Writers that replace the
body still compare the whole file to prevent overwriting concurrent edits. A compensating transition may restore only
its owned front matter onto the latest body. Details live in the
[Plan lifecycle reference](../plan-lifecycle.md#plan-body-ownership-and-external-adoption).

Explicitly admitted canonical packages use those same event and review rules, with definition and controller metadata
committed together beside the documents. Immutable input and complex-controller references preserve the evidence used
by an action. Package metadata compensation never restores document bytes. The package owner takes catalog and sorted
Plan-ID native locks before repository/attempt locks, with nested writes reusing ownership. A package-wide attempt
binding prevents two linked clones from creating competing unfinished executions; the recorded repository registry
continues to own physical Git facts. Neither a path nor a matching name admits package authority. This bounded internal
path does not change ordinary public selection or the publication decision in ADR-016.

Diagnostics must inspect malformed stores without first requiring the invariants they diagnose. Retain per-item facts
and corruption details; a migration must not create state that RunWield then refuses to inspect. Automatic repair uses
provable facts, respects live owners and active locks, and cleans settled internal records. Worktrees, branches, and
Plan files require proof that no work can be lost or explicit deletion consent; unclaimed worktrees are presumed to
contain valuable work. Abandoning a workflow does not imply permission to delete it.

## Rationale and alternatives

Central ownership makes recovery enforceable across every surface. Independent status writes would create competing
truths. Whole-file identity for metadata transitions would reject harmless body edits; restoring an old whole file would
destroy user work. Making users reconcile internal files or run repair commands would transfer RunWield's responsibility
to them. These approaches are excluded by the product constraints.
