---
planId: "f89f9ef2-95f1-4887-820e-95e1da5f2442"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/project-identity.ts"
    - "src/shared/session/file-session-storage.ts"
    - "src/shared/session/file-session-store-local.ts"
    - "src/shared/session/file-session-control.ts"
    - "src/shared/session/root-session.js"
    - "src/shared/session/session-resume-list.ts"
    - "src/shared/attached/record-store.ts"
    - "src/shared/attached/coordinator.ts"
    - "src/shared/owner-coordination/projects.js"
    - "src/shared/owner-coordination/index.js"
    - "src/ui/workspace/server/owner-projects.ts"
    - "src/ui/workspace/server/session-continuation.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/adr/015-file-authoritative-session-bundles.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-01"
origin: "internal"
parentPlan: "external-plan-store"
order: 2
dependencies:
    - "external-plan-store/establish-stable-project-identity"
targetBranch: "epic/external-plan-store"
userVerifiedAt: null
status: "in_progress"
---

# Preserve Session and Connect Continuity

## Context

This is the second child of the [External Project State and Plan Store Epic](../external-plan-store.md), refined against
the delivered first child on `epic/external-plan-store`. Only this child is authorized for review and subsequent
execution. Later children, runtime relocation, and merging the Epic to `main` remain outside this change.

The first child supplies an opaque Core Project ID, repository and checkout bindings, explicit clone-link decisions,
and owner context. Session bundles and Attached Workflow records still use path-derived directories. A rename keeps
the Core ID but loses ordinary lookup; a linked clone does not yet find existing history.

Current constraints verified in source:

- `project-identity.ts` stores `project.wld.json` and replaces a checkout's recorded root during admission. The old root
  must be retained as verified locator evidence before that replacement, including adoption after a move.
- `file-session-storage.ts` assigns legacy Session Project IDs, derives bundle locations from `currentRoot`, and
  restores manifests through those paths. `FileSessionManifestCache` also assumes one directory per Project.
- `root-session.js` validates transcript cwd separately but currently requires it to match the requested cwd.
  `session-resume-list.ts` scans only that cwd's encoded directory.
- `attached/record-store.ts` reports moved workflows instead of accepting another root. Its coordinator also checks
  root equality directly; changing the directory resolver alone cannot deliver continuation.
- Workspace has separate registration IDs. Its bridge resolves them through roots, and owner Session membership
  compares historical transcript cwd to the current root.

