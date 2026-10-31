---
planId: "74dc2c57-4664-452b-b18a-2587fd2ca3a8"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "LOW"
affectedPaths:
    - "src/ui/workspace/integrations/bun-adapter.ts"
    - "src/ui/workspace/astro.config.mjs"
    - "scripts/bun-test-files.json"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-31"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
status: "implemented"
---

# Workspace Dynamic Import Warnings

## Context

`bun run workspace:build` succeeds but reports seven `INEFFECTIVE_DYNAMIC_IMPORT` warnings during the server build.
The warning means that a static import already includes the module in the bundle. It does not mean that the dynamic
import fails.

The affected modules are:

- `src/cmd/registry.js`
- `src/ui/workspace/server.js`
- `src/shared/settings.js`
- `src/shared/workflow/workflow-slicer.ts`
- `src/shared/workflow/validation.ts`
- `src/shared/work-records/published-source.ts`
- `src/shared/session/session-runtime.ts`

Some dynamic imports have a purpose outside chunk splitting:

- `metrics.js` delays loading settings so Git and Plan storage can load without loading the agent package.
- `validation-supervisor.ts` delays Core Session composition. `architecture-boundary.test.ts` protects this boundary.
- `src/cli.ts` delays the command registry until after early startup commands.
- `SessionRuntime` imports its workflow implementation, which calls back into the public runtime module.

Other dynamic imports, such as the one in `cmd/workspace/serve.ts`, already have an indirect static dependency on the
same module. Those can be simplified, but that alone does not resolve all seven warnings. A source-level solution also
needs changes to settings loading, validation composition, and the runtime callback owner.

Planning reproduced all seven warnings with Bun 1.4.3 after `bun run install:locked`. The same build also reports a
large-chunk warning and a third-party `COMMONJS_VARIABLE_IN_ESM` warning. Those are outside this request.

**Preserved product requirements:** [Core validation](../prd/runwield-core-prd.md#validation), including “Required checks
fail closed,” and [Core usage measurement](../prd/runwield-core-prd.md#usage-measurement-and-export). No product requirement,
acceptance scenario, domain term, or runtime architecture changes are proposed. Existing requirements and references
remain current; do not add a product promise about internal bundler output.

## Objective

Remove the reported server-build warning noise without changing runtime imports, source startup behavior, or other
build diagnostics. Keep the same warning enabled for browser builds, where code splitting can affect download size.

## Approach

**Owner decision: adjust the server build diagnostic, not the runtime graph.** The installed Rolldown version provides
`checks.ineffectiveDynamicImport`. Astro exposes `astro:build:setup` with separate `server` and `client` targets.

Extend the existing Bun adapter hook so only the server target receives
`build.rolldownOptions.checks.ineffectiveDynamicImport: false`. Merge that setting with the existing configuration;
do not replace other build options or install a general warning filter.

```text
Astro build setup
  server -> disable only the ineffective-dynamic-import diagnostic
  client -> keep diagnostics unchanged
```

> [!NOTE]
> **This removes a diagnostic, not the mixed imports**
>
> All runtime imports remain unchanged. The server will also omit this warning for future mixed imports. Other warning
> categories and all errors remain enabled. This is not a bundle-size optimization.

The alternative is to change module boundaries and import sites until mixed imports disappear. That is a larger change
and needs startup and cycle regression checks across commands, Sessions, validation, and metrics.

The owner selected the server-only diagnostic change during review. Preserve runtime imports; source cleanup is outside
this Plan.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/workspace/integrations/bun-adapter.ts` — scope the diagnostic setting to the server build in the existing adapter.
- `src/ui/workspace/integrations/bun-adapter.test.ts` — verify target selection and real bundler diagnostics.
- `src/ui/workspace/astro.config.mjs` — existing adapter registration; expect no change unless required for hook wiring.
- `scripts/bun-test-files.json` — include the new focused test in the explicit test inventory.

Runtime modules, the docs-site build, browser chunk settings, dependencies, PRDs, and ADRs do not need changes for the
selected scope.

## Reuse Opportunities

- `bunAdapter()` already owns Workspace server build configuration and manifest normalization.
- Astro's `astro:build:setup` hook supplies the build target and `updateConfig`; use it instead of a new plugin layer.
- Rolldown's typed diagnostic option avoids a brittle match on warning text or module paths.
- Existing `node:test`, temporary-directory fixtures, and the isolated test runner support the regression tests.

## Implementation Steps

1. The existing Bun adapter disables `ineffectiveDynamicImport` only for `target === "server"` through the supported
   Rolldown build option. The client target receives no such override. Existing adapter registration, manifest sorting,
   and unrelated build options retain their behavior.
2. Adapter tests prove the server/client distinction and option preservation. A temporary real Vite build fixture with
   one statically and dynamically imported module emits the warning with the client/default configuration but not with
   the server configuration from the actual adapter hook. Both builds still emit a separate test warning. A fixture
   with an invalid import still fails under the server configuration.
3. The tests execute the fixture output and confirm the static and dynamic consumers return the same expected value.
   Tests are registered in `scripts/bun-test-files.json`; they add no dependency injection seam to production code.
4. The real Workspace production build completes without the seven reported warnings. Source import declarations stay
   unchanged. Existing product requirements and architecture references remain accurate; no broader behavior or bundle
   size claim is added to documentation.

## Approval Confirmation

The owner confirmed the server-only diagnostic scope. No Work Records are proposed for replacement.

## Verification Plan

- Prerequisite: Bun 1.4.3 and `bun run install:locked`.
- Focused tests: `bun scripts/run-tests.js src/ui/workspace/integrations/bun-adapter.test.ts scripts/build-workspace-runtime.test.ts`.
- Production reproduction: `bash -o pipefail -c 'bun run workspace:build 2>&1 | tee /tmp/runwield-workspace-build.log'`.
  Require a successful build and no `INEFFECTIVE_DYNAMIC_IMPORT` in the captured output. Do not accept exit zero alone.
- The fixture's baseline must emit the exact warning before applying the adapter setting. A no-op hook fails the server
  case; a global suppression fails the client case; a general warning/error filter fails the unrelated-diagnostic cases.
- Confirm the real build still reports unrelated warnings when present. Do not change the chunk-size threshold, global
  log level, or third-party CommonJS handling to make the build output appear clean.
- Preserve existing bundle tests for asset stability, manifest completion, environment removal, and runtime output.
  No existing tested runtime behavior is expected to stop existing.
- Manual/code review: verify no runtime import changes and no alteration of user-visible validation or metrics behavior.
  Browser visual checks are not needed because this change does not alter browser UI.

## Edge Cases & Considerations

- Server-only configuration must use Astro's explicit target, not process arguments or a guessed build phase.
- Keep all existing options when applying the override. Do not turn off the whole `checks` collection.
- The browser warning remains useful; the client fixture prevents accidental suppression there.
- This scope intentionally accepts mixed server imports, including future occurrences. Source cleanup and bundle-size
  optimization remain outside this Plan.
