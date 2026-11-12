---
status: proposed
---

# Home Project State and Launch-Mode Ownership

## Context and Constraints

Local and manual-SSH Plans, ordinary runtime and Sessions live in personal home storage;
explicit managed-remote runtime retains its admitted checkout layout until its transport cutover. This splits a Project's
workflow across paths that change as work moves between planning, execution, publication, and recovery.

The owner confirmed these target constraints on 2026-11-01:

- The complete Plan Store proposal is in scope, including Work Records, delivery copies, history, and retention.
- All `.wld/internal/` state moves under `~/.wld/projects/<projectId>/`. Project `.wld/` keeps only local settings and
  user overrides; it does not retain a Plan-store link or a runtime compatibility directory.
- Ordinary `wld` owns Plans on the machine/account where it executes. Manual SSH followed by `wld` is ordinary
  execution on the remote machine.
- `wld remote <host>` keeps Plans on the initiating laptop, while code execution stays remote.

This ADR records accepted local/manual-SSH mechanisms alongside the still-proposed managed-remote, history and retention work. Only the explicitly accepted scope below is current guidance. [ADR-015](015-file-authoritative-session-bundles.md),
[ADR-016](016-proof-bearing-publication-state-machine.md),
[ADR-017](017-project-runtime-state-under-wld-internal.md), and
[ADR-018](018-remote-ssh-local-personal-authority.md) remain the existing decisions until reconciled with an accepted
replacement. The [Epic](../plans/external-plan-store.md) owns implementation outcomes and migration work.

The stable-identity slice now uses `runwield.projectId` and `runwield.repositoryId` from the Git common directory's own
configuration, a distinct administrative-directory checkout ID, and `.wld-project.json` before Git adoption. Local
identity and verified Session/Attached locator records live under `~/.wld/projects/<projectId>/project.wld.json`. Workspace registration remains optional
and separate. Explicit managed-remote owner context does not introduce remote-store persistence. This narrow delivery
does not implement document relocation. Ordinary runtime relocation is now the accepted decision in ADR-017;
managed transport and the Plan-package decisions below remain proposed. Session/Connect continuation now
resolves verified original stores after moves and accepted clone links, without relocating bundles or locks, rewriting
historical evidence, transferring execution attempts, or changing managed-remote ownership. ADR-015 owns that accepted
Session lookup decision; the broader home-state proposal remains proposed.

The canonical-package persistence contract was introduced through internal operations and is now selected by ordinary
local/manual-SSH discovery. The earlier repository-only public boundary is superseded by local activation below. Its version-1 metadata owns IDs, names, independent revisions,
relationships, archive facts, supported definition/controller fields and references to execution records. Its optional workflow references retain complete review/readiness inputs, the personal-owner/repository/attempt binding,
and immutable complex-controller evidence. The registry remains the owner of physical Git facts. Unsupported fields and versions
require an explicit format change. This persistence contract does not accept the broader proposed ownership and
activation decision below.

Package lookup derives from directories and validated metadata, without an authoritative catalog database. Mutations
take the personal Project catalog lock before stable, ordered Plan-ID locks; this deliberately serializes mutations
within one store to keep recovery and uniqueness in one owner. A durable intent covers publication and rename. Rename
moves the package's own resources so nested names do not make directory ancestry into a parent relationship. Retained
inputs publish complete staged bytes and a manifest before exposing their reference. Editors do not take Core locks,
so capture revalidates observed bytes and membership; arbitrary multi-file editor writes are not an atomic transaction.

The internal import contract extends version-1 metadata with named Sequence, Ticket, supersession/deviation, delivery,
closure and archive facts. Original bytes and remaining historical fields are immutable provenance, including retired
objective-check fields. Typed import references resolve retained controller/checkpoint and repository-attempt evidence;
they do not create another mutable lifecycle authority. Existing version-1 packages remain valid without these optional
fields. Explicit internal lifecycle admission rechecks the retained binding before execution. Unfinished imported attempts
continue through their original legacy owner; retained provenance is never promoted into mutable controller truth.

A batch intent reserves IDs and retains complete selected inputs before any package is visible. The same persistence
owner stages and publishes every new member under the catalog lock and ordered Plan-ID locks. One persistent batch
generation marks commitment; passive scans compare it before and after traversal and retry when it changes. Merely
checking for an intent at either end would miss a batch that both starts and finishes during traversal. Repeating
ordinary single-package creation was rejected because interruption could expose half a family. Keeping the immutable
inputs permits recovery without the original sources, while the committed marker prevents replay over newer edits.
The import boundary remains explicit selection, not automatic repository migration. Local activation does not accept
the broader managed-remote ownership proposal below.

