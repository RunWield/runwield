---
planId: "28ebe593-0f9f-4e34-b16c-51553fabfa38"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "packaging/windows/"
    - "scripts/"
    - ".github/workflows/release.yml"
    - "src/cli.ts"
    - "src/constants.js"
    - "src/shared/runtime-preflight.ts"
    - "src/shared/foreground-process.ts"
    - "src/cmd/update/"
    - "src/cmd/acp/index.js"
    - "src/cmd/workspace/serve.ts"
    - "docs/releasing.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-09-11"
status: "validated"
origin: "internal"
parentPlan: "package-manager-distribution"
order: 2
dependencies:
    - "01-homebrew-tap"
userVerifiedAt: null
targetBranch: "main"
---

# Prepare Native Windows and the WinGet Release Handoff

## Context

The owner wants a Windows package ready for WinGet and a disposable document for the first public submission. The owner
explicitly chose to bundle required helpers and to include native Windows runtime fixes and core workflow tests, not
only ZIP and manifest preparation.

Current CI cross-compiles `wld.exe` for Windows x64 on Ubuntu and publishes tar archives. Only Linux x64 receives a
native binary smoke test. `getHomeDir()` reads only `HOME`; ACP and Workspace register Unix signals without platform
handling; the update command invokes Bash. The process-tree cancellation tests currently skip Windows. The safe test
runner also has Unix path/home assumptions.

Current upstream documentation provides Windows builds for Mnemoteca, Cymbal, Ketch, and agent-browser. This supports
the bundle approach but does not prove the selected binaries work together. Verify fixed release assets and their
runtime requirements during implementation. Snip remains optional for users.

## Objective

Deliver a complete Windows x64 ZIP, native installation and runtime proof, validated WinGet manifest generation, and
`../../../winget-first-release.md`, a disposable owner checklist. The installed command must work from PowerShell and
cmd without WSL, user-installed Deno, Go, Rust, or a separate helper installation procedure. Git for Windows is a
declared dependency because project operations and the Agent's Bash tool need it.

No product release, WinGet PR, public repository, or account credential is created by executing this Plan. Readiness
means the prepared package passes native checks; public WinGet acceptance remains an external owner step.

## Approach

Reuse the first child's package metadata and release rules. Add a complete Windows package alongside existing tar
assets; do not replace Unix outputs or silently change existing archive contents.

```text
compiled wld.exe + verified pinned helper artifacts
  -> Windows package tree and license notices
  -> ZIP and SHA-256
  -> native Windows installation/core-flow checks
  -> release asset publication through existing release workflow
  -> generate and validate manifests from published Stable bytes
  -> owner submits WinGet PR
```

Proposed tree:

```text
wld.exe
runwield-install.json
runtime/helpers/     # Mnemoteca, Cymbal, Ketch, agent-browser and required runtime files
licenses/
```

The metadata identifies WinGet package ownership, using `Gandazgul.RunWield` as the proposed package identifier. Check
for catalog naming conflicts before finalizing generated metadata. This identifier is a reviewable assumption; do not
invent Microsoft approval.

Before startup helper checks and subprocess use, expose the package's verified sibling helper directory to this process
and its children. Do not edit global PATH for private helpers. Limit this behavior to a complete package layout; source
runs and existing Unix installations keep their current lookup behavior. Prefer the bundled helper versions inside this
package, without modifying separately installed helper binaries. Handle Windows PATH key casing and spaces correctly.

Use upstream standalone Windows agent-browser where it supports the required operations. Include all of its required
runtime files; an executable that still expects a missing npm installation is not a complete bundle. Inspect the chosen
version before defining the package inventory. If an extra runtime is required, package it with its notices or declare a
real WinGet dependency, and make the clean-host test prove there is no undeclared prerequisite. Do not run remote
PowerShell installers during package installation.

Memory models/ONNX Runtime and browser downloads keep their upstream first-use setup and per-user locations. Git is
supplied through `Git.Git` in the manifest. Snip is not required to start RunWield. Keep the existing optional-helper
behavior.

Native fixes stay focused on paths, user directories, subprocesses, shutdown, package helper lookup, and packaged
browser resources. Do not redesign Session storage, publication, or shell semantics. Pi's Git Bash behavior remains
distinct from RunWield's current Windows foreground-shell behavior, and both get tests.

`wld update` and `wld upgrade` on a WinGet package display `winget upgrade --id Gandazgul.RunWield --exact` and do not
run the shell installer. Missing-helper guidance directs users to package repair/reinstallation, not the Unix installer.
Explicit RC/version/downgrade flags cannot bypass package ownership. The Stable WinGet listing does not gain a new
prerelease channel.

