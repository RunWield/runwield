---
planId: "40546021-690e-42c6-b055-eb499b85852a"
classification: "FEATURE"
complexity: "MEDIUM"
summary: "Make RunWield test tasks faster by isolating shared fixtures and running Deno test modules in parallel."
affectedPaths:
    - "deno.json"
    - "src/shared/session/agent-assets.js"
    - "src/shared/session/session.js"
    - "src/shared/session/session-catalog.test.js"
    - "src/shared/session/__tests__/session-tools-policy.test.js"
    - "src/acp/server.test.js"
    - "scripts/standalone-resource-smoke.js"
    - "scripts/release-check.js"
    - "docs/contributing.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-07-24T13:55:33-04:00"
updatedAt: "2026-07-24T19:09:13.101Z"
archivedAt: "2026-07-01"
status: "verified"
origin: "internal"
verifiedAt: "2026-07-24T19:09:00.321Z"
workRecord:
    status: "generated"
    recordId: "4f6ae8fc-aad9-4d7b-8f0f-8ea97a445a5b"
    path: "docs/work-records/2026-07-24-parallelized-deno-test-runs-safely.md"
    lastAttemptAt: "2026-07-24T19:09:05.028Z"
humanReviewMode: "ask"
humanReviewDecision: "skipped"
---

# Parallelize Test Runs Safely

## Context

`deno task test` currently prepares `src/shared/version.js` and then runs the entire suite through one serial
`deno test -A` invocation. The repository has roughly 150 test modules, so serial module execution leaves available CPU
capacity unused and lengthens the per-change quality gate.

Deno 2.9.3 provides native module-level parallelism through `deno test --parallel`; tests declared within one module
remain serial. Enabling the flag immediately is unsafe because some modules currently share writable state:

- bundled Agent Definitions and Skills are removed and recopied under the process-captured `~/.wld` path even during
  source runs, allowing parallel test workers to race over the same caches;
- Session catalog and tool-policy tests temporarily mutate the real Project's `.wld` overrides;
- the ACP CLI test runs `scripts/write-version.ts` inside a test worker even though the test task already prepares the
  generated version before starting the suite.

The agreed direction is to remove these shared-state hazards and parallelize the full suite. Do not introduce a
permanent serial quarantine list or broaden this FEATURE into concurrent `ci` stage orchestration.

## Objective

Make the general and Workspace test tasks use Deno's native test-module parallelism while preserving test behavior,
standalone-binary resource extraction, focused test invocation, useful Snip failure output, and a stable escape hatch
for resource-constrained machines through `DENO_JOBS`.

## Approach

Keep the test command interface simple and deepen the existing resource-resolution modules rather than adding a custom
scheduler:

1. Treat bundled resource extraction as a standalone-binary concern. During source and test runs
   (`Deno.build.standalone === false`), resolve Agent Definitions and Skills directly from their existing `src/`
   directories and do not touch `~/.wld/bundled-*`. Retain current extraction and fallback semantics for the compiled
   binary, where external tools need real filesystem paths. Verify both branches: a source subprocess with an isolated
   HOME must avoid cache creation, while a small release-only compiled probe must materialize readable resources under
   an isolated HOME.
2. Move Project override fixtures to unique temporary Project roots. Tests must pass those roots through existing
   `loadAgentDef`, catalog, and settings interfaces instead of changing the repository's actual `.wld` tree.
3. Keep `scripts/write-version.ts` as the single task-level preparation step. The ACP test should only launch the CLI
   and assert ACP behavior; it must not rewrite source files from a worker.
4. Add `--parallel` to the existing test tasks and rely on Deno's CPU-aware default scheduling. Preserve the standard
   `DENO_JOBS` environment override so callers can cap parallelism, including `DENO_JOBS=1` for serial-style diagnosis.
5. Document the execution model and concurrency override for contributors. Do not add a second test runner, shell
   background-process orchestration, or a maintained list of serial files.

## Files to Modify

- `deno.json` — add native module parallelism to `test` and `workspace:test` while preserving task-level version
  preparation, Snip wrapping, positional arguments, and unrelated in-flight task edits.
- `src/shared/session/agent-assets.js` — skip cache materialization for source runs and continue returning the bundled
  source directory through the existing fallback; preserve standalone extraction behavior.
- `src/shared/session/session.js` — apply the same standalone-only rule to bundled Skill extraction so source test
  workers only read `SKILLS_DIR`.
- `src/shared/session/session-catalog.test.js` — remove repository-root `.wld` cleanup/mutation and strengthen
  source-run assertions to prove bundled Agent Definition and Skill paths resolve from `src/` without HOME cache writes.