Owning requirements: add move/link continuity to [Session continuity](../../prd/runwield-core-prd.md#session-continuity)
and [Connect recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery), using the first child's
[stable identity](../../prd/runwield-core-prd.md#project-context-and-initialization). This delivers only the Session and
Connect portion of [Project identity](../../prd/plan-store-prd.md#project-identity). Preserve private history,
operation-scoped writer authority, registration access decisions, and request ownership. Plan/Work Record relocation
and managed-remote Project-store persistence remain targets.

## Objective

Existing Sessions and Connect workflows remain discoverable after Project moves or clone linking, with the same committed history, IDs, and native lock owner. This delivers continuity independently from the Plan format cutover.

## Approach

Record verified legacy storage locators against Project identity. Keep existing bundles, transcripts, recovery
descriptors, Attached Workflow records, and their lock paths in place. The binding resolves identity to storage; it
does not become transcript, workflow revision, or execution-attempt authority.

```text
deliberate Project entry / accepted clone link
  Core Project ID + personal owner + repository/checkout evidence
    recorded Session Project IDs -> existing bundle/transcript directories
    recorded repository binding -> existing Attached Workflow directories

Session/Connect read -> verified binding -> existing record and existing lock
continuation        -> selected current execution cwd + unchanged historical evidence
```

Extend the existing Project identity owner to persist typed locator bindings atomically under its native record lock.
Keep Session and Attached record validation in their existing stores. Readers consume committed bindings without
admitting identity or repairing it. Bind only evidence from an admitted checkout, its previously recorded root, or an
explicitly accepted clone link; a basename, remote match, workflow ID, or arbitrary home-directory hit is insufficient.
One Core Project can reference several legacy Session Project IDs and directories. Preserve those IDs in manifests
and receipts; translate membership through the binding instead of rewriting every record to the Core UUID.

Before committing a changed binding, existing Session writers must settle. Acquire the actual existing native locks
for the affected bundles, recheck evidence, and persist without moving or replacing the lock files. Preserve Attached
per-workflow locking and revision checks at the original record path. Record and follow one lock order; never wait on
a Session writer while holding a lock that its settlement needs. A failed or interrupted admission remains retryable
with its prior usable binding intact.

For Session continuation, validate the transcript using its saved header/segment cwd and recorded storage locator;
choose the current execution cwd from the admitted checkout or the existing workflow execution binding. Do not
rewrite historical cwd. A linked clone can discover the same history, but does not take over an active execution
attempt or reinterpret another repository's refs. Preserve existing Plan/worktree recovery if execution is pending.

For Connect, retain workflow IDs, accepted operation receipts, pending action IDs, and revisions during lookup/binding.
Resolve current paths separately from historical request and receipt evidence. A normal next operation advances the
existing revision exactly once. Use the same verified ownership check for status, latest-open restore, instructions,
review callbacks, and mutations; mere visibility through another linked clone does not authorize attempt transfer.

**Reviewable implementation assumption:** retain the current storage layout for newly created records in this child
too, recording their locators through the same owner. Stable-ID directory creation is unnecessary for continuity and
would add a second storage cutover. Rewriting transcripts or changing the global directory encoder would increase
migration risk without helping lookup. Local and manual-SSH launches use their execution-account home; existing
managed-remote Session ownership and save paths stay unchanged.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/project-identity.ts` and its entry callers — persist verified locator associations before old checkout
  evidence is replaced; preserve clone choices and the admission/read split.
- `src/shared/session/file-session-storage.ts`, `file-session-store-local.ts`, and `file-session-store-types.ts` — map
  Core and legacy IDs; enumerate multiple recorded stores; resolve caches, recovery descriptors, and new writes
  through the saved locator rather than recomputing a bundle from current cwd.
- `src/shared/session/file-session-control.ts` — retain the original operation-scoped native lock and generation checks.
- `src/shared/session/root-session.js`, `session-resume-list.ts`, `plan-session-lookup.ts`, and runtime loading callers —
  list and resume bound history while separating current execution cwd from historical transcript validation.
- `src/shared/attached/record-store.ts` and `coordinator.ts` — bind original record/lock directories and replace
  path-equality ownership decisions with verified Project/repository evidence, including callbacks and replay.
- `src/shared/owner-coordination/projects.js`, `index.js`, and Workspace `server/owner-projects.ts` and
  `session-continuation.js` — retain registration IDs/access policy and translate Session membership/current roots.
- Existing identity, Session, Attached restore, and Workspace continuation suites, plus focused continuity test files
  named below — exercise real stores and fresh processes rather than source-text assertions.
- Core and Connect PRDs, the transient Plan Store PRD's maturity text, ADR-015, and the narrow continuity clauses in
  proposed ADR-0020 — document this delivery without accepting the broader storage proposal.
- `docs/domain-language.md` — reconcile Project Identity's legacy-locator wording and Session/Attached relationships
  with delivered lookup behavior; do not introduce a new Session kind.

`project-directory-key.ts`, Project Runtime State placement, Plan document format, execution registry placement,
Memory, and metrics retain their current ownership and layout. Workspace changes are continuation plumbing, not UI
redesign or automatic registration of linked clones.

## Reuse Opportunities

- Reuse file-authoritative manifests, segment IDs, and existing Session writer-lock APIs.
- Reuse existing Attached Workflow record revisions and compatibility evidence rather than importing host transcripts.
- Reuse `inspectProjectIdentity`/`admitProjectIdentity`, private atomic JSON persistence, and the first child's
  repository/checkout and personal-owner evidence. Do not add a parallel identity registry or testing injection seam.
- Reuse the guarded transcript reader, committed-generation verification, archive filtering, and remote visibility
  checks; verified bindings expand permitted lookup without weakening those checks.

## Implementation Steps

1. `project-identity.ts` owns durable, backward-compatible locator bindings scoped to the personal owner and repository/
   checkout evidence. Deliberate entry binds existing Session Project IDs/directories and Attached directories before
   replacing old roots. Repeated entry, interrupted writes, and accepted clone linking converge without duplicate
   bindings or lost old-root evidence. Passive inspection writes nothing. A pending/declined clone link never gains
   access to another Project's storage; unrelated identity-record updates preserve locator fields.
2. Session storage resolves list, ID/path lookup, manifest cache refresh, descriptor recovery, cataloging, archive,
   segment rollover, and activation to the same original bundles. Bound legacy IDs remain valid, and multiple stores
   of an accepted linked Project are deduplicated by stable Session identity. Conflicting claims for one Session ID
   produce unavailable/conflict evidence rather than selecting the first directory. Recovery cannot create a second
   bundle or writer lock under the new cwd.
3. Binding changes wait for operation settlement and use the existing Session lock paths; active writers are never
   stolen. Two processes entering through a moved root, symlink alias, linked worktree, or accepted linked clone
   contend on one native Session Writer Lock. Existing generation, stale-writer, and owner-local remote-save checks
   remain effective. Failure preserves committed history and a retryable binding.
4. `listRecentResumableSessions`, `resolvePersistedRootSession`/`openPersistedRootSession`, Plan-associated lookup, and
   their runtime callers discover and resume bound Sessions from the current checkout in a fresh process. They verify
   saved headers, segment ownership, and committed prefixes using historical evidence, while tools run in the selected
   valid current execution cwd. A resumed message appends to the same Session; prior transcript bytes, Session/segment
   IDs, generation evidence, archive state, Plan Associations, and settings are preserved. Existing worktree execution
   ownership wins over a newly selected clone until normal workflow recovery authorizes a change.
5. `locateAttachedWorkflows`, record load/latest-open/transaction paths, and coordinator ownership checks use verified
   bindings. Fresh-process status and current instructions find the same workflow after a move; a compatible host's
   accepted next operation saves at its original path under its existing lock. Lookup alone changes no workflow
   revision, request, pending action, or operation receipt. Replaying an accepted operation remains idempotent. A
   linked clone may resolve a bound record but cannot silently transfer an execution attempt or bypass compatibility,
   consent, current-action, and revision checks. Foreign/unverified workflow hits retain the existing refusal behavior.
6. Workspace registration retains its ID, enabled/disabled/removed policy, and explicit registration decision. Its
   Session bridge and owner membership checks map to Core identity and verified legacy aliases rather than historical
   cwd equality. Existing registration relink reaches the same history; a linked clone is not automatically exposed.
   Missing Workspace SQLite does not prevent Core listing, activation, or continuation of intact local Sessions.
7. The owning PRD capabilities gain named move/link continuity requirements and acceptance scenarios. ADR-015 explains
   stable lookup with unchanged physical bundles/native locks; ADR-0020 and the transient proposal distinguish this
   delivered portion from later relocation. The glossary agrees with the code and preserves the distinction between
   Session, Attached Workflow, Project identity, and repository binding. No later child is marked delivered.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks. Add the two focused continuity suites below; they are
planned test files, not existing passing evidence. Run them with the related regressions, then `bun run ci`:

```sh
bun scripts/run-tests.js src/shared/session/project-continuity.test.ts src/shared/attached/project-continuity.test.ts src/shared/project-identity.test.ts src/shared/project-identity.integration.test.ts src/shared/session/file-session-storage.test.ts src/shared/session/file-session-store.test.ts src/shared/session/file-session-store-owner.test.ts src/shared/session/session-resume-list.test.ts src/shared/session/root-session-locator-classifier.test.ts src/shared/session/plan-session-lookup.test.ts src/shared/session/remote-project-identity.test.ts src/shared/session/local-project-visibility.test.ts src/shared/owner-coordination/file-session-bridge.test.ts src/shared/owner-coordination/projects.test.ts src/shared/attached/status-restore.test.ts src/shared/attached/compatibility.test.ts src/ui/workspace/session-continuation.integration.test.ts
bun run ci
```

Use real file stores, real repositories (`defineGitFixture`), disposable homes, and existing Attached fixtures.
Wrap HOME/cwd mutation in `withProcessGlobalTestLock`. New tests must use production entry/read/continuation paths;
preseeding the proposed binding JSON is not proof that admission works. Do not add seams for Core-owned persistence.

- **Session move and real continuation — `session/project-continuity.test.ts`:** seed a legacy multi-segment Session,
  committed generations, Plan Association, and archive/settings evidence. Admit identity, rename a Git Project, reopen
  in a new process, discover through the ordinary resume list, and append through normal activation/settlement.
  Assert the same IDs and original manifest/lock paths, unchanged historical headers and old byte prefixes, one new
  committed message, and tool execution in the new root. Repeat for a non-Git marker and a move between first-child
  identity admission and this child's locator adoption. A path-hash pass-through fails discovery and continuation.
- **Linked stores and isolation — the same suite:** seed history in separate clones before accepting a link; both
  histories become reachable with original IDs and no duplicate entries. Repeat with linked worktrees and aliases.
  Declined/pending links, unrelated Projects, different owners, remote locators, a reused old directory, and retargeted
  symlinks must not expose or mutate that history. An active Plan's recorded repository/worktree remains authoritative.
- **One writer and restart — the same suite:** a separate process holds the legacy bundle's native writer lock while
  a second enters after a move. Binding must not switch and no second lock/bundle appears. After settlement, retry
  succeeds; two aliases then race activation and exactly one wins. Interrupt/retry binding publication and restore a
  damaged manifest from the existing descriptor; recovery resolves to the original bundle. Verify a stale generation
  still fails and binding updates preserve unrelated Project fields. These checks reject copying bundles to new paths.
- **Connect move and next action — `attached/project-continuity.test.ts`:** activate and save a pending action through
  the real coordinator, bind, move, then use fresh-process status by ID and latest-open restore. Assert unchanged
  workflow/request/action IDs, revision, receipt bytes, and original record/lock path. Fetch instructions and complete
  the pending operation once; replay its operation ID and confirm one revision advance. Exercise accepted-clone
  lookup, concurrent operations through aliases, a foreign workflow ID, declined link, and incompatible host. Existing
  execution evidence remains tied to its repository. A resolver-only change fails the coordinator's next action.
- **Workspace and independent Core — bridge, projects, and continuation suites:** retain registration IDs while
  relinking a moved root, resume the same Session, and enforce disabled/removed registration and foreign membership
  checks. Remove the fixture SQLite database and reopen Core; list and append to that Session without reconstructing
  authority from database rows. Re-registering restores owner visibility without creating a second Session.
- **Missing/corrupt evidence and passive reads — identity/continuity suites:** omit or damage a bound locator and
  retain an unrelated store with similar names. Return unavailable/conflict evidence; do not create empty history,
  guess another Project, or change ownership. Snapshot file names, bytes, and mtimes around identity inspection,
  inspect-only Connect status, and read-only Session access. No binding, migration, repair, or lock creation occurs.
- **Regression contracts:** retain committed-prefix validation, archive filtering, worktree repair-segment resume,
  Plan Association lookup, private owner membership, remote-history exclusion, and laptop-native save authority. Update
  obsolete path-only assertions to exercise verified bindings; do not delete their foreign-path rejection coverage.
- **Manual acceptance in disposable Projects:** save a Session and a Connect workflow, move the Project, resume each
  through its ordinary surface, and verify a next Session message and next Connect action succeed. Exercise the
  accepted/declined clone choice. This is isolated QA, not permission to move the working repository.
- **Semantic Review:** trace production entry to locator publication and each consumer to the original record/lock;
  verify the new tests fail with only the first child's identity implementation. Confirm documentation describes only
  this delivered scope. Preserve file-authoritative history and request privacy; retire cwd as sole lookup authority
  for bound records, without claiming unproven automatic recovery for unbound legacy data.

## Edge Cases & Considerations

- A missing legacy directory is not permission to create an empty replacement history.
- A move before any stable identity/root association existed may lack proof tying legacy history to the Project.
  Preserve the records and report unavailable evidence; do not infer ownership from a matching name or remote.
- Keep legacy project IDs usable in manifests, generation proofs, receipts, and recovery descriptors. A cache hit must
  recheck requested Project membership; cached data cannot bypass the new binding check.
- Linking two repositories shares lookup only after explicit acceptance. It does not merge settings, registrations,
  host trust, Session writer ownership, or Git execution attempts.
- Metrics and general Memory namespace migration stay outside this child.

Research checked against primary documentation: [Git worktree configuration and repair](https://git-scm.com/docs/git-worktree)
supports shared repository identity with distinct checkout administration; [Node filesystem operations](https://nodejs.org/api/fs.html)
provides file/open/rename primitives, not proof of native cross-platform locking. Existing RunWield native-lock and
durability code remains authoritative implementation evidence; real process tests must establish exclusion.
