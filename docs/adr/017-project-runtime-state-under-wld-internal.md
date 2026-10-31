---
status: accepted
---

# ADR-017: Project Runtime State Lives Under `.wld/internal/`

## Context

Project `.wld/` contains two different kinds of data. Users can commit project settings, Agent definitions, Skills, and
prompt templates. RunWield also stores controller records, locks, lifecycle journals, publication staging, worktree
registry data, recovery reports, debug data, and project-local collaboration secrets there.

The runtime files currently use many separate `.gitignore` entries. This makes RunWield changes noisy and makes it easy
for a new runtime file to miss Git protection. It also hides the intended boundary between project configuration and
machine-owned state.

The runtime paths do not all use the same checkout. The worktree registry and controller records are shared through the
primary checkout. Plan document locks and some transition journals belong to the selected document checkout. Publication
staging, registry migration reports, and project collaboration secrets require explicit primary ownership. Publication
records can also name an unfinished checkout by absolute path. These ownership rules and corrections must survive a
storage-layout change.

Plan listing, browsing, indexing, and progress inspection must not prepare their sources. The owner accepts pending
workflow details when safe authority is not yet available. Automatic migration and recovery remain the responsibility
of deliberate actions and active workflows, not permission implied by a read.

## Decision

### One reserved runtime root

RunWield Core 0.11.0 reserves `.wld/internal/` in each applicable project checkout for machine-owned project runtime
state. The project `.gitignore` managed block contains one runtime entry:

```gitignore
# BEGIN RunWield owned runtime state
.wld/internal/
# END RunWield owned runtime state
```

User-derived project files remain outside this directory. This includes `.wld/settings.json`, `.wld/agents/`,
`.wld/skills/`, and `.wld/prompts/`. RunWield does not classify these paths as runtime state.

The location does not change authority:

- Primary-checkout runtime state includes controller records, the worktree registry and its lock, publication staging,
  registry migration reports, the project collaboration secret store, and project-wide migration metadata.
- Selected-checkout runtime state includes Plan document locks, transition journals, and the Work Record supersession
  and supersession-recovery locks that protect a document or checkout-local operation.
- Home-directory state under `~/.wld/` is not part of this decision. Normal execution worktrees remain under
  `~/.wld/worktrees/`. Only the existing no-home project fallback moves under the project internal root.

A shared path module defines the internal root and named paths. Runtime owners use those definitions instead of
constructing `.wld` runtime paths independently.

### One-way 0.11.0 migration

The first 0.11.0 action-owned project entry performs one serialized, durable, idempotent migration of eligible 0.10
project state before mutation locks or writes. Migration preflight can read legacy registry, lock, publication, and Git
evidence. Submitted TUI and Agent Client Protocol work, headless workflows, Init, selected Plan loads, deliberate saves,
and collaboration mutations use this operation. Passive Plan commands, help, and version do not migrate. A new empty
TUI remains in memory until the first submitted message.

Doctor check-only inspection uses the passive boundary below, without locks, lock probes, or writes. Inspection reports
blocked, pending, or adopted facts; pending inspection is not adoption. Repair still enters through guarded migration
and repeats preflight.

The migration adopts inactive legacy runtime data, writes a versioned layout marker, and then reconciles `.gitignore`.
The primary marker records the selected checkout roots included in the completed adoption. Registered execution
checkouts are adopted before the marker commits. A selected checkout first seen later is adopted and added to that
manifest under the same project migration lock before mutation uses its runtime stores. An interrupted migration has a
durable phase record and resumes from verified source and destination facts; a partial destination is not treated as an
independent authority.

The migration resolves primary-shared state to the primary checkout and preserves selected-checkout ownership for
document-local state. Before a completed adoption marker, it does not infer ownership between independently populated
authorities. After that marker, the internal controller owns workflow decisions. Recreated legacy controller, journal,
backup, and lock directories are recovery input, not a second authority and not grounds to reject ordinary Plan access.

Action-owned recovery runs under the migration journal and lock. It saves content-addressed original copies before changing any
record, imports missing files, and fills an absent completion report without replacing current controller decisions,
execution identity, validation counters, or publication evidence. It does not infer validation success from an old
report. Conflicting old records remain in the recovery archive; timestamps and revision numbers from independent writers
are not sufficient reasons to overwrite the adopted controller. Replaying interrupted recovery is idempotent. Controller
inode locks remain stable while their data files are retired, so an older waiter cannot acquire a different lock inode.
Empty legacy directories and dormant controller lock files do not block entry.