- `src/shared/session/__tests__/session-tools-policy.test.js` — create router and Planner overrides under temporary
  Project roots and load every affected Agent Definition through that explicit root instead of `CWD`.
- `src/acp/server.test.js` — remove the redundant `scripts/write-version.ts` child process from the ACP CLI smoke test.
- `scripts/standalone-resource-smoke.js` — add a release-only probe that imports the real Agent Definition and Skill
  resource resolvers, verifies standalone extraction paths are under HOME, and reads representative extracted files.
- `scripts/release-check.js` — compile the resource probe with the bundled Agent Definition and Skill directories,
  execute it with an isolated HOME, and fail the release check if standalone extraction or file readability regresses.
- `docs/contributing.md` — explain module-level parallelism, intra-module serial execution, and the `DENO_JOBS`
  cap/serial diagnostic option without changing unrelated quality-gate documentation.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `runtime-root.js` and `src/constants.js` — retain `RUNWIELD_SOURCE_ROOT`, `AGENT_DEFS_DIR`, and `SKILLS_DIR` as the
  source-run paths rather than adding test-specific resource locations.
- `Deno.build.standalone` usage in `src/ui/workspace/server.js` — follow the established runtime distinction between
  source execution and a standalone binary.
- `src/shared/session/agent-assets.js#getBundledAgentDefsPath` — preserve its extraction-or-source fallback as the small
  caller interface.
- `src/shared/session/session.js#listSkills` — preserve existing local/home/bundled precedence; only change how its
  bundled directory is resolved.
- `Deno.makeTempDir` and `Deno.Command` patterns already used throughout the affected tests and release script — use
  isolated Project/HOME roots, subprocesses whose environment is set before module import, and `finally` cleanup rather
  than creating a new fixture framework.
- `scripts/compile.test.js` coverage of `src/agent-definitions` and `src/skills` include paths — retain the release
  binary's existing resource inclusion contract while the probe exercises the standalone resolver branch.
- Deno's built-in `--parallel` scheduler and `DENO_JOBS` support — use the runtime's module isolation and concurrency
  controls instead of implementing process management.

## Implementation Steps

- [ ] Step 1: Update `extractBundledAgentDefs`/`getBundledAgentDefsPath` so non-standalone runs avoid HOME cache
      deletion and copying, resolve `AGENT_DEFS_DIR`, and keep the existing one-time standalone extraction/fallback
      behavior.
- [ ] Step 2: Update bundled Skill extraction in `session.js` with the same non-standalone short circuit, preserving
      `listSkills` precedence and standalone filesystem materialization for externally readable Skill files.
- [ ] Step 3: Refactor `session-catalog.test.js` to delete the repository-root cleanup helper and calls and keep all
      local fixtures inside per-test temporary Project roots. Add a subprocess assertion whose temporary HOME is set
      before imports; verify the real resource resolvers return paths beneath `AGENT_DEFS_DIR`/`SKILLS_DIR` and that the
      subprocess creates no `~/.wld/bundled-*` cache directories. This must not depend on or inspect the contributor's
      actual HOME overrides.
- [ ] Step 4: Refactor the router protected-tool and Planner Work Record protected-tool tests in
      `session-tools-policy.test.js` to create their overrides in unique temporary Project roots, pass those roots to
      `loadAgentDef`, and remove the read/restore helpers that existed only to protect real Project files.
- [ ] Step 5: Remove the in-test version-generation subprocess from the ACP CLI smoke test. Keep the CLI child process,
      piped protocol exchange, exit-code assertion, stdout JSON parsing, and stderr assertion unchanged.
- [ ] Step 6: Add `scripts/standalone-resource-smoke.js` as a small compiled probe of the actual resource resolver
      interfaces. Update `release-check.js` to compile it with `src/agent-definitions` and `src/skills`, run it with an
      isolated HOME, require representative workflow-prompt and Skill files to be readable from extracted HOME paths,
      and clean up the probe binary/cache with the existing release temporary directory.
- [ ] Step 7: Add `--parallel` to the `test` and `workspace:test` Deno invocations. Verify extra task arguments still
      reach `deno test`, Snip still reports actionable failures, and `DENO_JOBS` controls worker count without task
      changes.
- [ ] Step 8: Update contributor guidance with the parallel-module/serial-intra-module model and examples for default,
      capped (`DENO_JOBS=2`), and serial-style (`DENO_JOBS=1`) test runs.
