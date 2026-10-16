---
planId: "008e8278-adbc-4d9e-8edc-ef4ff0c0bebb"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/constants.js"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/runwield-owned-paths.ts"
    - "src/shared/collaboration/secrets.js"
    - "src/cmd/plans/share.ts"
    - "src/cmd/plans/pull.ts"
    - "src/cmd/plans/collaboration-commands.integration.test.ts"
    - "src/shared/collaboration/secrets.test.js"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-29T03:04:59.168Z"
status: "validated"
origin: "internal"
parentPlan: "consolidate-project-runtime-state"
order: 5
dependencies:
    - "04-move-selected-checkout-runtime-stores"
userVerifiedAt: null
targetBranch: "epic/consolidate-project-runtime-state"
---

# Move Project Collaboration Secrets

## Context

RunWield has a global collaboration secret store under `~/.wld/` and a project-local secret store under
`.wld/collaboration-secrets.json`. The Epic keeps the global store unchanged and moves only the project-local store
below the primary checkout internal root.

The migration engine handles adoption and conflict refusal. This child Plan moves the active project secret path and
preserves security behavior. ADR-017 and the parent Epic settle primary-checkout ownership and the unchanged global
store. Child 04 must finish first. Child 06 wires migration guards; child 07 finishes managed ignore-rule cleanup and
Git safety; child 08 owns Doctor and broader documentation. This child does not claim upgrade entry is complete.

## Objective

Make project-local collaboration secrets primary-owned runtime state under `../../../../.wld/internal`, while keeping
global secrets under `~/.wld/`. The project code must not read and write two project secret stores as authorities.

## Approach

Keep `getProjectSecretStorePath()` synchronous and return
`resolveProjectRuntimeLayout(projectRoot).primary.projectSecretStorePath`. Keep the existing secret document format,
atomic write behavior, redaction, and restrictive file modes.

Before and after:

```text
before: <supplied checkout>/.wld/collaboration-secrets.json
after:  <primary checkout>/.wld/internal/collaboration-secrets.json

share / pull / push / unshare
  getProjectSecretStorePath(selected checkout)
    resolveProjectRuntimeLayout(...).primary.projectSecretStorePath
  existing secret reads and writes
```

Share and maintainer-URL pull retain their pre-write `ensureProjectSecretStoreIgnored()` call. That helper resolves the
primary checkout and calls `ensureRunWieldOwnedGitignoreBlock(primary.checkoutRoot)`, instead of appending a separate
secret-file rule. Ensure the primary directory exists before that call. The shared block already protects internal state
and atomic temporary files. It still includes legacy entries at this stage; child 07 removes those. Do not add a second
ignore formatter here.

Avoid an import cycle: layout and owned-path code currently import `PROJECT_SECRET_STORE_RELATIVE_PATH` from secrets.
Move that constant to `../../../../src/constants.js`, retaining its **legacy** value and a compatibility re-export from
secrets. Layout migration and legacy Git hazard checks import it from constants. They must not treat the new active path
as the legacy source.

Global/project preference, fallback between those two stores, and legacy Plan-only record keys stay unchanged. Those are
not fallback to the old project file. Plan documents remain in their selected checkout.

The main option set aside is keeping project collaboration secrets beside `../../../../.wld/settings.json`. That would
avoid migration, but it would keep secrets in the user-trackable configuration area.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `../../../../src/shared/collaboration/secrets.js` — move project path resolution and delegate ignore protection to the
  shared managed-block writer at the primary checkout.
- `../../../../src/constants.js`, `../../../../src/shared/project-runtime-layout.ts`, and
  `../../../../src/shared/runwield-owned-paths.ts` — move the legacy path constant and its imports so the layout does
  not depend on the secret-store implementation.
- `../../../../src/cmd/plans/share.ts` and `../../../../src/cmd/plans/pull.ts` — preserve the pre-write ignore call and
  existing store selection. Push and unshare also use the path helper; verify them without unnecessary command rewrites.
- `../../../../src/shared/collaboration/secrets.test.js` — replace old path/ignore assertions; add real file and
  permission checks.
- `../../../../src/cmd/plans/collaboration-commands.integration.test.ts` — prove project share, URL import, named pull,
  push, and unshare work across linked checkouts with one project store.
- `../../../../src/shared/project-runtime-layout.test.ts` and owned-path tests — retain legacy-secret migration and
  hazard checks after changing constant imports.
- `../../../domain-language.md` — clarify the existing Primary-Checkout Runtime State definition with the active project
  secret path and distinguish it from the unchanged home-directory store. Do not claim other children are complete.

## Reuse Opportunities

- `../../../../src/shared/collaboration/secrets.js` — reuse secret normalization, atomic writes, redaction, and
  mode-setting behavior.
- `../../../../src/shared/project-runtime-layout.ts` — reuse primary ownership and test sandbox routing; do not
  construct a new primary-path rule.
- `../../../../src/shared/runwield-owned-paths.ts` — reuse `ensureRunWieldOwnedGitignoreBlock()` for pre-write
  protection.
- `../../../../src/shared/git-test-fixture.ts`, the collaboration HTTP fixture, and `withRuntimeCommandFixture()` —
  exercise real Git, crypto, Plan, and secret operations without new injection seams.
- `../../../../src/shared/settings.js` — keep project settings primary-checkout behavior separate from project runtime
  secrets.

