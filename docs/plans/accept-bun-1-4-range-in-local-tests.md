---
planId: "170e8ab9-2e69-4558-989a-a8a5ed498194"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "scripts/reviewer-benchmark/run.ts"
    - "scripts/reviewer-benchmark/configuration.test.ts"
    - "scripts/release-check.test.ts"
    - "src/shared/runtime-supervisor.test.ts"
    - "docs-site/package.json"
    - "docs/contributing.md"
    - ".bun-version"
    - "package.json"
    - ".github/workflows/release-containers.yml"
    - ".github/workflows/release-windows.yml"
    - "scripts/check-remote-container.ts"
    - "src/shared/remote/verify-remote-workflows.ts"
    - "docs/adr/001-initial-tech-stack.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/agent-behavior-evaluation-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-12"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "1db6a54e38af5afe70acff57a0e0880d570ac58c"
workRecord:
    status: "generated"
    recordId: "90b5fbc5-2c27-4d77-887d-2c13ccce30da"
    path: "docs/work-records/2026-11-19-bun-range-compatibility-and-reproducible-release-pins.md"
    lastAttemptAt: "2026-11-19T15:27:44.426Z"
status: "verified"
---

# Accept the Bun 1.4 range in local tests and pin CI to Bun 1.4.4

## Context

`bun run ci` fails on Bun 1.4.4 on `main`. The suite only passes on the exact Bun 1.4.3 pin. The owner wants local work
to accept any Bun in the `^1.4.0` range and does not want the fix to be "pin local Bun to 1.4.3".