The bounded internal lifecycle path now uses existing review, readiness, Sequence and Plan Event rules with home package
metadata. Retained inputs include every required resource and parent context; implementation dispatch and checkpoints
keep the exact input and attempt. The same publication owner now accepts a durable retained manifest with exact
metadata/family/Tickets and frozen optional delivery copies. Packages complete real validation and target publication,
settle matching personal receipts and release ownership before cleanup; no target metadata-only commit or repository
Plan is required. Retained Recorder inputs survive code cleanup. Reusing the publication state machine avoids a second
phase authority, and exact immutable inputs avoid treating a delivery copy as live state. ADR-016 qualifies its legacy
Git-metadata rule for this internal case. Local selection now uses this contract; managed-remote transport and retention remain outside it. ADR-004 and ADR-017 qualify the accepted lifecycle/runtime
decisions; the broader proposal below remains proposed.

The internal Work Record contract now shares personal Project ownership with admitted packages. Explicit record
admission also supports import/read/index without a Plan. Canonical Markdown and native mutation locks are independent
of repository binding; private location evidence retains each binding's copies. A stable Project/personal-owner index
can be rebuilt from canonical records after a move or clone link. General Memory namespaces do not move. Retained
Recorder preparation supplies the existing single-commit publisher and keeps pending copy confidence distinct from
proof-approved canonical confidence. These bounded choices are qualified in ADR-016; they do not activate the broader
public or managed-remote proposal.

## Accepted Local and Manual-SSH Activation

Ordinary local and manual-SSH entry now selects one personal home Project format for Plans and Work Records.
Project-level authority is independent of selected workflow authority: passive catalogs can inspect an empty Project,
while selected actions still check Plan ID, metadata revision, repository and personal owner. Request boundaries
reconstruct that authority rather than inheriting another request’s selection. A missing or denied home store cannot
fall back to checkout documents. Import and recorded legacy-attempt continuation are the only checkout parsing scopes.

Explicit file/folder import preserves source bytes and IDs. New authoring separates Markdown from typed Core-owned
metadata. Archive and restore change package metadata without moving prose into repository history. Independent delivery
copy settings keep Plans off by default and Work Records on; a repository-folder import may record a one-time Plan-copy
choice. Settings and overrides stay in their existing checkout locations.

An unfinished imported attempt retains its original execution and validation owner. The existing recovery/publication
proof must settle it before a durable package settlement releases the old binding. Publication cleanup must complete;
abandonment must be deliberate. This avoids both duplicate execution and indefinite dependence on the old checkout
once settlement succeeds. Managed-remote ownership activation is explicitly not accepted by this local cutover.

The preceding implementation history describes the incremental prerequisites. Its internal-only/public-activation
limits are superseded for local/manual-SSH use by this section; managed transport and retention limits remain.

### Plan persistence boundary

The Plan store is a deep module with a public command/query interface at `src/plan-store/index.ts`. Its private
implementation owns source selection, identity checks, lock ordering, revision checks, durable package and retained-copy
writes, import continuation, and immutable input capture. Lifecycle policy remains in
`src/shared/workflow/plan-lifecycle.js`; the owner applies those rules to locked authoritative data and persists the result.
This separates policy from storage without creating two writers.

Named operations express authoring, review decisions, lifecycle events, imports, resource authorization, and execution
reservation. The caller supplies intent and observed revisions. It does not receive a raw metadata mutator or coordinate
select/lock/read/write steps. Target resolution supplies a Git branch to the owner; binding that target and reserving an
attempt are one locked operation. Frozen document assembly is also an owner query. Generic atomic filesystem helpers
belong to `src/shared/atomic-text-file.ts`, not the public Plan API.

A facade that merely reexports package CRUD or wraps callers in a selected scope was rejected: it leaves invariant
ordering distributed across callers. Putting all workflow behavior in the lifecycle state machine was also rejected:
agent execution, Git effects and user interaction remain with their existing owners. Compatibility delegates may call
named Plan operations, but cannot retain an independent persistence path. Boundary tests must reject private imports
and direct Plan persistence in consumers; behavioral tests must still prove concurrency, stale input and identity checks.

Review acceptance and execution capture have different comparisons. Review tolerates changes that render identically;
reserved execution input retains exact bytes. Neither comparison permits instructions, links or execution policy to
change without the corresponding review/readiness evidence.

The [module contract](../../src/plan-store/README.md) documents supported operations, opaque strict-action versus fresh-read
contexts, the pre-admission runtime migration bridge, and explicit private/test membership. The mechanical CI boundary
includes Workspace and forbids production fixture imports. Exact qualification exceptions preserve crash/corruption
coverage without making private storage APIs available to consumers. Public-interface concurrency and stale-input tests
remain required; consolidating files alone does not establish the behavior.