## Implementation Steps

- [ ] The legacy secret path constant is defined in `../../../../src/constants.js`; layout and owned-path modules no
      longer import secrets. Migration and legacy hazard classification still recognize
      `.wld/collaboration-secrets.json` and its temporary files.
- [ ] `getGlobalSecretStorePath()` is unchanged. `getProjectSecretStorePath()` uses the layout's primary secret path
      synchronously, including sandbox routing, without old-project-file fallback or duplicate writes.
- [ ] Project share and URL pull establish primary managed ignore protection before secret writes. The helper is
      idempotent, preserves unrelated content, and adds no standalone legacy secret rule. Ignore failure prevents the
      local secret write; existing share rollback remains intact.
- [ ] Real linked-worktree tests prove project share, URL import, named pull, push, and unshare use the same populated
      primary store. Project operations preserve unrelated global records and do not create selected or legacy stores.
- [ ] Schema version 1, atomic rename and temporary-file cleanup, best-effort `0600`, redaction, record-key preference,
      compatibility refusal, and other-space record preservation remain protected by tests.
- [ ] Tracked legacy project secrets remain a migration or Doctor concern and are not silently cleaned by this slice.
- [ ] `../../../domain-language.md` states the implemented project secret location under Primary-Checkout Runtime State,
      retains the existing avoided aliases and ownership relationships, and distinguishes unchanged global storage.

## Verification Plan

Run through the safe test runner, never `deno test` directly:

```sh
deno run -A scripts/run-tests.js src/shared/collaboration/secrets.test.js src/cmd/plans/collaboration-commands.integration.test.ts src/shared/project-runtime-layout.test.ts src/shared/runwield-owned-paths.test.ts src/shared/settings.test.js
deno task seams:check
deno task ci
```

Required evidence:

- **Physical ownership:** use a disposable real Git primary checkout and linked worktree. Call the public project helper
  from both, write/read a record, and inspect the independently constructed
  `<real primary>/.wld/internal/collaboration-secrets.json`. Assert its record content, not just helper equality.
  Neither checkout's legacy file nor the linked checkout's internal secret file exists. Also cover sandbox routing.
- **Command round trip:** with the real collaboration HTTP fixture, share from a linked checkout using
  `--project-secrets`. Inspect the primary file for the actual generated keys. Make the shared Plan metadata available
  in the other checkout, push changed content there, and named-pull it from the linked checkout. Assert the decrypted
  Plan content/revision. Unshare from the other checkout and assert remote deletion and removal of the matching primary
  record. Keep unrelated global records byte-identical and other-space project records intact.
- **URL import:** in a separate fresh linked project, pull a maintainer URL with project secrets enabled. Assert the
  imported Plan remains selected-checkout local and its capability record exists only in the primary internal store. Do
  not pre-seed that record or let a global copy make the test pass.
- **Git protection:** from a linked checkout, call the ignore helper twice with custom primary and selected
  `../../../../.gitignore` content. Primary output is byte-stable on the second call; unrelated content is retained and
  selected content is unchanged. `git check-ignore` at primary matches both the secret file and a representative atomic
  temp path, but not settings, Agents, Skills, or prompts. No standalone legacy secret rule is appended outside the
  shared block. Make primary `../../../../.gitignore` unwritable with a deterministic filesystem obstruction and prove a
  project share or URL pull fails without writing its local secret record.
- **Security and compatibility:** preserve missing-file, corrupt-schema, invalid-write, redaction, cross-store conflict,
  pair-key preference, legacy Plan-only key, other-space preservation, and default-global command coverage. Check final
  file mode `0600` on supported platforms after first write and replacement, and no leftover atomic temp files. Exercise
  a real rename failure to verify temporary-file cleanup without replacing filesystem functions.
- **Migration regression:** existing layout tests still adopt inactive legacy secrets with their bytes and permissions
  intact and refuse tracked/conflicting stores. This protects the relocated legacy constant; it does not substitute for
  child 06's command-entry tests.
- **Semantic review:** verify the call path uses the layout owner and has no old-project-store fallback. Confirm the
  glossary describes only implemented behavior. A path-only stub, selected-checkout writer, or global-only fallback
  fails the physical-file and command tests above.

Behavior expected to stop: writes to the old project path, separate project stores in linked worktrees, and the
secret-specific ignore-line appender. Do not delete security tests when replacing old path/ignore assertions. Full CI
must pass before the next child starts; no new skipped tests are planned.

## Edge Cases & Considerations

- Moving a tracked secret does not remove it from Git history; later diagnostics must warn about rotation and history
  cleanup.
- The path helper must not accidentally move user settings, local Agents, local Skills, or prompts.
- Permissions remain best-effort on some platforms. This child does not change the secret schema or directory-mode
  policy.
- Test fixtures must keep HOME sandboxed. For literal checkout paths and Git ignore checks, temporarily clear only
  `WLD_TEST_SANDBOX_HOME` inside `withProcessGlobalTestLock`, then restore it. Reuse the runtime fixture's existing lock
  rather than nesting a second acquisition. Build linked worktrees after fixture checkout.
- The move is one-way. No downgrade support or fallback to legacy project files is added. Entry refusal belongs to child
  06; shared ignore cleanup belongs to child 07. Do not duplicate migration inside this store.