The owning requirement already states the behavior.
[Core PRD › Installation and updates](../prd/runwield-core-prd.md#installation-and-updates), **Requirement: Supported
development runtime**: local commands accept the supported Bun range, and CI and release artifacts use one exact pin for
repeatable builds. The test suite does not satisfy that requirement today.

The PRD text itself names exact versions (`^1.4.0`, "Bun 1.4.4", "Bun 1.4.3"). **Decision (owner, Plan review):** PRDs
describe product behavior, not technical details, so they must not name specific versions. This change removes those
version numbers from the PRDs it touches.

A full `bun run ci` run on Bun 1.4.4 (this planning session, `main` at `d00ee1246`) gave 910 passed, 7 failed, 1 skipped.
Six failures are Bun-version problems:

| Test file                                                                  | Cause                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/reviewer-benchmark/run.test.ts`, `cli.test.ts`, `records.test.ts` | `run.ts:109` throws unless `Bun.version === "1.4.3"`                                                                           |
| `scripts/reviewer-benchmark/configuration.test.ts`                         | asserts `configuration.bunVersion === "1.4.3"`                                                                                 |
| `scripts/release-check.test.ts` (4 tests)                                  | fixture writes `.bun-version` = `1.4.3`, but the test "binary" runs on the local Bun, so `assertBunRuntimeIdentity` rejects it |
| `src/shared/runtime-supervisor.test.ts` (2 tests)                          | Bun 1.4.4 changed how it fails at the open-file limit (see below)                                                              |

The seventh failure, `src/ui/review/plan-review.test.ts` › "accepts approval after Markdown body formatting", comes from
uncommitted in-progress work in this checkout (the `marked` → `quikdown` change in
`src/shared/workflow/plan-review-actions.ts`). It is not a Bun problem and is out of scope for this Plan.

## Objective

Two outcomes:

1. The full suite passes on any Bun in `^1.4.0` with no exact-version checks in local test or benchmark paths.
2. The CI and release pin moves from Bun 1.4.3 to Bun 1.4.4 everywhere it is written, so CI also proves 1.4.4.

Release qualification keeps its exact `.bun-version` check, as the PRD requires.

**Decision (owner, Plan review):** bump `.bun-version` and the release container and Windows Bun pins to 1.4.4. The
exact CI/release pin stays; only its value changes.

## Approach

Each failure gets the smallest fix that keeps what the test protects.

**Reviewer benchmark gate.** Remove the exact-version throw in `run.ts`. The run already records the real Bun version in
its configuration (`configuration.ts:58`, `bunVersion: Bun.version`), and resume refuses a changed configuration
(`run.ts:122-126`). So one run cannot mix Bun versions, and results stay comparable through the recorded version.

> [!WARNING]
> **Do not import `scripts/check-bun-runtime.ts` from `run.ts`**
>
> `run.test.ts` copies only `scripts/reviewer-benchmark/` into a fixture repository. An import of
> `../check-bun-runtime.ts` fails there with "Cannot find module". An earlier 1.4.4 attempt hit this exact error. The
> `bun run ci` entry point already runs `check-bun-runtime.ts`.

Fixture manifests keep `runtime.version: 1.4.3` and `fixtures.ts:203` keeps its admission check. That field is fixture
identity, covered by fixture hashes; changing it would change saved fixture truth. It does not block running on 1.4.4.

**Configuration test.** Assert `configuration.bunVersion === Bun.version`. This still proves the real runtime version is
captured, which is what the test is for.

**Release-check tests.** `withTemporaryVersionProject` writes the running Bun version (`versions.bun`) into the fixture
`.bun-version`. The production rule in `release-check.ts` — the release binary must run the exact `.bun-version` — does
not change. The existing "rejects unproven Bun identity" tests keep proving the mismatch is refused.

**Runtime supervisor tests.** Bun 1.4.4 reports open-file exhaustion as
`error: bun ran out of file descriptors (ProcessFdQuotaExceeded)` and exits with status 1. Bun 1.4.3 aborted with
`failed to create the event loop` and status 134 (SIGABRT). RunWield guidance already appears in both cases. The tests
change to accept either Bun diagnostic and either failing exit status, and keep every RunWield assertion.

```diff
-assert.match(result.stderr, /failed to create the event loop/);
+assert.match(result.stderr, /failed to create the event loop|ran out of file descriptors/);
 assert.match(result.stderr, /RunWield reached the open-file limit/);
```

**Docs and docs-site manifest.** `docs/contributing.md` says "Contributors use Bun 1.4.3". `docs-site/package.json` has
`engines.bun: "1.4.3"`. Both change to the `^1.4.0` range so the written rule matches the PRD and root `package.json`.

**CI and release pin to 1.4.4.** `.bun-version` is the source for every `setup-bun` step (`bun-version-file`), and the
docs workflow reads `tooling/.bun-version` from a `main` checkout, so it follows automatically. These places spell the
version out and must move with it:

```text
.bun-version                                  1.4.3 -> 1.4.4
package.json, docs-site/package.json          packageManager bun@1.4.3 -> bun@1.4.4
.github/workflows/release-containers.yml      container oven/bun:1.4.3
.github/workflows/release-windows.yml         bun-v1.4.3 download URL and the process.versions.bun check
scripts/check-remote-container.ts             test "$(bun --version)" = 1.4.3
src/shared/remote/verify-remote-workflows.ts  owned remote Bun download and evidence text
src/shared/remote/verify-remote-reviews.ts    equal(process.versions.bun, "1.4.3")
src/shared/remote/verify-remote-cli-workflows.ts  same check
README.md, docs/adr/001-initial-tech-stack.md
```

**PRDs without versions.** The PRDs keep the behavior and drop the numbers. The exact range lives in `package.json`
`engines.bun`, and the exact pin lives in `.bun-version`; contributor docs, README, and the ADR may name them.

```diff
-**Requirement: Supported development runtime.** Local source, test, build, and release commands accept the Bun
-range in `package.json` (`^1.4.0`: at least 1.4.0 and below 2.0.0). CI and release artifacts use the exact
-`.bun-version` pin for repeatable builds. ...
-- Given Bun 1.4.4 or another stable version in the supported range, the runtime check permits local commands.
-- Given Bun below 1.4.0, Bun 2.x, or another runtime, the check stops with the required range and detected runtime.
+**Requirement: Supported development runtime.** Local source, test, build, and release commands accept any stable
+Bun in the supported range. CI and release artifacts use one exact Bun version for repeatable builds. ...
+- Given a stable Bun in the supported range other than the CI version, local commands and the full test suite pass.
+- Given a Bun outside the supported range or another runtime, the check stops with the required range and detected runtime.
```

The remote bundle paragraph says "the same compiler" without a version. The evaluation PRD describes the fixtures as
"synthetic Bun TypeScript projects" without a version.

The remote verifiers are live qualification tools for release artifacts, so they follow the release pin.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent —
the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or
the Verification Plan no longer proves the objective.

- `scripts/reviewer-benchmark/run.ts` — remove the exact `Bun.version` gate.
- `scripts/reviewer-benchmark/configuration.test.ts` — assert the captured version equals the running Bun.
- `scripts/release-check.test.ts` — fixture `.bun-version` follows the running Bun.
- `src/shared/runtime-supervisor.test.ts` — accept both Bun 1.4.3 and 1.4.4 failure forms at the open-file limit.
- `src/shared/runtime-supervisor.ts` — change only if its resource-error detection does not already recognize the 1.4.4
  message (the observed output shows that it does).
- `docs-site/package.json` — `engines.bun` becomes `^1.4.0`. `packageManager` stays as is.
- `docs/contributing.md` — state the `^1.4.0` range and that CI/release use `.bun-version`.

- `.bun-version` — `1.4.4`.
- `package.json`, `docs-site/package.json` — `packageManager` becomes `bun@1.4.4`.
- `.github/workflows/release-containers.yml`, `.github/workflows/release-windows.yml` — literal Bun pins become 1.4.4.
- `scripts/check-remote-container.ts`, `src/shared/remote/verify-remote-workflows.ts`,
  `src/shared/remote/verify-remote-reviews.ts`, `src/shared/remote/verify-remote-cli-workflows.ts` — literal Bun pins
  become 1.4.4.
- `README.md` — Bun line states `^1.4.0` locally and the `.bun-version` pin (1.4.4) for CI/release.
- `docs/adr/001-initial-tech-stack.md` — release runtime version becomes 1.4.4.
- `docs/prd/runwield-core-prd.md` — the Supported development runtime requirement, its scenarios, and the remote
  development bundle paragraph keep their behavior and name no Bun version or range literal.
- `docs/prd/agent-behavior-evaluation-prd.md` — the fixture description names no Bun version.

Deliberately unchanged:

- `scripts/release-check.ts`. It already reads `.bun-version`.
- `evals/reviewer/*` fixture packages and `fixtures.ts` admission. These are hash-locked fixture identity.
- `records.test.ts`, `score.test.ts`, and `docs-workflow.test.ts` literal `1.4.3` values. These are test data and pass
  on any Bun once the `run.ts` gate is gone.
- Archived Plans, Work Records, and evaluation results that mention 1.4.3. They are history.

## Reuse Opportunities

- `scripts/reviewer-benchmark/configuration.ts` `captureConfiguration` — already records `bunVersion`. Resume comparison
  in `run.ts` already protects a run from a version change.
- `scripts/check-bun-runtime.ts` — remains the one place that enforces `^1.4.0`, through the `ci` script.

## Implementation Steps

- `scripts/reviewer-benchmark/run.ts` contains no comparison of `Bun.version` with a literal version, and does not import
  `scripts/check-bun-runtime.ts`.
- `scripts/reviewer-benchmark/configuration.test.ts` asserts `configuration.bunVersion` equals `Bun.version`.
- In `scripts/release-check.test.ts`, `withTemporaryVersionProject` writes `versions.bun` (from `node:process`) to the
  fixture `.bun-version`. Any expected message that names the fixture version (for example
  `"Release binary must execute Bun 1.4.3."`) uses the same value. The tests "release qualification rejects unproven
  Bun identity" still reject `deno 2.9.7`, `bun 1.3.12`, and a missing version.
- In `src/shared/runtime-supervisor.test.ts`, "supervisor survives a real Pi image-worker descriptor abort and explains
  recovery" accepts `/failed to create the event loop|ran out of file descriptors/` and still requires
  `result.signal === null`, a non-zero status, `RunWield reached the open-file limit`, `wld --continue`, and empty stdout.
- In the same file, "supervisor restores a real terminal after an image-worker descriptor abort" accepts exit status 134
  or 1 from the supervised child, and still checks restored terminal flags, the terminal reset sequence, and the
  open-file guidance.
- `docs-site/package.json` `engines.bun` is `^1.4.0`. `bun run install:locked` still succeeds with the frozen docs lock.
- `docs/contributing.md` says contributors use Bun `^1.4.0` and that CI and release builds use `.bun-version`.
- `.bun-version` contains `1.4.4`. A search of `.github/`, `scripts/`, `src/`, `package.json`, `docs-site/package.json`,
  `README.md`, and `docs/adr/` finds no `1.4.3` Bun pin except test data and fixture identity listed as unchanged above.
- `README.md` and `docs/adr/001-initial-tech-stack.md` name 1.4.4 or the `.bun-version` pin.
- `docs/prd/` contains no Bun version or range literal. The Supported development runtime requirement in
  `docs/prd/runwield-core-prd.md` still states: local commands accept the supported range, CI and release use one exact
  version, and an unsupported runtime stops with the required range and detected runtime. Its scenarios describe that
  behavior without version numbers.

## Verification Plan

Run on Bun 1.4.4 (`bun --version` prints `1.4.4`), after `bun run install:locked`:

```sh
bun scripts/run-tests.ts scripts/reviewer-benchmark scripts/release-check.test.ts src/shared/runtime-supervisor.test.ts scripts/check-bun-runtime.test.ts
```

Expected: all pass.

Then run the full gate on Bun 1.4.4: `bun run ci`. Expected: every test file passes except
`src/ui/review/plan-review.test.ts` if the unrelated uncommitted `quikdown` work is still present. Report that one
result separately; it is not a Bun failure.

The GitHub PR checks now run on Bun 1.4.4 through `.bun-version`. They must all pass.

The range claim needs a second version: run the focused command above on Bun 1.4.3 too (a 1.4.3 binary), so the suite
is proven version-agnostic and not just moved to a new exact pin.

Pin check:

```sh
grep -rn "1\.4\.3" .bun-version package.json docs-site/package.json .github scripts src README.md docs/adr
grep -rnE "Bun [0-9]|\^1\.4|1\.4\.[0-9]" docs/prd
```

Expected: only test-data literals in `scripts/reviewer-benchmark/*.test.ts` and `scripts/docs-workflow.test.ts`, and the
`scripts/reviewer-benchmark/fixtures.ts` fixture-identity check from the first command, and no output from the second.

Behavior that must stay protected:

- The reviewer benchmark still refuses to resume with a different configuration, which now includes a different Bun
  version. `run.test.ts` › "resume refuses changed configuration, fixture truth, selection, and timeout" must pass.
- Release qualification still refuses a binary whose Bun identity differs from `.bun-version`.
- The supervisor still restores the terminal and shows open-file guidance on both Bun versions.

Behavior expected to stop existing: the reviewer benchmark refusing to start on a Bun other than 1.4.3.

PRD scenario check: "Given a stable Bun in the supported range other than the CI version, local commands and the full
test suite pass" is proven by the full `bun run ci` on 1.4.4 plus the focused run on 1.4.3.

## Edge Cases & Considerations

- **Benchmark comparability.** Results from different Bun versions are now possible. Each run records its Bun version,
  and resume cannot mix versions. Compare results across runs with the recorded `bunVersion` in mind.
- **Future Bun messages.** The supervisor tests now name two Bun diagnostics. A later Bun may change the text again. The
  RunWield guidance assertions stay strict, so a real detection regression still fails.
- **Unrelated dirty work.** The `plan-review.test.ts` failure belongs to the in-progress `quikdown` change. This Plan does
  not touch it.
- **CI pin bump.** Release binaries change runtime from 1.4.3 to 1.4.4. The `oven/bun:1.4.4` image and the
  `bun-v1.4.4` release download must exist; both are published Bun releases. The next release build is the first real
  proof of the packaged artifact on 1.4.4.
- **Docs workflow.** It reads `.bun-version` from a `main` checkout, so it switches to 1.4.4 once this lands.
