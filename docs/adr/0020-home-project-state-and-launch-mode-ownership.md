---
status: proposed
---

# Home Project State and Launch-Mode Ownership

## Context and Constraints

Live Plans currently follow checkout/branch ownership. Ordinary runtime and Sessions live in home storage;
explicit managed-remote runtime retains its admitted checkout layout until its transport cutover. This splits a Project's
workflow across paths that change as work moves between planning, execution, publication, and recovery.

The owner confirmed these target constraints on 2026-11-01:

- The complete Plan Store proposal is in scope, including Work Records, delivery copies, history, and retention.
- All `.wld/internal/` state moves under `~/.wld/projects/<projectId>/`. Project `.wld/` keeps only local settings and
  user overrides; it does not retain a Plan-store link or a runtime compatibility directory.
- Ordinary `wld` owns Plans on the machine/account where it executes. Manual SSH followed by `wld` is ordinary
  execution on the remote machine.
- `wld remote <host>` keeps Plans on the initiating laptop, while code execution stays remote.

This ADR proposes the mechanisms that implement those constraints. It is not accepted guidance or evidence of shipped
behavior. [ADR-015](015-file-authoritative-session-bundles.md),
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
