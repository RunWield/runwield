---
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "LOW"
affectedPaths:
    - "scripts/"
    - "package.json"
    - ".github/workflows/"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-11-02"
status: "draft"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
planId: "5eb6b66e-6879-465a-83db-2e56d4f78982"
---

# Scripts Usage Inventory and Cleanup Decisions

## Context

The owner wants a full usage inventory before choosing what to delete. The earlier nine-file deletion proposal is withdrawn. No file is approved for deletion.

This draft is a decision artifact, not an approved cleanup scope. A callsite proves a reference exists; it does not prove that the caller runs or that the owner no longer needs a manual tool.

**Start with the [group summary](#group-summary).** It links the decision to its effect. The [execution roots](#execution-roots-and-conditions) explain workflow guards; the per-file tables account for every file.

The deeper audit found more than benchmark scripts to consider: paused Windows packaging, manual Bun migration qualification, a second test runner/inventory, optional developer checks, Connect acceptance, memory diagnostics, and the setup wizard. These are categories for your decision, not a deletion recommendation.

The folder contains 169 tracked files, including 75 test files. A script without a package task is not necessarily unused: CI invokes some directly, scripts import helpers by relative path, and tests launch fixture executables.

### Evidence limits

The inventory below traces configured execution from entrypoints through task expansion, job conditions, function calls, imports, subprocesses, and tests. It separates those paths from documentation and historical mentions.

No hosted CI run history, shell history, or private usage logs were inspected. “Configured for CI” does not claim a recent successful run. “Manual only” does not mean unused. Test coverage does not establish use of a tool's standalone command.

A concrete correction to the first pass: Windows qualification workflows contain `if: ${{ false }}`. Their script references are dormant, not current automated execution.

### Related product capabilities

This inventory changes no product requirement or architectural decision. These owning capabilities explain the consequences of later choices; they do not preselect files to keep:

- [Core request routing](../prd/runwield-core-prd.md#request-routing): **Evaluate routing against fixed repository context**, including per-row commit pins and unchanged owner checkouts.
- [Core installation and updates](../prd/runwield-core-prd.md#installation-and-updates): **Qualify packages before publication and keep published bytes**. Release-tool choices affect this qualification and historical recovery coverage.
- [Connect Preview Acceptance](../prd/runwield-connect-prd.md#preview-acceptance) and [Codex acceptance](../prd/runwield-connect-prd.md#codex-acceptance): the manual tools collect host qualification evidence; their presence does not claim live acceptance.
- [Agent evaluation](../prd/agent-behavior-evaluation-prd.md#agent-scorecards-and-support-decisions): current Reviewer and Router runners support the benchmark capability. The proposed shared harness remains target scope.

## Objective

Give the owner a complete, evidence-based map of `scripts/`. Record keep, remove, or investigate decisions by group or file. Only then revise this draft into an executable cleanup Plan with the exact deletion set and its effects.

## Approach

Read the **group summary** first, then the per-file tables for any group you want to change. Group IDs are labels for this review, not proposed architecture.

The inventory distinguishes five kinds of evidence:

- **Configured execution:** an enabled workflow or ordinary local command reaches the work.
- **Conditional execution:** a release, platform, flag, or failure condition must first apply.
- **Dormant automation:** a workflow names the command, but its current guard prevents execution.
- **Manual entrypoint:** a package task or executable exists; no enabled automated caller was found.
- **Test or descriptive reference:** a test, type configuration, guide, or historical record mentions the file. This is not standalone usage.

```text
entrypoint + trigger + guard
  -> package task or CLI branch
     -> executed function / spawned command / loaded data

Separate evidence:
  test discovery -> tests -> exercised code
  guide or historical record -> description, not execution
```

No keep/delete recommendation follows automatically from a category. A useful benchmark can be manual; a migration tool can remain wired into a current release check. The owner decides whether that capability is still wanted.

```wld-question
{
  "id": "script-inventory-decisions",
  "type": "text",
  "prompt": "After reviewing the inventory below, which groups or files should we keep, remove, or investigate further? You can use group IDs such as G04 or name individual files. No deletions are preselected.",
  "placeholder": "Keep: …; Remove: …; Investigate: …",
  "allowEmpty": false
}
```

The next revision will turn these decisions into an exact deletion set. Do not execute cleanup from this inventory-only draft.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `scripts/` — the full audit surface, not a deletion list.
- `package.json`, `.github/workflows/`, `.githooks/`, and container definitions — evidence of command entrypoints, guards, and task expansion. Any changes depend on owner decisions.
- Current guides and test inventories — distinguish supported commands from old references; update only for approved removals.

This revision changes only this Plan. It does not remove scripts, tests, commands, or data. No glossary or PRD change is needed for the inventory. A later capability-removal decision must include its owning requirements and references in the cleanup scope.

## Reuse Opportunities

- `scripts/run-tests.js` — the existing isolated runner for later focused verification.
- `scripts/router-eval-utils.js` — shared behavior across several independent Router tools; not exclusive to one candidate.
- Existing CI, docs, and release policy tests — evidence of current contracts, including assertions about paused lanes. A deliberate retirement can require changing those contracts.
- Existing current guides — evidence of intended manual use, not proof of recent execution.

## Implementation Steps

**Cleanup is not yet specified.** The owner requested analysis before deletion decisions. These are the conditions for the next executable revision:

1. Every tracked file in `scripts/` appears in the inventory, with its purpose and execution or reference category. Direct callers are separated from test-only and descriptive references.
2. Owner decisions identify the exact removal set. No file is removed because a call count is low, because its name contains a legacy runtime, or because this inventory calls it manual or dormant.
3. The revised cleanup steps identify affected package tasks, workflow guards, imports, shared helpers, tests, and current documentation for each selected removal. Removing a useful capability is explicit, not disguised as dead-code cleanup.
4. The revised verification names the approved absences and the retained behaviors and tests. Shared fixtures and historical or user data remain outside deletion scope unless the owner selects them separately.

## Approval Confirmation

No Work Record supersession is proposed. No deletion is approved. The owner must choose the cleanup scope, and the resulting executable revision must be reviewed before implementation.

## Verification Plan

For this inventory:

- Compare all per-file entries with `git ls-files scripts`: 169 files, 94 non-test files and 75 tests. Every file must be accounted for; omitted files would invalidate a claim of complete coverage.
- Trace command paths from `package.json` through `scripts/run-ci.ts` and workflow job/step conditions. Inspect imports at their actual function calls. A path filter, type-check entry, or test assertion must not be labeled a command launch.
- Compare test discovery in `scripts/run-tests.js` with `scripts/bun-test-files.json`. Report inventory differences rather than assuming both runners select the same tests.
- Check the detailed evidence for manual, dormant, and legacy paths. Report the limits of static analysis; do not claim recent use or successful execution from source inspection.
- Do not run release, DNS, acceptance, benchmark, or diagnostic commands merely to classify them. This audit does not need credentials, publication, model calls, or live account changes.

For the later cleanup, preserve the project setup requirement (`bun run install:locked` with Bun 1.4.3) and isolated test runner (`bun scripts/run-tests.js <selected tests>`). Exact tests and expected retired behavior will follow the owner's deletion choices. The earlier nine-file verification scope is withdrawn.

## Edge Cases & Considerations

- **Manual usage is not visible in code.** The owner supplies that context. A documented tool can still be obsolete; an undocumented tool can still be useful.
- **Fixture executables can look disposable.** Their temporary environments are disposable; the test machinery may still protect wanted behavior.
- **Legacy does not mean unused.** Deno lock interoperability is still in an enabled Unix release path. Conversely, Windows workflow references sit behind false guards.
- **Imports can cross the folder boundary.** `build-metadata.ts` supplies production remote-runtime behavior. Deleting it is not a scripts-only cleanup.
- **No data cleanup.** The inventory does not authorize removal of local evaluation data, saved results, Session history, or benchmark corpus files.

## Scripts Inventory

Audit date: 2026-11-03. All file names in the inventory tables are relative to `scripts/`. Evidence paths elsewhere are relative to the repository root. Line numbers locate the inspected code; they are not permanent identifiers.

### Group summary

**All decisions are open.** Counts in G01–G12 cover the 94 non-test files exactly once. T covers the 75 test files separately. A group can contain executable commands, libraries, or data; its count is not a count of standalone commands.

| ID  | Group                                            | Files | Strongest execution evidence                                  | What a removal decision would affect                                           |
| --- | ------------------------------------------------ | ----: | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| G01 | Core checks and test infrastructure              |    28 | Ordinary PR/local CI paths                                    | Validation gates, isolated tests, test evidence, lint rules                    |
| G02 | Build, docs, release, and package infrastructure |    25 | Enabled build/release/docs paths; some also ordinary CI       | Binaries, remote bundles, docs deployment, Homebrew, release integrity         |
| G03 | Bun/Deno lock interoperability                   |     1 | Enabled Unix release package jobs                             | Cross-runtime lock qualification; not a dormant test                           |
| G04 | Windows and WinGet packaging                     |     3 | Disabled Windows diagnostic or manual task only               | Retained Windows packaging capability; source tests still run                  |
| G05 | Bun migration qualification tools                |     5 | Manual task, disabled Windows job, or tests                   | Parallel test runner/inventory and compiled package/provider checks            |
| G06 | Optional developer commands                      |     4 | Manual task; tests in some cases                              | Docs development, prototypes, remote submodule checks, portable storage runner |
| G07 | Router evaluation tools                          |     6 | Manual tools and direct tests                                 | Dataset preparation, offline scoring, live Router benchmark                    |
| G08 | Reviewer benchmark                               |    11 | Manual run/score entrypoint and direct tests                  | Fixture admission, live evaluation, saved-result scoring                       |
| G09 | Connect acceptance entrypoints                   |     3 | Manual qualification; parser tests for two                    | Repeatable real-host qualification, not production plugin execution            |
| G10 | Workspace memory diagnostics and fixtures        |     3 | One manual diagnostic plus independent lifecycle-test callers | Memory comparison and real renderer lifecycle tests                            |
| G11 | Docs Pages setup wizard                          |     1 | No caller or dedicated test found                             | Guided DNS/Pages cutover; deployment workflows are separate                    |
| G12 | Shared test fixtures                             |     4 | Test callers, not standalone commands                         | Installer, terminal, Bash, and docs-workflow test environments                 |
| T   | Automated test files                             |    75 | Ordinary source-test discovery, subject to case-level skips   | Coverage for all these families; not proof that each associated CLI is used    |

### Execution roots and conditions

This is the basis for the file classifications. Workflow names below are under `.github/workflows/`. A reference under a disabled job is not promoted to enabled automation.

| Root                             | When it can execute                                               | Actual route / limit                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr.yml`                         | Pull request or manual dispatch                                   | `:110` runs `ci --source-only`; `:215` runs Golden TUI. Four Ubuntu shards each. `run-ci.ts:9–23,81–90` runs its listed gates, then source tests only after gates pass.                       |
| `golden.yml`                     | Push to `main` or `release/**`; manual dispatch                   | Golden TUI only. It does not run the Router or Reviewer benchmarks.                                                                                                                           |
| `release.yml`                    | `v*` tag, manual recovery, or qualification-only dispatch         | Normal release runs source/Golden/binary/Unix/container checks. Qualification-only skips those gates and instead builds and qualifies candidate archives. `:136,251,365,390,400,411,627–692`. |
| `release-unix.yml`               | Normal release calls it; also manual dispatch                     | Enabled macOS source suite and Ubuntu/macOS package checks. Deno lock checks are at `:102–110`. Not called by ordinary PR CI.                                                                 |
| `release-containers.yml`         | Normal release calls it; also manual dispatch                     | Current jobs require `!inputs.legacy_recovery`. Legacy job requires recovery plus an exact two-commit allowlist (`:137–154`); the parent selects that path at `release.yml:105–115`.          |
| `release-windows.yml`            | Declares reusable/manual triggers, but no current caller          | Only job is hard-disabled at `:25`. Package/provider checks at `:230,234` are dormant.                                                                                                        |
| `windows-package-diagnostic.yml` | Manual trigger, but execution blocked                             | Build is hard-disabled at `:17`; check job depends on it at `:61`. Default branch is `fix/windows-package-check`; build/tag values are fixed to `v0.10.1-rc.9`.                               |
| `docs.yml`                       | Matching push to `docs/stable`, or manual dispatch on that branch | Branch guard at `:35`; verify source at `:93,156`; rebuild only when qualified bytes cannot be reused (`:105–135`). A script in its path filter is not necessarily executed.                  |
| `homebrew-prepare.yml`           | Manual dispatch                                                   | Generates a package artifact through `package:homebrew`; does not publish or run the package-check command.                                                                                   |
| `homebrew-tap-access.yml`        | Manual dispatch                                                   | Verifies remote push/delete permissions. No `scripts/` command.                                                                                                                               |
| Package task                     | Explicit local invocation, or a caller shown above                | A task definition alone does not establish routine execution. `docs/bun-task-compatibility.md:82–91` explicitly labels transitional/migration tasks.                                          |
| `.githooks/pre-commit:7`         | Commit with this optional hook installed                          | Executes the Bun version guard, then Prettier. Not evidence that every checkout has the hook enabled.                                                                                         |
| `Containerfile:13–14`            | Explicit image build, including container qualification           | Runtime guard then `workspace:remote:build`.                                                                                                                                                  |
| Test discovery                   | Source suite after its gates pass                                 | `run-tests.js:317–340,546` selects repository test files. Tests call helpers and sample CLIs; that is separate from operating those CLIs for real work.                                       |

### G01 — Core checks and test infrastructure

These have configured execution in ordinary PR/local CI. Removing a check is possible, but it is a decision to retire that check, not removal of an unreachable script.

| File                                          | Purpose                                                              | Executed caller or data consumer                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-bun-runtime.ts`                        | Enforce the pinned Bun version                                       | `install:locked`, `ci`, `workspace:build` in `package.json:12,27,40`; pre-commit hook; guard calls from compiler, type checker, and sandbox.      |
| `check-bun-types.ts`                          | Type-check configured and discovered first-party files               | `check` task; top-level `ts.createProgram` at `:15`. No emitted runtime output.                                                                   |
| `run-bun-lint.ts`                             | Run source lint and owned-runtime checks                             | `lint` task; calls `checkOwnedRuntime` and `lintSource` at `:15,20`.                                                                              |
| `bun-lint.ts`                                 | Configure and apply the ESLint-based rules                           | `run-bun-lint.ts:6,20`; library, not independently selected by CI.                                                                                |
| `bun-lint-rules.json`                         | Rule mapping consumed by the lint engine                             | Loaded by `bun-lint.ts:5`; configuration, not a command.                                                                                          |
| `lint-rules/bun-parity.ts`                    | Custom compatibility lint rules                                      | Registered by `bun-lint.ts:6`; evaluated through lint.                                                                                            |
| `lint-rules/no-module-scope-process-state.ts` | Reject cached home/cwd process state                                 | Registered by `bun-lint.ts:7`; evaluated through lint.                                                                                            |
| `lint-rules/window-worker-globals.json`       | Global-name data used by lint rules                                  | Loaded by `lint-rules/bun-parity.ts:2`; not a script.                                                                                             |
| `check-owned-runtime.ts`                      | Reject disallowed runtime ownership/dependency patterns              | Called by `run-bun-lint.ts:15`; its mention of the lock checker is an exception rule, not a launch.                                               |
| `check-submodules.ts`                         | Check local initialization, pinned commits, conflicts, and dirtiness | `submodules:check` in `run-ci.ts:10`; skips when no submodules exist; no network fetch.                                                           |
| `check-snip-filters.ts`                       | Run Snip verification of the five shipped generic Deno filters       | `snip:check` in CI; actual `snip verify` at `:43–45`. The filters' Deno names do not make this unreachable.                                       |
| `check-language-policy.ts`                    | Enforce the production language ratchet                              | `language-policy:check` in CI; reads its baseline.                                                                                                |
| `language-policy-baseline.json`               | Allowed existing production JS/JSX paths                             | Loaded by `check-language-policy.ts:9`; configuration.                                                                                            |
| `check-injection-seams.js`                    | Enforce injection-seam policy                                        | `seams:check` in CI; `seams:update` is a separate manual mutation mode.                                                                           |
| `injection-seam-baseline.json`                | Seam check data                                                      | Loaded by `check-injection-seams.js:78`; configuration.                                                                                           |
| `check-doc-links.ts`                          | Validate tracked Markdown targets and fragments                      | `doc-links:check` in CI; uses Git file discovery.                                                                                                 |
| `check-skill-sync.ts`                         | Validate repository and bundled skill synchronization                | `skills:sync:check` in CI; `skills:sync:update` is manual and not selected by CI.                                                                 |
| `skill-sync-baseline.json`                    | Skill synchronization records                                        | Loaded by `check-skill-sync.ts:29`; configuration.                                                                                                |
| `check-workspace.ts`                          | Run Astro checks and fail if checker dependencies cannot load        | `workspace:check` in CI; dependency preflight at `:33–37`, Astro child at `:38–52`.                                                               |
| `ci-files.ts`                                 | Enumerate first-party files owned by checks                          | Called by lint, types, language/seam checks, and `run-tests.js:317`; excludes runtime state and corpus implementation trees.                      |
| `source-files.ts`                             | Select type-check source files                                       | `check-bun-types.ts:6,13` calls `walkSourceFiles`; uses `ci-files.ts`.                                                                            |
| `run-ci.ts`                                   | Orchestrate checks and source/full tests                             | `ci` task. Ordinary PR uses `--source-only`; local default includes Golden.                                                                       |
| `run-tests.js`                                | Discover and run isolated test files                                 | `test:suite`, `test:all:suite`, Golden, Workspace, and direct focused commands. This is the normal runner, not `run-bun-tests.ts`.                |
| `bun-test-sandbox.ts`                         | Reject unisolated test execution and initialize the test process     | Preloaded by `bunfig.toml` and test execution (`run-tests.js:406`); shared by both runners.                                                       |
| `retain-test-evidence.ts`                     | Retain sanitized failure evidence before sandbox removal             | `run-tests.js:34` and failure branch in `main`; conditional on failure, not every passing run.                                                    |
| `run-with-snip.ts`                            | Bound test subprocesses and filter command diagnostics               | `run-ci.ts:5,executeRuntimeTask`; `run-tests.js:38` calls `runBoundedTest`. Snip availability affects filtering, not the existence of the caller. |
| `script-process.ts`                           | Shared subprocess capture and exit handling                          | Called by file discovery, checks, docs/build/release tools, and diagnostics; many independent roots.                                              |
| `test-timings.ts`                             | Read, merge, order, and save timing data                             | `run-tests.js:39` and suite scheduling/reporting; not standalone.                                                                                 |

### G02 — Build, docs, release, and package infrastructure

Some of these are only selected during release work. Others also run in ordinary CI or provide functions to production code. The row names the difference.

| File                                 | Purpose                                                                    | Executed caller and condition                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assert-plan-server-image.ts`        | Inspect image contents and enforce image-file constraints                  | Current `check-remote-container.ts:46–47` calls its functions. Direct workflow CLI is legacy recovery only (`release-containers.yml:175`). Manual `workspace:remote:image:check` also exists.                                                  |
| `assert-workspace-review-runtime.ts` | Smoke-check built Workspace review routes and assets                       | Spawned by `release-check.js:633–639`, including `--binary-only` mode. Not an ordinary PR qualification command.                                                                                                                               |
| `build-metadata.ts`                  | Build identity, hashes, artifact verification, protocol constants          | Compiler/release callers; `write-version.ts`; actual production consumers in `src/shared/remote/{runtime.js,helpers.ts,release-artifact.ts}`. Not merely release-script support.                                                               |
| `build-plan-server-runtime.ts`       | Bundle the Plan Server runtime and its assets                              | `workspace:remote:build`; current container check at `release-containers.yml:60–64`. Historical `.js` fallback is not this current file.                                                                                                       |
| `build-stable-docs.ts`               | Build selected Stable documentation with current tooling                   | Unpublished Stable release at `release.yml:536–548`; docs deployment rebuild at `docs.yml:121–135`.                                                                                                                                            |
| `build-workspace-runtime.ts`         | Bundle the Workspace server and passive browser assets                     | `workspace:remote:build`; current container check at `release-containers.yml:59`.                                                                                                                                                              |
| `check-public-docs.ts`               | Check built routes, links, fragments, sitemap, and excluded content        | Ordinary `docs:check`; also called by `build-stable-docs.ts:57`.                                                                                                                                                                               |
| `check-remote-container.ts`          | Qualify current remote-image startup, assets, persistence, and protections | Enabled nonlegacy image job, `release-containers.yml:115,133`.                                                                                                                                                                                 |
| `check-remote-ssh-package.ts`        | Qualify packaged remote SSH behavior                                       | Unpublished Linux archive checks at `release.yml:691–692`, including qualification-only. Skipped for published recovery; also documented as manual command.                                                                                    |
| `compile-bun.ts`                     | Implement native compilation and embedded resource packaging               | `compile-command.ts:58–64` calls `compileBun`. `compile:bun` is a compatibility CLI, but this implementation also serves current compilation and memory diagnostics.                                                                           |
| `compile-command.ts`                 | Parse normal compile options and verify output identity                    | `compile` task; normal release build and `release-check.js` child. Documented manual cross-builds.                                                                                                                                             |
| `docs-dependencies.ts`               | Prepare isolated docs dependencies for the selected source                 | `build-stable-docs.ts:40`; also used by docs dependency/public-docs tests. Not a CLI.                                                                                                                                                          |
| `install-ci-mnemoteca.sh`            | Install the Stable Mnemoteca needed by integration tests                   | Normal release Ubuntu source (`release.yml:207`) and Unix macOS source (`release-unix.yml:64`). PR has its own inline pinned installation instead.                                                                                             |
| `integrate-release-branch.sh`        | Integrate the completed release branch                                     | Successful Stable release only, `release.yml:974–986`.                                                                                                                                                                                         |
| `package-homebrew-check.ts`          | Qualify the generated tap/formula installation                             | Candidate/Stable validation and Stable tap publication at `release.yml:774,887`; also manual task.                                                                                                                                             |
| `package-homebrew.ts`                | Generate Homebrew package metadata and formula changes                     | Release validation/publication at `release.yml:772,868`; manual `homebrew-prepare.yml:63`; package task.                                                                                                                                       |
| `public-docs.ts`                     | Select and stage publishable documentation                                 | Ordinary `docs:check → docs:stage`; also `docs-dev.ts` and Stable builder function calls.                                                                                                                                                      |
| `publish-homebrew.ts`                | Publish the qualified tap change without overwriting concurrent changes    | Successful Stable publication at `release.yml:818,908`; not Candidate publication.                                                                                                                                                             |
| `reconcile-docs-branch.sh`           | Reconcile Stable docs source and recovery changes                          | Stable preparation at `release.yml:531`; copied then executed during publication recovery at `:939–947`. Manual recovery is documented in `docs/releasing.md:367`.                                                                             |
| `release-assets.ts`                  | Prepare/verify archive metadata and immutable published bytes              | `release.yml:608,618`; `docs.yml:96–98`; manual remote-development artifact preparation. Existing Windows assets can still be verified without generating new Windows packages.                                                                |
| `release-check.js`                   | Compile and smoke-test the standalone executable                           | Enabled release/Unix/container jobs call the file directly with `--binary-only`. Local `release:check` defaults to also running extensive Golden tests.                                                                                        |
| `release-license.ts`                 | Resolve release license metadata                                           | Called by Homebrew, WinGet, and archive generation; shared despite one dormant platform consumer.                                                                                                                                              |
| `release.js`                         | Release metadata and operator candidate/promote/stable actions             | `release:metadata` in all release workflow modes. Candidate/promote/stable branches are operator entrypoints. Package/license/archive modules also call exported tag parsing and asset-list functions; those imports do not publish a release. |
| `verify-docs-source.ts`              | Verify that deployment docs match the selected Stable source               | `docs.yml:93,156`; its list of supported files is reference data, not launches of those files.                                                                                                                                                 |
| `write-version.ts`                   | Generate source version and build-identity files                           | Ordinary `check`, Workspace build, Golden; compiler calls its exported functions; release direct call.                                                                                                                                         |

### G03 — Bun/Deno lock interoperability

| File                             | Purpose                                                                                         | Actual path / decision consequence                                                                                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-lock-interoperability.ts` | Assert two-way lock exclusion, close/crash release, and metadata I/O between Bun and Deno 2.9.7 | Enabled `release-unix.yml:102–110` installs Deno and runs it on Ubuntu/macOS. The Windows call is dormant. Removing this retires a currently configured release check; its historical purpose alone does not make it unreachable. |

### G04 — Windows and WinGet packaging

**Automation is paused, not absent from the repository.** `docs/releasing.md:264–271` describes the pause. Source tests for generators still belong to ordinary test discovery.

| File                       | Purpose                            | Calls and references, separated                                                                                                                                                                                     |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package-windows.ts`       | Generate Windows package artifacts | `package:windows` task. Only workflow launch found is the disabled historical diagnostic (`windows-package-diagnostic.yml:48`). Its `sha256` export is called by `package-winget.ts:20`; tests exercise generation. |
| `package-windows-check.ts` | Check a native Windows package     | `package:windows:check` task; diagnostic `:87` depends on a build disabled at `:17`. No enabled workflow launch found.                                                                                              |
| `package-winget.ts`        | Generate WinGet manifests          | `package:winget` task; no workflow launch found. Manifest preparation/submission is paused by policy; tests still exercise the generator.                                                                           |

Removing this group would require deciding whether to retire or retain the dormant task/workflow contracts and their tests. It does not automatically authorize removing verification of old published Windows assets from `release-assets.ts`.

### G05 — Bun migration qualification tools

`docs/bun-task-compatibility.md:82–91` calls these transitional/migration tools. This group is distinct from the current compiler and normal test runner.

| File                         | Purpose                                                                                            | Calls and references, separated                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-bun-tests.ts`           | Parallel isolated test runner with an explicit inventory                                           | `test:bun` task only; no enabled workflow invokes its full inventory. `run-bun-tests.test.ts` really launches it on synthetic test files, so its implementation is exercised in CI.                  |
| `bun-test-files.json`        | Explicit migration-runner selection                                                                | Read by `run-bun-tests.ts:122` only when no file arguments are given. The normal runner discovers files without it. Includes 74 of the 75 script tests.                                              |
| `check-bun-package.ts`       | Qualify a relocated compiled executable and packaged surfaces                                      | `check:package:bun` task; only workflow launch is the hard-disabled Windows job (`release-windows.yml:25,228–230`). `tsconfig.bun.json:79` is type-check inclusion only.                             |
| `check-bun-provider.ts`      | Exercise a compiled interactive turn against a local fake provider and verify terminal restoration | `check:provider:bun` task; only workflow launch is the same disabled job (`:232–234`). Uses a real subprocess/local HTTP server, not paid provider calls. Type config inclusion does not execute it. |
| `package-helper-fixtures.ts` | Create helper-binary fixtures for package/provider qualification                                   | Called at `check-bun-package.ts:94` and `check-bun-provider.ts:81`. Both workflow roots are dormant. No independent routine execution root was found; type checking alone is not execution.          |

The normal release smoke command is `release-check.js`, not either `check-bun-*` command. Their coverage is not identical; removing them removes optional qualification capabilities rather than the normal release entrypoint.

### G06 — Optional developer commands

| File                              | Purpose                                                                              | Calls and references, separated                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-portable-json.ts`          | Standalone runner for portable private-JSON and Session-storage contracts            | `check:portable-json` task; no enabled workflow caller found. `tsconfig.bun.json:48` type-checks it. The same case modules run in `src/shared/private-json-file.test.ts` and `src/shared/session/file-session-storage.test.ts`, independently of this CLI. |
| `check-submodule-fetchability.ts` | Fetch exact HEAD submodule pins into fresh bare repositories                         | `submodules:check:remote` task; no CI/release caller found. Compatibility tests assert task availability. Normal `check-submodules.ts` checks local state, not remote reachability. Requires network/auth; checks HEAD pins, not staged replacements.      |
| `docs-dev.ts`                     | Stage docs and run the docs development server                                       | `docs:dev` task. Appears in `docs.yml` path filters and source-verification lists, but those mentions do not launch the server.                                                                                                                            |
| `run-prototype.ts`                | Launch an ignored prototype's `dev` task; also export a tracked-artifact policy scan | `prototype` task and bundled prototype skill. `run-prototype.test.ts` invokes its policy scan against the repository, so deleting the whole test file would also remove policy coverage. No workflow launches a user prototype.                            |

### G07 — Router evaluation tools

**These are a toolchain, not automatically disposable files.** No enabled workflow or package task runs this toolchain. Tests exercise its functions and controlled runner paths. The owner has identified Router benchmarks as useful; which individual preparation commands remain useful is still an owner decision.

```text
Session JSONL -> extract -> write judgement CSV -> optional curate
                             |
                             +-> offline evaluate
                             +-> live golden-set run

Shared CSV/scoring: router-eval-utils.js
The live runner does not import the four preparation/scoring CLI files.
```

| File                             | Purpose                                                                                                               | Calls and references, separated                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extract-router-decisions.js`    | Pair Router requests with saved triage results and emit JSONL                                                         | Manual CLI; own tests only outside implementation. No current command guide found. Reads Session files without model calls.                                                                    |
| `write-router-judgement-csv.js`  | Convert extracted JSONL to CSV, preserving human labels/notes/context pins                                            | Manual CLI; curator imports its `JUDGEMENT_COLUMNS` export. Own tests exercise conversion/preservation. Default input is hard-coded `/private/tmp/runwield-router-decisions.jsonl`.            |
| `curate-router-judgement-csv.ts` | Collapse recognized greetings and seed selected blank labels                                                          | Manual CLI; own tests. Defaults to rewriting its input CSV. Can remove duplicate greeting rows, including their annotations.                                                                   |
| `evaluate-router-judgements.ts`  | Score a labelled CSV and optionally write/check a baseline                                                            | Manual CLI; own tests. No thresholds by default; exit success is not proof of complete evaluation.                                                                                             |
| `run-router-golden-set.js`       | Run the production Router against labelled rows, with model/settings overrides and optional pinned repository context | Manual CLI documented at `docs/router-model-selection.md:125–166`; three direct suites. Live runs can spend model tokens. Default resumes completed rows; `--rerun` requests fresh evaluation. |
| `router-eval-utils.js`           | CSV handling, legacy label normalization, scoring, result columns                                                     | Called by writer, curator, evaluator, and live runner. Its own tests are independent; deleting one CLI does not make this helper unused.                                                       |

Maintenance signals, not deletion recommendations:

- The extractor has its own old directory encoder (`:89–91`); production hashes long paths in `src/shared/session/session-directory-name.ts:4–10`. Its default can miss long-path Session directories; `--sessions-dir` provides an explicit input.
- Curator/evaluator help names `.js` files although the implementations are `.ts`. Evaluator help still names `FEATURE`; shared scoring handles that legacy label. The Router guide still shows `deno run`.
- The writer fills `routerDecision` from historical decisions. The golden runner's resume path can regard those rows as complete (`run-router-golden-set.js:219–236,366–374`). A fresh live comparison needs deliberate `--rerun`; a successful exit alone does not prove new model work.

### G08 — Reviewer benchmark

The top-level entrypoint is manual. Its CLI supports live `run` and offline `score`. Current instructions appear in `evals/reviewer/README.md:83–98` and `docs/evaluation/reviewer-benchmark-fixtures.md:9`. No scheduled live workflow caller was found. The production Reviewer does not depend on this benchmark directory.

| File                                  | Purpose                                                           | Actual caller / reference                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `run-reviewer-benchmark.ts`           | Parse run/score commands and report outcomes                      | Manual CLI; `reviewer-benchmark/cli.test.ts` exercises dispatch. Live runs need configured model/auth; scoring reads saved results. |
| `reviewer-benchmark/run.ts`           | Select cases, admit fixtures, execute and resume runs             | Called by the entrypoint; calls admission, configuration, materialization, Reviewer invocation, and record functions.               |
| `reviewer-benchmark/score.ts`         | Score saved records and human adjudications                       | Called by the entrypoint's `score` branch; reads records, no model call required.                                                   |
| `reviewer-benchmark/admission.ts`     | Prove fixture conditions before admitting a run                   | Called by `run.ts`; uses fixture/materialization functions and real verification subprocesses.                                      |
| `reviewer-benchmark/configuration.ts` | Capture effective Reviewer configuration and fixture identity     | Called by `run.ts`; binds resume to configuration and fixture hashes.                                                               |
| `reviewer-benchmark/fixtures.ts`      | Load and validate fixture definitions, source trees, and variants | Called by admission, materialization, run, and records. Some other references are type-only; those are not execution.               |
| `reviewer-benchmark/materialize.ts`   | Build disposable Git projects and apply fixture patches           | Called by admission and run; test support also uses it.                                                                             |
| `reviewer-benchmark/measurements.ts`  | Read production-review measurements                               | Called by `reviewer.ts`; not a separate command.                                                                                    |
| `reviewer-benchmark/records.ts`       | Persist and reload run manifests/results                          | Called by run and score. Type-only imports from other modules do not add execution roots.                                           |
| `reviewer-benchmark/reviewer.ts`      | Invoke the production Reviewer for a fixture and collect evidence | Called by `run.ts`. Tests exercise controlled paths; live model evaluation is a separate manual operation.                          |
| `reviewer-benchmark/test-fixtures.ts` | Generate controlled fixtures for this subsystem's tests           | Test callers only, not part of the manual benchmark execution chain.                                                                |

Saved October reports describe historical runs, not current run frequency or proof that all current fixture revisions were evaluated. Removing the runner would not by itself justify removing saved results or the `evals/reviewer/` corpus.

### G09 — Connect acceptance entrypoints

These are manual qualification programs, not production plugin entrypoints. Their supporting modules live under `src/attached/`; script deletion alone would leave those modules in place.

| File                                     | Purpose                                                                      | Calls and references, separated                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connect-claude-acceptance.ts`           | Run the live Claude FEATURE journey and save evidence                        | No workflow/package caller found. `src/attached/claude/acceptance/driver.test.ts:6` imports its parser; tests do not run the real host journey. Options include `--claude`, `--out`, `--keep`. Real run needs host/auth, Git, built Workspace, and Mnemoteca; fixture uses bypassed permissions and HTTP review actions. |
| `connect-codex-acceptance.ts`            | Default installed-plugin protocol checks; optional live source-skill journey | No workflow/package caller found. Parser import at `src/attached/codex/acceptance/driver.test.ts:7`. `--live` can spend model tokens; default does not. Neither establishes desktop UI acceptance.                                                                                                                       |
| `connect-codex-validation-acceptance.ts` | Exercise native validation failure, recovery, replacement CI, and replay     | Direct manual command at `docs/validation-authority.md:81–85`. No workflow/package caller or dedicated script test found. Optional `--core` selects a compiled executable; evidence is retained. Stops at Reviewer handoff, not a complete live model workflow.                                                          |

**A maintenance signal:** the default Codex acceptance driver compares an exact tool list at `src/attached/codex/acceptance/driver.ts:11–27,81–90`. That list omits `start_planning`, which current Core exports at `src/shared/attached/operations.ts:792–800` and `src/attached/mcp.ts:65–68`. Static inspection predicts a discovery mismatch. This was not executed and is not a reason to delete the tool without an owner decision.

Checked-in Claude/Codex summaries describe earlier source snapshots and separate acceptance scopes. They do not prove that these scripts currently pass.

### G10 — Workspace memory diagnostics and fixtures

| File                          | Purpose                                                                                   | Actual caller / reference                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-memory-check.ts`   | Compare source and compiled renderer/operation memory, with and without forced collection | Manual instructions at `docs/contributing.md:60–70`; no workflow/package launch found. Calls the production compiler and fixture. Requires built Workspace assets; compiles may update generated version/build/cache files. |
| `workspace-memory-fixture.ts` | Real Workspace renderer and operation workload; also an executable fixture                | Spawned/compiled by the memory check (`:32,94`). Independently imported by `src/ui/workspace/workspace-renderer-lifecycle.test.ts:10,36–151`. Removing only the parent diagnostic does not make this unused.                |
| `workspace-renderer-probe.ts` | Test renderer loading, fallback, initialization, and failure in a subprocess              | Spawned by lifecycle tests at `src/ui/workspace/workspace-renderer-lifecycle.test.ts:13–34`; no manual guide needed. Its disposable directories are test isolation, not evidence that the script is obsolete.               |

### G11 — Docs Pages setup wizard

| File                  | Purpose                                                  | Calls and references, separated                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup-docs-pages.sh` | Three-stage interactive deployment/DNS/TLS cutover guide | No external caller or dedicated test found. It can dispatch `docs.yml` at `:235`, then asks the operator to change Cloudflare DNS and verify Pages/TLS (`:238–254`). Hard-coded repository/domain; assumes the hostname currently uses another Cloudflare route. Present DNS was not inspected. |

The large generic wizard library contains environment/secret helpers that these three stages do not use. That is unused code inside this file, not proof that the owner no longer wants the wizard. Current deployment and recovery use separate workflow/scripts.

### G12 — Shared test fixtures

These files are not standalone user commands. They matter only through the tests or qualification checks that call them.

| File                       | Purpose                                                                     | Test consumers / dependency chain                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash-fixture.ts`          | Resolve Bash and quote paths across platforms                               | Called by docs/installer fixtures and shell tests. Also shared with `src/` Bash tool, Snip, load-plan, Session tools-policy, and remote bounded-model tests. Not exclusive to tests in this folder. |
| `docs-workflow-fixture.ts` | Construct Git/release/docs fixtures                                         | Docs workflow/build/branch integration tests. It writes intentionally unusable historical tooling into fixtures; those literal paths are not production launches.                                   |
| `install-test-helpers.ts`  | Construct installer environments and invoke installer fixtures              | Installer integrity, interaction, and platform tests; depends on Bash helpers and terminal types.                                                                                                   |
| `terminal-fixture.ts`      | Type declarations for Bun's native terminal boundary; no runtime statements | Type-only imports in `install-test-helpers.ts:1`, `src/cmd/update/terminal.test.ts:1`, and `src/shared/remote/entry-isolation.test.ts:1`. It is compile-time support, not an executable fixture.    |

### T — Test inventory and what it does not prove

All 75 files below match normal `run-tests.js` discovery through `listCiFiles`. Ordinary PR `test:suite` excludes the TUI scenario/harness directories, not these script test files. Sharding divides the discovered set; prior gate failures can prevent test execution.

The separate `test:bun` inventory contains **74** of these files. It omits `run-tests-golden-fixtures.test.ts`. That file is still discovered by the normal runner. No missing path was found in the current explicit inventory. This difference is evidence of two selection mechanisms, not an instruction to delete or repair either one.

A test can run while the associated operational workflow is disabled. For example, Windows generator and pause-policy tests run without publishing a Windows package. Benchmark tests do not establish that a paid benchmark ran.

| Test file                                    | Coverage family / special condition                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `assert-plan-server-image.test.ts`           | Image-content assertions; G02                                                              |
| `assert-workspace-review-runtime.test.ts`    | Review-runtime assertions; G02                                                             |
| `build-metadata.test.ts`                     | Build identity and artifact metadata; G02                                                  |
| `build-plan-server-runtime.test.ts`          | Plan Server bundle generation; G02                                                         |
| `build-stable-docs.test.ts`                  | Selected-source docs build; G02                                                            |
| `build-workspace-runtime.test.ts`            | Workspace bundle/assets; G02                                                               |
| `bun-lint.test.ts`                           | Lint implementation and rules; G01                                                         |
| `bun-remote-runtime.test.ts`                 | Bun remote bundle/runtime behavior; G02                                                    |
| `check-doc-links.test.ts`                    | Markdown link checking; G01                                                                |
| `check-injection-seams.test.ts`              | Seam policy checker; G01                                                                   |
| `check-owned-runtime.test.ts`                | Runtime ownership checker; G01                                                             |
| `check-remote-ssh-package-workspace.test.ts` | SSH package qualification workspace; G02                                                   |
| `check-remote-ssh-package.test.ts`           | SSH package gate contracts; G02                                                            |
| `check-skill-sync.test.ts`                   | Skill synchronization checker; G01                                                         |
| `check-workspace.test.ts`                    | Astro checker loading and invocation; G01                                                  |
| `ci-files.test.ts`                           | First-party file selection; G01                                                            |
| `ci-policy.test.ts`                          | CI dispatch/discovery and workflow policy, including disabled lanes; G01/G04               |
| `compile-bun.test.ts`                        | Compiler implementation; G02                                                               |
| `compile-command.test.ts`                    | Compile CLI contract and output identity; G02                                              |
| `compile-entrypoint.test.ts`                 | Real compiled diagnostic/standalone entrypoints; G02                                       |
| `curate-router-judgement-csv.test.ts`        | CSV curation rules; G07                                                                    |
| `docs-branch-integration.test.ts`            | Docs/release Git integration fixtures; G02                                                 |
| `docs-build-workflow.test.ts`                | Stable docs workflow fixtures; G02                                                         |
| `docs-dependencies.test.ts`                  | Selected-source docs dependency preparation; G02                                           |
| `docs-workflow.test.ts`                      | Docs workflow contracts; G02                                                               |
| `evaluate-router-judgements.test.ts`         | Offline scoring and threshold/baseline functions; G07                                      |
| `extract-router-decisions.test.ts`           | Router transcript extraction; G07                                                          |
| `homebrew-tap-access-policy.test.ts`         | Tap credential/access workflow policy; G02                                                 |
| `install-integrity.test.ts`                  | Installer integrity, not a matching `scripts/` CLI                                         |
| `install-interaction.test.ts`                | Installer terminal interaction; shared G12 fixtures                                        |
| `install-platforms.test.ts`                  | Installer platform behavior; shared G12 fixtures                                           |
| `integrate-release-branch.test.ts`           | Release branch integration; G02                                                            |
| `package-homebrew-check.test.ts`             | Homebrew qualification; all registered cases require macOS                                 |
| `package-homebrew.test.ts`                   | Homebrew generation and package selection; G02                                             |
| `package-windows.test.ts`                    | Windows package generator fixtures; production automation remains paused                   |
| `package-winget.test.ts`                     | WinGet manifest generator fixtures; no live submission                                     |
| `pre-commit-hook.test.ts`                    | Real hook behavior in fixtures, not proof hook is installed locally                        |
| `public-docs.test.ts`                        | Publishable docs staging and content; G02                                                  |
| `publish-homebrew.test.ts`                   | Safe tap publication using fixtures; G02                                                   |
| `release-assets.test.ts`                     | Archive and published-byte verification; G02                                               |
| `release-check.test.ts`                      | Release-check orchestration/assertions; G02                                                |
| `release-legacy-assets.test.ts`              | Immutable historical-asset compatibility; G02                                              |
| `release-policy.test.ts`                     | Release workflow policy, pause guards, and task behavior; G02/G04                          |
| `release.test.ts`                            | Release metadata and operator actions; G02                                                 |
| `remote-ssh-workflow.test.ts`                | Release SSH qualification workflow wiring; G02                                             |
| `retain-test-evidence.test.ts`               | Failure-evidence retention; G01                                                            |
| `reviewer-benchmark/admission.test.ts`       | Fixture admission; G08                                                                     |
| `reviewer-benchmark/cli.test.ts`             | Benchmark CLI dispatch; G08                                                                |
| `reviewer-benchmark/configuration.test.ts`   | Run configuration identity; G08                                                            |
| `reviewer-benchmark/fixture-repairs.test.ts` | Corpus repair assertions; G08                                                              |
| `reviewer-benchmark/fixtures.test.ts`        | Fixture loading/validation; G08                                                            |
| `reviewer-benchmark/materialize.test.ts`     | Disposable project creation; G08                                                           |
| `reviewer-benchmark/measurements.test.ts`    | Review measurements; G08                                                                   |
| `reviewer-benchmark/records.test.ts`         | Saved run records; G08                                                                     |
| `reviewer-benchmark/reviewer.test.ts`        | Controlled Reviewer invocation; G08                                                        |
| `reviewer-benchmark/run.test.ts`             | Run selection/resume behavior; G08                                                         |
| `reviewer-benchmark/score.test.ts`           | Offline scoring/adjudication; G08                                                          |
| `router-eval-utils.test.ts`                  | Shared CSV/scoring; G07                                                                    |
| `run-bun-tests.test.ts`                      | Launches migration runner on isolated fixture tests; does not run full migration inventory |
| `run-ci-power.test.ts`                       | macOS sleep inhibition; skipped on other platforms                                         |
| `run-ci.test.ts`                             | CI task orchestration; G01                                                                 |
| `run-prototype.test.ts`                      | Launcher plus repository prototype-policy enforcement; G06                                 |
| `run-router-golden-set-context.test.ts`      | Pinned repository context; G07                                                             |
| `run-router-golden-set-settings.test.ts`     | Run-local model/settings overrides; G07                                                    |
| `run-router-golden-set.test.ts`              | Controlled golden-set behavior; G07                                                        |
| `run-tests-golden-fixtures.test.ts`          | Test discovery vs nested Golden fixtures; absent only from migration inventory             |
| `run-tests-sandbox.test.ts`                  | Normal runner isolation; G01                                                               |
| `run-with-snip.test.ts`                      | Process bounds/filtering; G01                                                              |
| `script-process.test.ts`                     | Subprocess behavior; includes a non-Windows-only case                                      |
| `source-files.test.ts`                       | Type-check file discovery; G01                                                             |
| `task-compatibility.test.ts`                 | Task names and argument contracts; some fixture entrypoints replace real scripts           |
| `test-evidence.test.ts`                      | Runner/JUnit evidence, including deliberate skipped fixtures; G01                          |
| `test-timings.test.ts`                       | Timing merge/order/reporting; G01                                                          |
| `write-router-judgement-csv.test.ts`         | CSV creation and human-cell preservation; G07                                              |
| `write-version.test.ts`                      | Version/build metadata generation; G02                                                     |

Test discovery is not a claim that every case executes on every platform. The table calls out important platform conditions; full run results were not collected in this audit.

### Reference traps and smaller cleanup opportunities

These findings explain why a simple reference-count audit was insufficient.

| Evidence                                                                  | What it actually establishes                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-test scripts included in `build-metadata.ts:15–29,44–75` fingerprints | Their bytes affect build identity. This does not establish executable use. Deletion may legitimately change build identity.                                                                                                                                                                        |
| `tsconfig.bun.json` entries                                               | Type-check coverage, not command invocation.                                                                                                                                                                                                                                                       |
| `docs.yml` path filters; `verify-docs-source.ts` file lists               | Trigger/input validation, not execution of each named script.                                                                                                                                                                                                                                      |
| `run-bun-tests.test.ts` launches its runner on fixtures                   | Real execution of the runner's implementation, not use of its complete migration inventory. The normal runner uses JUnit evidence; the migration runner relies on exit status/logs and does not separately classify all-skipped files.                                                             |
| `package-windows.test.ts` and pause-policy tests run in ordinary CI       | Generator/configuration coverage while Windows jobs remain disabled.                                                                                                                                                                                                                               |
| Reviewer/Router tests use controlled inputs or model responses            | Coverage of benchmark machinery, not live evaluation evidence.                                                                                                                                                                                                                                     |
| `install-test-helpers.ts:75` exports `HELPER_NAMES`                       | No consumer found. This is a small unused export inside an otherwise called module, not an unused file.                                                                                                                                                                                            |
| `install-test-helpers.ts:381–389` has an external `script` fallback       | The supported Bun PTY branch returns first. This fallback is not reached under supported Bun execution; its surrounding fixture is used.                                                                                                                                                           |
| `run-with-snip.ts:42–53` handles Deno diagnostics                         | That branch can handle explicit Deno commands; routine CI runs Bun. Timeout/process/logging behavior in the same module is still called.                                                                                                                                                           |
| Prototype forwarding test uses a replacement entrypoint                   | `task-compatibility.test.ts` replaces the real entrypoint in that case. Real `run-prototype.ts:169–173` rejects trailing arguments, while `docs/bun-task-compatibility.md:59` describes forwarding. This is a contract mismatch to assess, not evidence of use or an automatic deletion candidate. |

These observations are inspection findings, not fixes included in this draft. You can choose whole groups, individual commands, or a smaller cleanup such as an unused export.