This ownership rule also covers recreated registry files, migration reports, and debug data. An empty or stale legacy
registry cannot replace current attempts or reset publication progress. Distinct legacy attempts are imported only after
checkout and identity checks; ambiguous attempts keep both copies intact. Registry recovery holds both registry locks,
archives originals, and journals retirement. Normal registry operations enter the runtime before taking their lock and
retain that checked layout for the operation, avoiding migration re-entry while holding a lock recovery needs.

RunWield 0.11.0 does not support downgrade or concurrent use with an older RunWield process after migration. Current
processes use one migration lock. The legacy registry lock is held from publication preflight through durable marker
commit and retirement of legacy authoritative data; it is released before its own obsolete lock file is retired. Each
other legacy lock is tested during action admission with its real protocol: a persistent controller lock file is not
evidence of a live writer,
while registry, Plan, and Work Record locks retain their existing ownership and stale recovery rules. A proven live
writer causes a safe stop. Readers reject a layout marker newer than they understand.

Unfinished publication and merge-repair records migrate with the registry without changing their recorded checkout
paths. Existing publication copies remain where they are, including uncommitted repairs. Loading a Plan can therefore
resume publication after upgrading; migration neither publishes nor cleans up those copies. New attempts use the
internal staging root. Unclaimed legacy staging files are preserved, not treated as a reason to block project entry.
Retained copies are payload, not a second registry authority.

Project collaboration secrets move only after Git tracking, symlink, source, and destination conflicts are checked.
Migration discovers the old project-local store in the primary and selected checkouts and moves one source to the
primary internal store. It refuses multiple populated sources instead of choosing or merging them. The migration does
not follow a symlink at the internal root or a runtime authority path; it stops before reading or writing outside the
applicable checkout. Repository payload symlinks inside a real publication checkout remain normal Git content and are
not traversed during runtime inspection. If Git tracks any legacy or current runtime authority, migration stops and
requires explicit repository cleanup; `.gitignore` cannot untrack it. A tracked secret also requires a security warning
and capability rotation guidance. The new internal directory and secret file retain restrictive permissions where the
platform supports them. The migration never keeps two writable secret stores.

### Git behavior during and after migration

The current runtime classifier owns `.wld/internal/` and all descendants. Git staging, dirty-path checks, publication,
and cleanup use that boundary.

A separate legacy-safety classifier continues to recognize known 0.10 runtime paths. It exists only to migrate old
state, preserve and recover returning old writes, and prevent accidental commits. Normal runtime stores use the internal
root; publication alone can resume an existing checkout at the absolute path in its migrated receipt.

Gitignore reconciliation replaces managed legacy blocks, removes exact obsolete RunWield runtime lines and duplicates,
and emits the canonical block. While a legacy runtime directory remains, the block also ignores that path so retained
repositories and old-writer lock files cannot be accidentally staged. It preserves unrelated user content. A broad user
rule such as `.wld/` is not removed automatically because RunWield cannot know the user's intent; RunWield reports that
the rule also hides trackable project configuration.

Tracked legacy runtime files require explicit repository cleanup. RunWield does not silently rewrite repository history
or claim that `.gitignore` can untrack files. Secrets already committed to Git cause a security warning and require
credential or capability rotation as applicable.

### Passive inspection and action preparation

Path resolution is not safe-access proof. `inspectProjectRuntimeReadAccess` checks local authority without entering
migration, probing writer locks, or recovering legacy input:

- A fresh Project exposes local documents and empty runtime facts without creating storage or a marker.
- Safe adopted state exposes current controller, registry, and registered document-worktree authority. Returning legacy
  recovery input does not replace that authority or cause read-time recovery.
- Unmigrated or interrupted state leaves workflow details pending. Inspection does not combine partly moved stores,
  infer journal completion, or restore files.
- Unsafe or unreadable authority retains its specific diagnostic, including symlink escapes, newer markers, tracked
  runtime state, identity conflicts, and unreadable registry data. It is not an authoritative empty catalog.

Registry list/find and controller inspection are pure projections. Named action preparation owns registry schema and
identity migration, controller import, and obsolete recovery-hint cleanup. Saves, selected Plan loads, lifecycle
actions, execution, recovery, and publication prepare before relying on workflow authority. Preparation retains existing
locks and revision checks; a pending projection cannot authorize a write.