## Decision and Rationale

Use stable opaque Project identity to locate home Project storage. Keep repository and checkout bindings as explicit
execution facts, not as storage identity. Shared local Git configuration binds linked worktrees to the Project;
remote URLs only support a user-confirmed linking decision. Core does not require Workspace SQLite for identity.

Keep one live Plan package with ordinary editable Markdown and separate Core-owned `plan.wld.json`. Plan controller
state joins that metadata; lifecycle rules retain exclusive ownership of protected transitions. Work Records remain
file-authoritative and searchable through rebuildable indexes. Immutable retained attempt inputs support recording
and recovery without reading repository delivery copies.

Separate personal-store ownership from the host that performs Git effects:

| Launch mode              | Personal store owner | Execution-runtime owner  |
| ------------------------ | -------------------- | ------------------------ |
| Local `wld`              | Local account        | Local account            |
| Manual SSH, then `wld`   | Remote account       | Remote account           |
| Laptop `wld remote host` | Laptop account       | Remote execution account |

Personal storage includes Plans, Plan locks, controller state, Work Records and their indexes, and collaboration
secrets. Execution runtime includes repository/worktree registries, Git-effect journals, publication staging,
repair checkouts, and Git delivery evidence. Both live under their responsible account's home Project tree; neither
uses checkout `.wld/internal/`. Repository bindings and personal-store owner identity distinguish execution records
when several clones or personal owners use the same Project. Git coordination stays on the execution host.

For managed remote execution, use authenticated, connection-scoped personal-store operations for authoritative
metadata, locks, and durable acknowledgements. An SSHFS mount can expose editable Markdown; it is not native writer
authority. Operation IDs and expected revisions permit reconciliation of lost acknowledgements without replaying
external effects. No permanent daemon, mandatory hosted service, or second saved Plan is required.

The runtime location change does not move every resource to one logical owner. A Plan reference names an execution
attempt, while its registry owns the mutable publication phase. Git supplies delivery proof; Plan metadata retains a
permanent receipt only for established delivery. The same invariant applies when these owners run on different hosts.

Alternatives considered:

- **Leave execution runtime under project `.wld/internal/`.** This preserves current path assumptions but violates the
  owner's explicit local-configuration-only scope and leaves recovery tied to checkout storage.
- **Move the entire managed-remote runtime to the laptop.** This puts Git registries, staging/repair checkout files,
  and effects on different machines or requires source synchronization. Keeping execution files and their recovery
  context on the execution host preserves the current remote-project boundary without a laptop checkout.
- **Always use the execution account's Plan store.** This is correct for ordinary `wld`, including manual SSH, but
  contradicts the selected laptop ownership for `wld remote`.
- **Use the mounted laptop directory as the remote writer boundary.** A pathname does not establish native lock,
  SQLite, or durable-acknowledgement semantics. Owner-executed mutations make those guarantees explicit and reuse the
  existing remote personal-service boundary.
- **Keep checkout copies or a `.wld/plans` alias.** Copies preserve competing live authorities; the alias conflicts
  with keeping only settings and overrides in project `.wld/`. Expose live paths and authorized document operations.

Replacing Markdown with database-owned Plan bodies, retaining Git as live Plan storage, and requiring Workspace for
Core persistence are excluded by the existing plain-file, one-copy, and local-Core requirements.

## Implications

Changing this decision later requires a stored-data migration and new identity mappings, not a directory constant
change. Every caller must distinguish Project identity, personal owner, execution binding, and current cwd. Those
facts are resolved centrally so UI and workflow callers do not reconstruct paths or choose storage owners themselves.

Moving state across filesystems or hosts needs verified destination publication before source retirement. An active
lock cannot be copied into a new lock identity. Git worktrees and repair clones retain their changes and valid Git
registrations. Runtime adoption is automatic during deliberate actions; explicit Plan/Work Record import remains a
separate product behavior. No permanent migration marker or fallback runtime tree remains in project `.wld/`.

Manual SSH and managed remote execution can address the same repository while using different personal stores.
Matching Project IDs do not authorize automatic Plan synchronization or unfinished-attempt takeover. Losing the laptop
connection cannot switch managed remote execution to the remote user's Plan store.

Editors and external hosts need authorized access to a home path or supported document operations. A strict sandbox
may require its normal access grant. Losing home storage loses unpublished personal artifacts; same-disk milestone
history is not a backup. Multi-machine replication and real-time collaboration are separate decisions.

Reconsider the owner partition if RunWield adopts unattended remote workers or moves repository execution itself to a
hosted service. Neither follows from this Epic. Accepting this ADR requires reconciling conflicting ownership clauses
in the existing ADRs; do not keep two accepted physical-location rules for the same runtime resource.
