---
status: accepted
---

# ADR-017: Home-Owned Project Runtime State

## Context and Constraints

Project settings, Agent definitions, Skills, and prompts belong to the user's repository. Controller records, locks,
lifecycle journals, publication staging, registries, recovery files, indexes, diagnostics, and collaboration secrets
are machine-owned runtime. The owner requires ordinary execution to keep that runtime in account home storage and
leave project `.wld/` for configuration and overrides.

Stable Project identity is separate from repository and checkout identity. Linked worktrees share repository-owned
resources; explicitly linked clones share Project identity while retaining separate Git refs and execution attempts.
Legacy Plan Markdown and front matter remain authoritative until the separate Plan-package adoption.

Passive inspection must not admit identity, migrate files, probe writer locks, or reconcile old data. Deliberate
entry owns those effects. An interrupted transfer must preserve unfinished Git work and the publication proof defined
by [ADR-016](016-proof-bearing-publication-state-machine.md).

## Decision and Rationale

### Ordinary runtime ownership

Local execution and manual SSH execution use the executing account's home Project tree:

```text
~/.wld/projects/<projectId>/
  internal/<owner>/                         project secrets and Work Record index
  internal/legacy/<repositoryId>/<owner>/  legacy controllers, receipts and recovery
  execution/<repositoryId>/<owner>/        registry, staging, delivery evidence and relocated worktrees
    checkouts/<checkoutId>/                checkout journals, backups, locks and diagnostics
  execution-locks/<repositoryId>/<owner>/  native repository coordination
```

The owner segment is a fixed-length digest of explicit owner identity. Paths do not infer ownership from SSH variables,
a mount name, or the current directory. An explicit managed-remote launch retains its versioned checkout runtime under
[ADR-018](018-remote-ssh-local-personal-authority.md); ordinary adoption cannot claim its laptop-owned state. The broader
managed transport and Plan Store proposal remains in
[ADR-0020](0020-home-project-state-and-launch-mode-ownership.md).

The shared layout owner resolves these paths from stable identity. Resolving a path grants no read or write authority.
Registry, controller, sharing, indexing, transition, and diagnostic callers use the shared boundary. Canonical Plans
and Work Records retain their existing repository locations. Normal worktrees already under `~/.wld/worktrees/` keep
their locations. Missing home access is an actionable prerequisite; it never creates a checkout fallback.

### Recoverable transfer

Deliberate entry serializes adoption with native locks and quiesces legacy writers. It inventories regular and hidden
files, records source digests and destinations in a durable home journal, copies and verifies bytes and permissions,
publishes ownership and path mappings, and only then retires unchanged recorded sources. This supports distinct source
and destination filesystems. Native lock ownership is acquired afresh; copying lock bytes cannot transfer it.

Unknown files receive recorded home recovery destinations. Incomplete and already-applied old journals are validated
as migration evidence. Escaped paths, changed lock proof, conflicting bytes, symlinks at runtime authorities, newer
formats, and unreadable evidence preserve source work and produce precise refusals. No runtime marker, alias, or
replacement internal directory remains in the checkout after ordinary adoption.

Registered fallback worktrees are copied with their index, working files, and untracked contents; Git registration is
repaired before mutation resumes. Standalone publication repair clones retain their Git data. The same mapping updates
registry paths and publication execution, staging, repair, and revalidation references without advancing phases,
revisions, commits, or delivery proof. Normal publication remains the only authority for delivery.

Current controller decisions remain authoritative when old input returns. Recovery archives originals, imports missing
records, and can fill an absent completion report without reverting reviews or validation state. Distinct conflicting
attempts remain recoverable. SQLite index writers are quiesced before their projection moves; Work Records themselves
are not imported by runtime adoption.

### Passive inspection and Git protection

Passive list, read, and Doctor operations distinguish fresh, pending, ready, and blocked authority. Fresh Projects need
no identity or runtime files. In-flight migration is pending; an adopted store remains readable when legacy recovery
input returns. Every action checks authority anew. Bounded reads may share inspection, and Git answers may be reused
only while their repository metadata evidence is unchanged.

The managed `.gitignore` block retains `.wld/internal/` as a legacy safety boundary. The runtime classifier also
recognizes earlier flat paths. Tracked or staged runtime and collaboration secrets remain protected even after their
normal writers move home. `.wld/settings.json`, Agents, Skills, prompts, and overrides retain their exact bytes and
remain normal repository content; `.wld/` is never exempted wholesale.

## Alternatives and Implications

Keeping checkout runtime, retaining a compatibility symlink, and using rename-only migration violate the home-storage
and cross-filesystem requirements. Blind directory copying cannot establish Git registration, native lock ownership,
or delivery proof. Combining linked-clone registries would mix independent refs and unfinished attempts. These
alternatives are excluded by the owner's requirements.

Adoption is one-way. Older writers must settle before cutover; mixed-version writing is not supported. A valid
copy is not permission to delete a changed source. Failures remain recoverable intermediate conditions, and retry
continues the same transfer. Native file locks, verified copies, and durable journals cost more work than changing a
path constant, but preserve the user's unfinished work and permit restart without manual storage repair.