- [ ] Step 9: Benchmark warm serial and parallel runs at 2 workers, 4 workers, and Deno's CPU-default worker count.
      Record medians from at least three runs of each, confirm the default parallel task improves wall-clock time, and
      retain Deno's default scheduling unless repeatable evidence shows it regresses on the execution machine.
- [ ] Step 10: Stress the completed suite with multiple shuffled parallel runs, exercise a controlled failing test
      through Snip to verify parallel failure diagnostics, then run the complete quality gate and verify tests leave the
      Project `.wld` fixtures and generated version file free of worker-time mutations.

## Verification Plan

- Automated targeted regressions:
    - `deno task test src/shared/session/session-catalog.test.js src/shared/session/__tests__/session-tools-policy.test.js src/acp/server.test.js`
    - Expected: all affected tests pass in one parallel invocation; bundled source paths are used; no repository-local
      Agent Definition, prompt, or Skill fixture is created, removed, or restored.
- Automated Workspace subset:
    - `deno task workspace:test`
    - Expected: Workspace test modules pass under native parallel scheduling.
- Automated concurrency controls:
    - `DENO_JOBS=1 deno task test`
    - `DENO_JOBS=2 deno task test`
    - Expected: both runs pass with the same discovered test count as the default task; no command or task rewrite is
      needed to alter concurrency.
- Automated ordering/race stress:
    - `for seed in 101 202 303 404 505; do deno task test --shuffle=$seed || exit 1; done`
    - Expected: all five parallel shuffled runs pass without intermittent missing bundled resources, override leakage,
      source-file writes, fixed-port conflicts, or cleanup failures.
- Controlled Snip failure diagnostic:
    - create a temporary `*.test.js` containing one named test that throws an error with a unique marker, run it through
      `snip run -- deno test -A --parallel <temporary-test>`, capture the expected nonzero result, and remove the fixture.
    - Expected: filtered output retains the failing file/test name and unique error marker; a parallel failure remains
      actionable rather than collapsing to a generic failure.
- Performance comparison after one warm-up run, using three timed runs for each candidate:
    - serial baseline: `/usr/bin/time -p deno test -A`
    - two workers: `DENO_JOBS=2 /usr/bin/time -p deno test -A --parallel`
    - four workers: `DENO_JOBS=4 /usr/bin/time -p deno test -A --parallel`
    - CPU default: `/usr/bin/time -p deno test -A --parallel`
    - Expected: the default parallel task has a lower median wall-clock duration than the serial baseline. Report both the
      before/after medians and worker setting; do not infer speedup from a single run.
- Standalone resource smoke and full gate:
    - `deno task release:check`
    - `deno task ci`
    - Expected: the compiled resource probe materializes and reads a representative workflow prompt and Skill beneath its
      isolated HOME; check, Workspace check, lint, parallel tests, the normal binary review smoke, and the new standalone
      resource smoke all pass.
- Repository-state check:
    - compare `git status --short` and `git diff -- .wld src/shared/version.js` before and after repeated raw test runs.
    - Expected: test workers do not alter Project-local `.wld` state or rewrite `src/shared/version.js`; only intentional
      implementation and documentation changes remain.

## Edge Cases & Considerations

- Deno parallelizes test modules, not individual tests in a module. Large modules such as Plan Store, Workflow
  Validation, Workspace, and load-Plan tests can remain a serial tail; splitting them is a separate optimization and is
  out of scope.
- Source runs can read bundled Markdown directly, but standalone binaries still need extracted real files for external
  read tools. The release-only resource probe must import the production resolvers rather than duplicate extraction
  logic; compiling a second small probe is accepted in the slower release gate and must not become part of `test`.
- Parallel workers increase peak CPU, memory, subprocess, and filesystem pressure. `DENO_JOBS` must remain the supported
  cap rather than hard-coding the executing developer's 12-core machine into project behavior.
- Tests that mutate `Deno.env`, current working directory, clocks, fetch, or other globals are safe only because Deno
  isolates parallel modules and tests inside each module remain serial. New concurrent steps inside one module must
  continue restoring process-global state in `finally` blocks.
- Tests that start servers must continue using OS-assigned ports; fixed parser/config values must not become fixed
  listeners.
- The current working tree contains unrelated `deno.json` task cleanup. Execution must make a surgical test-command edit
  and must not reintroduce removed tasks, reorder the task block, or overwrite those in-flight changes.
- Snip only filters output and does not provide scheduling. Failure output must remain sufficiently complete to identify
  the failing parallel module and test.
- Assumption: Deno 2.9.3 remains the minimum execution environment for this change, with `--parallel`,
  `Deno.build.standalone`, and `DENO_JOBS` available as observed during planning.