A loose `wld.exe` without package metadata is not a WinGet installation. On native Windows it must not invoke the Unix
installer; give truthful installation guidance without silently changing installation methods. Unix standalone updates
remain unchanged.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `../../../../packaging/windows`, `../../../../scripts`, and `../../../../deno.json` — pinned helper inventory, license
  collection, ZIP creation, WinGet manifests, and native package verification.
- `../../../../.github/workflows/release.yml` and preparation-only CI — Windows-native checks before publication,
  ZIP/checksum assets, and downloadable submission output without automatic external PRs.
- `../../../../src/cli.ts`, the first child's package metadata reader, and `../../../../src/shared/runtime-preflight.ts`
  — early package helper lookup and accurate repair instructions.
- `../../../../src/constants.js` — Windows user directory fallback through the existing `getHomeDir()` owner.
- `../../../../src/shared/foreground-process.ts`, `../../../../src/cmd/acp/index.js`,
  `../../../../src/cmd/workspace/serve.ts`, and affected existing Windows process callers — portable termination and
  shutdown behavior proved with real processes.
- `../../../../scripts/run-tests.js`, `../../../../scripts/run-with-snip.ts`, and
  `../../../../src/testing/process-global-lock.ts` as needed — portable isolated test homes, filesystem paths and
  temporary locks; do not weaken isolation or make Snip a new product requirement.
- `../../../../src/cmd/update`, `../../../../src/shared/update-check.js`, update/help messages — Windows package-owned
  update handling, while retaining Homebrew protection.
- Existing Session, ACP, Workspace and Git test boundaries — retain behavior coverage on Windows, not only Unix.
- `../../../winget-first-release.md` — disposable first-submission checklist, with deletion criteria.
- `../../../releasing.md`, `../../../quickstart.md`, `../../../troubleshooting.md`, and
  `../../../prd/runwield-core-prd.md` — lasting Windows installation, setup, updates and acceptance requirements. Link
  the Core requirement from ACP/Workspace docs only where needed; do not duplicate product ownership.

No new product domain vocabulary or broad UI redesign is in scope. Image clipboard parity and Windows arm64 are not
required by this packaging Plan; document existing limitations rather than claiming full platform parity.

## Reuse Opportunities

- Child 1's package metadata reader, Stable classifier, checksum checks and preparation conventions.
- `../../../../scripts/compile.js` and the existing Windows Deno target — retain all embedded Agents, Skills and browser
  resources.
- `../../../../src/cmd/testing/runtime-command-fixture.ts`, `../../../../src/shared/git-test-fixture.ts`, and
  `makeValidationProjectRoot()` — real runtime and Git fixtures with scripted model/network boundaries where needed.
- `../../../../src/cmd/resume/index.test.ts`, `../../../../src/shared/session/session-runtime.test.js`, and
  `../../../../src/acp/server.test.js` — persisted Session resume, cancellation and ACP protocol tests.
- `../../../../src/cmd/workspace/workspace.test.ts` and
  `../../../../src/ui/workspace/session-artifact-route.integration.test.ts` — actual Workspace startup, pairing and
  authorized artifact retrieval.
- `../../../../src/shared/worktree-creation.test.js` and `../../../../src/shared/isolated-publication.test.ts` — local
  publication, bare-remote publication, commit ancestry and dirty-primary preservation.
- Microsoft manifest guidance: https://learn.microsoft.com/en-us/windows/package-manager/package/manifest and
  repository: https://github.com/microsoft/winget-pkgs . These are references, not Tickets.

## Implementation Steps

1. A Windows-safe test runner gives every test file separate HOME, USERPROFILE, application-data paths where used,
   memory database and temporary state. File URLs become native paths correctly, and process-global locking uses a valid
   shared temporary location. The suite can run on Windows without touching the developer's real data. Tests that change
   home/cwd retain `withProcessGlobalTestLock`. Existing Unix isolation remains protected.
2. A checked-in Windows package inventory records exact helper versions, upstream asset URLs, SHA-256 values and license
   inputs. Package construction verifies bytes before extraction, includes required executable/runtime files and
   notices, and fails on a missing or mismatched dependency. No install-time `latest`, global npm install, or silent
   omitted helper is allowed. A complete ZIP is produced by
   `deno task package:windows --tag <tag> --binary <path> --output <dir>`. It contains the matching RunWield identity
   and package metadata. Local test builds need not have a public release; submission output does.
3. Installed RunWield resolves bundled helpers reliably from paths with spaces and from WinGet's command link.
   `getHomeDir()` supports native Windows without HOME, using USERPROFILE and a valid Windows fallback where needed,
   while preserving explicit HOME use and Unix behavior. Signal handling and child-process cancellation work on Windows.
   Version, help, provider setup, Session use, ACP and Workspace do not crash because of Unix-only assumptions. Fix
   issues uncovered by the named core-flow tests within this approved native-readiness scope.
