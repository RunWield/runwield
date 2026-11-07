---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/desktop/"
    - "package.json"
    - "bun.lock"
    - "scripts/compile-command.ts"
    - "scripts/compile-bun.ts"
    - "scripts/"
    - "docs/releasing.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/adr/020-electron-workspace-acp-client.md"
executionAgent: "engineer"
createdAt: "2026-11-06T04:04:38.185Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 10
dependencies:
    - "keep-work-safe-across-window-and-process-changes"
    - "run-plans-through-integrated-code-review"
    - "find-and-act-on-work-that-needs-attention"
    - "read-and-search-project-knowledge"
    - "inspect-usage-and-control-recording-and-export"
targetBranch: "epic/local-workspace-desktop"
planId: "691eeb72-d286-4c8a-9be0-3df2a0b1397e"
---

# Install and Update the Bundled Application

## Context

The repository has compiled CLI and browser-asset builds but no Electron distribution boundary. Desktop must run without Bun, Node, a global `wld`, a development server, or a cloud website.

This child implements installation/update machinery under [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace) and [ADR-020](../../adr/020-electron-workspace-acp-client.md). Final installed-app qualification/publication evidence belongs to child 12.

## Objective

Reproducible desktop artifacts bundle the matching platform runtime, dependencies, and shared UI. Installation and compatible updates preserve canonical data, safe lifetime behavior, and an independently installed shell CLI.

## Approach

Select and pin supported Electron/packager versions after checking native assets, supported architectures, signing, and update behavior. Use independent Vite builds and Bun orchestration unless Planner finds a smaller compatible supported arrangement.

Package app and runtime as one compatible unit. Depending on a separately installed CLI would save bundle space but would break clean installation and compatibility guarantees.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/desktop/`, root package/lock, and new packaging configuration — local app origin, pinned tools, bundled executable resolution, and updates.
- `scripts/compile-command.ts`, `compile-bun.ts`, build/release scripts and CI — compatible platform assets and artifact checks.
- Existing Workspace/viewer asset build support — preserve compiled standalone viewers and Plan share server dependencies.
- `docs/releasing.md`, desktop documentation, Workspace PRD, and ADR-020 — support matrix, audited build steps, and honest release prerequisites.

## Reuse Opportunities

- Existing CLI compilation, compiled-runtime qualification, package identity, and release conventions.
- The supervisor cancellation/settlement boundary from child 4.
- Existing canonical settings/Session stores and on-disk migration rules; no data importer or second store.

## Implementation Steps

1. Supported Electron and packaging/update tooling is selected and pinned with a documented OS/architecture matrix, artifact formats, release channel, signing/notarization requirements, updater hosting, and Linux dependencies.
2. Frozen root/docs locks and disabled lifecycle scripts remain enforced. Any binary fetch or native build is an explicit audited step, not an implicit installation hook; no legacy Deno dependency graph is installed.
3. Each artifact contains a compatible `wld`, required runtime dependencies, and local UI assets. The packaged renderer loads a restricted local application origin without `wld workspace serve`, a dev server, or cloud UI.
4. Executable resolution works from installed/relocated paths, including platform resource layouts. Bundling does not overwrite shell-installed `wld`; negotiated capability mismatch prevents dependent actions before mutation.
5. Application updates replace app/runtime together only after owned work settles. Upgrade/rollback decisions respect Core on-disk migration compatibility and never imply that an older writer may safely open migrated state.
6. Build/install/update checks and release instructions distinguish development artifacts from signed/notarized/published artifacts. Missing external credentials or hosting are recorded as real prerequisites, not placeholder success.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun run compile`, `bun run check:package:bun`, and `bun run seams:check`; Planner defines exact new desktop build/package/update commands and test paths with the selected tools.
- Built-artifact checks must fail if the bundled executable/assets are missing, the app launches a global CLI, or the renderer needs a development/cloud server. Exercise paths with spaces and relocated installations.
- Prove an installed candidate launches/registers a disposable Project without a development toolchain and with Workspace cloud endpoints blocked. Collect platform-specific evidence available here without claiming the other platforms passed.
- Exercise an update while work is active, cancellation settlement, compatible data preservation, incompatible capability refusal, and migration-aware rollback refusal. Inspect process separation and canonical data, not only updater status.
- Recheck compiled standalone viewer assets and Plan share server build support. Existing CLI packaging remains independently usable; final three-platform acceptance and publication occur in child 12.

## Edge Cases & Considerations

- Exact architectures, signing credentials, updater hosting, and release channel are decisions for this child's Planner; do not invent availability.
- Platform signing/notarization can require external access. Record the blocker precisely and retain usable development artifacts.
- Updates must not kill active work or silently run incompatible older writers.
- This child supplies installable replacements before browser-workbench retirement.
