---
planId: "cd3a9537-e591-401e-bc68-f0bf464e2881"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/project-identity.ts"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/project-directory-key.ts"
    - "src/shared/owner-coordination/projects.js"
    - "src/shared/remote/personal-resources.ts"
    - "docs/domain-language.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 1
dependencies: []
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
validatedCommit: "c2c95957459d2f9ff7b9d073f6b4f41a82022969"
status: "verified"
---

# Establish Stable Project Identity

## Context

This Plan implements one slice of the [External Project State and Plan Store Epic](../external-plan-store.md).
Existing local Session identity and several home directory keys derive from filesystem paths. Home Project storage needs a stable identity before any data moves.

Owning requirements: [Project identity](../../prd/plan-store-prd.md#project-identity); [Project initialization](../../prd/runwield-core-prd.md#project-context-and-initialization). The proposed additions are stable identity, explicit owner/execution bindings, and remembered clone linking. Plan and Session continuity remain later-child targets; preserve existing locators and the current directory-consent and remote-host-verification behavior.

## Objective

Local and manually SSH-started `wld` can resolve one stable Project across folder moves and linked worktrees, while managed remote startup can name a different personal owner explicitly. This slice establishes real entry and lookup behavior without moving Plans or existing runtime files.

## Approach

Separate side-effect-free inspection from deliberate identity admission. Shared local Git configuration binds linked
worktrees; a non-Git identity file outside `.wld/` survives until Git adoption. Repository-instance and checkout bindings
remain distinct from Project identity. A remote URL only suggests a one-time, remembered clone-link decision.

```text
entry context -> Project identity + personal owner + execution binding
passive lookup -> existing identity, or fresh/pending; never writes
```

`src/shared/project-identity.ts` owns inspection, admission, and clone-link decisions. Wire admission into the existing
`enterProjectRuntime` deliberate boundary and its entry adapters; preserve `ProjectRuntimeLayout` paths and the current
runtime migration behavior. Pure layout resolution, discovery, and inspection must never call admission. Init and
Attached entry already reach this boundary; verify the ordinary startup path also reaches identity admission.

For local and manual-SSH execution, use generated opaque IDs and a versioned identity-only record at the personal owner's
`~/.wld/projects/<projectId>/project.wld.json`. Record repository and checkout bindings separately; a linked clone shares
the Project ID only after consent and never shares its repository binding. Keep any lookup index rebuildable from these
records. Workspace registration IDs remain existing registration identifiers with an explicit association to Core identity.

Implementation assumptions: use `runwield.projectId` in the Git common directory's own `config` and `.wld-project.json`
for a non-Git marker. Read the exact config file with includes disabled, rather than effective configuration; persist
repository-instance identity there too, and use each checkout's Git administrative directory for its distinct binding.
Resolve Git common and administrative directories with Git, including linked worktrees and subdirectory entry. The
[Git worktree configuration](https://git-scm.com/docs/git-worktree#_configuration_file) and
[Git config scope documentation](https://git-scm.com/docs/git-config) establish why global and worktree settings cannot
supply the shared identity. These private names can change during implementation without changing behavior.

A matching remote produces a typed pending choice naming known Projects. The deliberate entry adapter presents the
choice and resumes with a specific Project or a new Project; unavailable interaction returns that pending choice and
never treats it as decline. Persist accepted and declined choices against the new repository instance. Multiple matches
require selecting one candidate; cancellation saves no answer. Remote comparison is candidate evidence, never authority.

Explicit launch context supplies personal owner and execution account separately. Ordinary execution uses its account
home regardless of SSH environment variables. Managed remote activation can supply the laptop owner identity; this slice
records that context but does not introduce a remote store protocol or write identity records through an SSHFS mount.
Keep managed-remote identity context distinct from persistence work assigned to later children; existing remote startup
and Session ownership must continue to work during this intermediate slice.
Preserve `configureRemotePersonalResources` mount validation and use the existing verified activation boundary.

Do not replace `encodeCwdForSessionDir` globally: that would silently move unrelated home stores before their owners are ready.
A central identity owner avoids having each caller interpret Git configuration; using Workspace SQLite instead would
make ordinary Core startup depend on an optional surface.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/project-identity.ts` and focused tests — authoritative identity, binding persistence, and clone-link decisions
- `src/shared/project-runtime-layout.ts` and deliberate entry adapters — invoke admission while preserving passive reads and runtime paths
- `src/shared/project-directory-key.ts` — keep legacy path encoding explicit during adoption
- `src/shared/owner-coordination/projects.js` — map existing Workspace registration rather than make it Core authority
- `src/shared/remote/personal-resources.ts` — distinguish ordinary execution from activated laptop personal resources
- `docs/domain-language.md` — Project Identity and repository-binding relationships
- `docs/prd/runwield-core-prd.md` and the identity subsection of `docs/prd/plan-store-prd.md` — current identity requirements and explicitly remaining continuity targets
- `docs/adr/0020-home-project-state-and-launch-mode-ownership.md` — reconcile identity decisions if implementation changes them; do not claim the whole proposed relocation has shipped

## Reuse Opportunities

- Reuse the existing primary-checkout resolver and owner-coordination root mappings.
- Reuse `private-json-file.ts` atomic replacement for private home records and `native-file-lock.ts` for cross-process admission; Git config stays the local repository binding. Do not chmod the project directory by applying the private-directory helper to its marker parent.

## Implementation Steps

1. `project-identity.ts` exposes separate inspection and deliberate admission operations with typed results. Admission
   returns stable Project ID, personal owner, execution account home, repository binding, checkout binding, and cwd.
   Inspection reports existing identity, fresh state, pending decision, or invalid evidence without creating directories,
   lock files, markers, or Git config entries. No path-derived or remote-derived value becomes Project ID.
2. Real deliberate entry through `enterProjectRuntime` and ordinary startup admits identity once. A common-repository
   admission lock and reread prevent two processes or worktrees from minting competing identities. Committed Git identity
   is authoritative after interruption; a retry repairs missing home binding metadata without minting a replacement.
   Missing/corrupt evidence must not overwrite unrelated data or silently select a different Project.
3. Shared Git configuration excludes global, included, command-injected, and per-worktree overrides for identity.
   Linked worktrees and subdirectories resolve the same Project and repository binding, with distinct checkout bindings.
   Moves and remote edits retain identity; separate repositories with identical names remain distinct.
4. A non-Git `.wld-project.json` marker preserves identity across folder moves and subsequent `git init`. Admission
   durably records and verifies the same identity in Git before removing only its own valid marker. A conflicting Git ID,
   malformed/user-owned marker, or symlink preserves the files and reports a precise conflict. Settings and overrides
   remain byte-for-byte unchanged; no identity file is added to the Git index.
5. Fresh-clone matching is based on recorded remote evidence from admitted Projects. Pending choice, explicit accept,
   explicit decline, and cancellation have distinct outcomes. Acceptance reuses the selected Project ID and creates a new
   repository binding; decline creates a separate Project and is remembered. Reopen does not ask again. Revalidate the
   candidate under admission before committing a choice; changed evidence cannot silently choose another Project.
6. Explicit owner context distinguishes local/manual-SSH execution from managed remote activation, without inferring
   ownership from cwd, a remote URL, `SSH_*`, or a mount pathname. Existing Workspace registrations associate with Core
   identity without becoming its authority, renumbering existing registrations, or moving Sessions. An absent Workspace
   database does not prevent Core entry. Remote transport, native-lock service operations, and store migration remain
   outside this child.
7. New TypeScript behavior uses named types and real persistence, with no new injection seams for owned machinery.
   Legacy Session, Plan, workflow, metrics, and worktree storage paths and lock authorities remain unchanged.
8. Core Project initialization requirements and scenarios, the proposal's identity maturity, and glossary Project /
   Project Identity / repository and checkout relationships match delivered behavior. Replace the glossary's implication
   that a Project must be registered in Workspace. Preserve current Session and runtime-placement guidance and mark their
   migration as target; do not retire the transient PRD before the Epic finishes.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Existing focused regression command:

```sh
bun scripts/run-tests.js src/shared/project-directory.test.ts src/shared/owner-coordination/projects.test.ts src/shared/remote/personal-resources.test.ts
```

Add and run these focused behavior tests (new files, not an existing passing inventory):

```sh
bun scripts/run-tests.js src/shared/project-identity.test.ts src/shared/project-identity.integration.test.ts src/shared/project-runtime-entry.integration.test.ts src/shared/project-runtime-passive-access.test.ts
```

Use `defineGitFixture`, real stores/repositories, disposable homes, and child processes for concurrent admission.
Use `withProcessGlobalTestLock` for HOME/cwd changes and `getHomeDir()` / `getCwd()` rather than direct environment reads.
Do not add injection seams for Core-owned persistence or lifecycle rules.

- **Identity persistence:** admit via the actual entry boundary, reopen in a new process, create a linked worktree,
  rename the checkout, and change/remove its remote. Assert the same opaque Project ID, one repository binding, and
  distinct checkout bindings. Two independent same-basename repositories must have different IDs. This fails a path
  hash, constant-ID stub, or in-memory-only implementation.
- **Config isolation:** poison global config, an included file, command-scope config, and worktree config with other IDs;
  verify only the common config's own value is authoritative and unrelated settings survive writes.
- **Concurrent entry and recovery:** start two independent processes on an unadmitted repository; assert identical IDs
  and one committed binding. Exercise a committed Git ID with missing home metadata, then retry and verify that the ID
  is preserved. Repeat non-Git first-entry concurrency.
- **Passive reads:** snapshot names, bytes, and modification times of the fixture home, project, and Git configuration;
  inspect fresh, admitted, pending, and malformed identities and run existing passive runtime scans. Assert no change,
  including no lock or home directory creation.
- **Clone choice:** use a real local remote and separate clones. Accept and decline, reopen in fresh processes twice,
  and verify persisted results and distinct repository bindings. Cancel and unavailable interaction must save no answer.
  Multiple candidates must never choose implicitly.
- **Adoption:** admit non-Git, move it, run `git init`, and enter again. Assert unchanged ID, removed valid marker,
  unchanged settings/overrides, and no indexed identity file. Conflicting/malformed/symlink markers stay untouched.
- **Owners and compatibility:** ordinary entry with SSH environment markers keeps execution-account ownership; explicit
  managed-remote context names a different owner without changing execution home. No fallback owner on disconnect.
  Existing mount identity/escape checks, directory consent, Workspace registration rules, and absent-database Core entry
  remain protected. Snapshot legacy Session and runtime paths so an encode-key replacement fails the test.
- **Manual:** create a non-Git Project through deliberate entry, initialize Git, move it, then enter a fresh matching
  clone. Exercise the presented accept/decline choice and confirm the remembered result and separate binding.
- **Semantic Review:** trace actual startup to admission and passive readers to inspection. A standalone unused identity
  module cannot satisfy this Plan. Verify owning PRD scenarios and glossary describe only this child's delivered behavior.
- **Preserve:** existing runtime admission/recovery, legacy storage locators, remote-host trust, and registration IDs.
  **Retire:** cwd/remote as authority for newly admitted identity; legacy Session lookup remains unchanged for now.

## Edge Cases & Considerations

- `.wld-project.json` collisions, symlinks, malformed IDs, and conflicting Git/marker identities preserve user files; report the specific evidence instead of overwriting it.
- Read/write failure cannot fall back to a new ID or another owner. Identity operations do not move Plans, runtime files, Sessions, metrics, or Memory collections.
- No sibling scope changes: remaining children and Epic migration work stay untouched.
- No mandatory Workspace database or hidden global identity value.