Target discovery and body hydration use locally available Git refs and objects, without temporary document files,
fetch, or clone. Missing local target evidence is unavailable, not proof of no children. Fresh remote publication proof
belongs to actions under [ADR-016](016-proof-bearing-publication-state-machine.md). Passive inspection does not change
sources, reconcile ignore rules, assign identities, clean journals, change refs/worktrees, or queue those effects.
In-memory reuse and the search service's own derived index/status writes are allowed.

Plan read availability (`ready` or `pending`) is transport metadata, separate from Front Matter and lifecycle status.
Safe local documents remain browseable, including ID-less drafts by name. Pending information neither adopts a Plan
nor permits execution. Search skips ID-less Plans and withholds uncertain Plan facts while retaining healthy results.
No complete legacy reader, read-triggered repair service, or mandatory Doctor step is required.

### Repeated inspection and entry

Each operation checks authority again because older writers, users, and Git can change runtime evidence. Nested passive
reads share inspection only within one bounded operation; the scope expires at settlement, including for surviving async
descendants. Plan content and workflow facts are not cached across requests. Inspection results never satisfy action
admission. `enterProjectRuntime` repeats mutation preflight and invalidates surrounding inspection reuse before and after
entry, even in the same async chain.

Preflight's two Git questions, attached worktrees and tracked runtime paths, are answered only from repository metadata.
An earlier Git answer can be reused while a stat fingerprint of that metadata is unchanged: `.git`, the index, `HEAD`,
config, and each linked worktree's administrative files. A result is not reused when its metadata changed within the
timestamp-resolution window or while Git ran, when Git location is overridden through the environment, or when the
metadata cannot be located or names a symlink instead of a regular metadata file. This Git-evidence reuse does not cache
runtime admission. RunWield-owned marker, journal, legacy-path, and symlink checks remain operation-scoped; real lock
admission remains action-owned.

## Consequences

- A new project runtime capability can stay Git-safe by storing its data under one reserved root.
- Users can commit project settings, Agents, Skills, and prompts without maintaining an exception list.
- Runtime owners retain their current primary-checkout or selected-checkout semantics.
- Upgrade is automatic for inactive projects, including unfinished publication and repair. It safely stops for live
  older writers, malformed evidence, or conflicting authorities.
- Downgrade after adoption is unsupported. Recreated legacy directories recover automatically on action entry rather
  than stranding Plans; passive reads keep adopted authority without recovery. This is not concurrent-version support:
  live older writers still require their real locks during action admission, and conflicting
  worktree registries or secrets cannot be resolved by blindly choosing the newest file.
- A populated project-local fallback worktree directory is preserved and blocks adoption. RunWield does not move its Git
  worktrees or rewrite their recorded paths. An absent or empty fallback directory does not block adoption.
- Documentation and recovery messages must use the new paths while explaining the one-way 0.11.0 boundary.
- Passive reads can expose pending details instead of repairing them. A deliberate action prepares automatically, and
  the next read rechecks availability. No new lifecycle state or browser pattern is needed.
- Repeated checks avoid Git processes while repository metadata is unchanged. A Git change that rewrites the index,
  `HEAD`, config, or worktree metadata is seen on the next operation.

## Options Not Taken

### Keep the enumerated legacy paths

This avoids migration but keeps the noisy `.gitignore` contract and requires every new runtime capability to update
several Git-safety mechanisms. It does not establish a clear ownership boundary.

### Ignore all of `.wld/`

This gives one ignore entry but also hides user-derived settings, Agents, Skills, and prompts. It conflicts with the
intended repository configuration model.

### Move active publication recovery automatically

A migration could move a saved publication clone and rewrite its absolute registry paths. A process stop between those
effects could separate validated work from its recovery authority. The rare upgrade interruption does not justify this
risk.

### Support old and new versions concurrently

This requires both legacy ignore entries and two compatible lock namespaces. It permits old processes to recreate old
authorities after migration and defeats the single-root result. Version 0.11.0 is an explicit breaking boundary instead.

### Prepare runtime state during every read

This would hide initialization, migration, lock probes, and recovery inside browsing and search. It conflicts with the
owner's no-source-effects constraint. Document-only parsing everywhere was also rejected because it loses registered
worktree authority and current controller decisions. Checked inspection with pending availability preserves both rules;
a complete reader for mixed legacy/interrupted migration state is outside the chosen boundary.

### Retain verified entry for the process lifetime

Long-lived TUI and Workspace processes would stop noticing recreated legacy files, planted symlinks, newer layout
markers, newly tracked runtime paths, and newly attached worktrees. Fingerprinting only Git's metadata keeps the Git
process savings while leaving every RunWield-owned check live.