4. Both update aliases, flags, notifications and helper-repair instructions obey WinGet ownership. The package cannot
   run `../../../../install.sh` or overwrite its own managed files through `WLD_INSTALL_DIR`. Missing metadata on a
   loose Windows executable yields accurate guidance rather than a Bash installer attempt. Source and Unix standalone
   paths, and the Homebrew behavior from child 1, remain correct.
5. A real Windows CI job installs/extracts the built package and exercises the named core flows with real helper
   binaries. Scripted external model responses are allowed for repeatable tests, but Session storage, subprocesses,
   package lookup, Git operations and helper executables are real. Native checks are required before the release
   workflow publishes this ZIP. Candidate ZIPs may be built and tested, but only confirmed Stable published bytes can
   produce Stable WinGet submission manifests.
6. `deno task package:winget --tag <stable-tag> --output <dir>` generates the standard version, default-locale and
   installer manifests using the actual published ZIP URL and checksum. Use ZIP with nested portable `wld.exe`, command
   alias `wld`, x64 architecture, `Git.Git` dependency, accurate publisher/package/license URLs and complete version
   fields. Verify the current supported schema and multi-file portable behavior rather than copying the earlier
   illustrative manifest verbatim. Reject RC, absent ZIP, mismatched checksum or version, and invalid metadata. Windows
   validation and local install accept manifests produced by this generator. Before first publication, exercise the same
   generation logic with a test-only release server serving the exact new package; final output uses the matching
   published Stable bytes and is rechecked by the owner before submission. Generation never submits a PR.
7. `../../../winget-first-release.md` contains an exact first-publication procedure with prerequisites, expected
   results, failure/retry steps and checkboxes. It separates completed preparation from owner actions: choose a Stable
   release containing these changes; use existing release commands; confirm workflow/asset checks; generate manifests
   from published bytes; validate and test locally on a disposable Windows machine; submit to `microsoft/winget-pkgs`;
   respond to review; confirm catalog installation; then delete this disposable guide after lasting instructions are
   retained. It includes the tested commands and output paths, not unresolved research tasks or fake hashes.
   Candidate-to-Stable promotion follows `../../../releasing.md`; do not hand-write a competing tagging procedure.
8. Lasting release docs describe new-version manifest preparation, package repair, required Git, first-use downloads,
   supported Windows x64 scope, package-owned upgrades and limitations. The Core installation capability records named
   acceptance scenarios. Public availability stays pending until the owner confirms the WinGet listing. Any failed
   required native flow remains a release blocker and prevents an unqualified readiness claim.

## Approval Confirmation

No Work Record supersession is proposed. Approval covers native runtime fixes, package preparation and validation. It
does not authorize a public release, WinGet PR, new account, paid service, code-signing purchase or license change.

## Verification Plan

### Automated repository checks

- Use
  `deno run -A scripts/run-tests.js --isolated scripts/package-windows.test.ts scripts/package-winget.test.ts src/cmd/update/index.test.ts src/shared/foreground-process.test.ts src/cmd/resume/index.test.ts src/shared/session/session-runtime.test.js src/acp/server.test.js src/cmd/workspace/workspace.test.ts src/shared/worktree-creation.test.js src/shared/isolated-publication.test.ts`,
  plus new focused package/path/runner tests and the artifact-route integration test. Run on Windows as well as
  supported Unix CI. Run `deno task ci`; never `deno test` directly.
- Safe-runner regression: use a disposable parent-process home and memory location as the host fixture. Sentinels there
  remain unchanged after a child test writes into its separate sandbox home/profile/app-data/database. Never place test
  sentinels in the developer's actual home or database. Test sandbox resolution without relying only on source greps.
- Archive/manifest tests inspect real ZIP entries and parse generated YAML against the current schema. Require all
  helper executables/runtime dependencies, matching version, notices and package metadata. Corrupt an asset, remove a
  helper, substitute an RC, or supply a release without a ZIP: preparation must fail. A ZIP containing only `wld.exe`
  must not pass.
- Real package startup with no helpers on global PATH must perform a memory add/search, code index/query, local-page
  fetch, and browser open/snapshot through the bundled programs. Verify distinctive returned content. A fake `--help`
  executable or lookup through a developer's existing tools must fail this test.

### Native Windows package checks

Implement `deno task package:windows:check --package <zip>` as the reproducible entry to package checks, with logs
suitable for CI artifacts. Use a clean Windows x64 VM or runner, install only declared user prerequisites, keep build
tools out of the child runtime PATH, and test with HOME absent, USERPROFILE set, a package directory with spaces, and
both PowerShell and cmd launch.

1. `wld version` matches the package tag; help works. Provider setup reaches its prompt without missing-helper errors.
   Complete one live authenticated Agent turn and resume the saved Session on a disposable Windows user profile. Keep
   credentials out of outputs. If interactive testing requires owner help, report that check pending rather than
   treating scripted traffic as live proof.
2. With deterministic model responses, save/resume preserves Session identity, Agent and transcript. Cancellation
   returns control, terminates a real child/grandchild process tree, and allows a later prompt. Do not leave the current
   Windows skips in the cancellation proof.
3. Launch installed `wld.exe --mode acp`; send initialize and a Session request through real stdio; require valid
   protocol responses and no diagnostic text on stdout. Close stdin and confirm clean exit without a SIGTERM error.
4. Launch packaged Workspace with `--no-open`, perform CLI/browser pairing, and load an authorized Session artifact.
   Require HTTP 200 and actual content, not the existing test's possible 503 fallback. Verify packaged assets load and
   shutdown releases the port. An unrelated Session must receive 404.
5. Create a real Git project and execution worktree, make a small change, and exercise local and local-bare-remote
   publication. Assert delivered file contents and commit ancestry; dirty unrelated primary files survive. These checks
   must use RunWield's existing publication path, not a test that manually runs a merge instead.
6. Both update aliases print the WinGet command and leave every package executable unchanged. Explicit
   RC/version/downgrade flags and `WLD_INSTALL_DIR` cannot invoke Bash or mutate the package. Test Homebrew and Unix
   standalone regressions too.
7. Test WinGet itself on a disposable Windows machine. The guide includes `winget validate --manifest <directory>`, the
   administrator step `winget settings --enable LocalManifestFiles` when required, and
   `winget install --manifest <directory>`. Before public release, a test-only manifest may use a locally served
   archive; final submission manifests must use the real immutable GitHub asset. Verify the `wld` alias resolves and
   bundled helpers work through it.
8. Exercise a two-version package upgrade through WinGet using a controlled local source or equivalent documented WinGet
   test setup, then uninstall. New bytes and version must run; settings, Sessions and memory data survive; private
   helper files are removed with the package; separately installed tools remain untouched. Manual ZIP replacement alone
   is not upgrade proof. Record the exact supported test procedure in the guide.

### Publication handoff checks

- Run the checklist in dry-run mode as far as external publication. Every command must exist, output paths must agree,
  and source/package/manifest versions must match. Clearly distinguish local test output from submission-ready output.
- Final owner steps use `wingetcreate submit <manifest-directory>` or the current supported equivalent, with explicit
  authentication and PR confirmation. After acceptance: `winget source update`,
  `winget show --id Gandazgul.RunWield --exact`, and `winget install --id Gandazgul.RunWield --exact` on a clean
  machine. These are owner release checks, not claims that preparation execution performed them.
- Semantic review confirms Windows tests use the packaged executable and actual bundled helpers, no runtime requirement
  is silently omitted, no required test is skipped while claiming readiness, and Stable submission automation cannot run
  for an RC or incomplete release.

## Edge Cases & Considerations

- Build success on Ubuntu is not Windows readiness. If the required Windows environment or a usable upstream helper
  build is unavailable, report the exact blocker and retain the prepared work. Do not silently downgrade this Plan to
  packaging-only.
- Windows paths, environment-variable casing, locked executables, PATHEXT, command links and process-tree shutdown can
  differ from Unix. Check actual WinGet installations, not just copied fixtures.
- Downloaded model/browser/runtime files belong to per-user storage. Package uninstall must not delete credentials,
  Session history, Mnemoteca collections, or user-installed helpers.
- Bundle licensing must be checked per selected dependency and include required notices. RunWield retains its custom
  Free Use License. A licensing or signing requirement that changes scope returns to the owner; do not fabricate
  compliance.
- Public catalog identifier `Gandazgul.RunWield` is proposed, not reserved. If a conflict requires a different public
  identity, confirm it before generating a submission-ready package.
- Avoid a circular first-release requirement: native package checks can run on local build artifacts before publication;
  submission manifests are generated only after the matching immutable Stable ZIP exists. The disposable guide explains
  this order.
- Preserve existing shell install checksums, Stable/RC identity rules, immutable released tags, standalone update
  confirmations, Session persistence, dirty-primary protection and publication ancestry checks. The behavior that
  intentionally stops is self-installation over package-managed files and Unix installer execution on native Windows,
  not those safety guarantees.
