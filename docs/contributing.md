# Contributing

Thanks for helping improve RunWield. RunWield is source-available and accepts issues and pull requests, but it is not
open source yet. Before contributing, read the [license](../LICENSE).

## Start with the design docs

RunWield has strong workflow opinions. Before changing behavior, read the docs that explain the current model:

- [Core Architecture](architecture.md) maps the runtime boundary, workflow orchestration, Plan lifecycle, validation,
  persistence, and source guide.
- [Entity Model](entity-model.md) maps durable entities, transient workflow objects, adapter projections, and storage
  authorities.
- [Plan Lifecycle](plan-lifecycle.md) explains Plan statuses, events, validation, repair, and delivery.
- [Workflow Validation Authority](validation-authority.md) explains which record owns each validation fact.
- [Settings Reference](user-documentation/settings.md) documents configuration files, precedence, and commands.
- [Themes](user-documentation/themes.md) and the [Design System](design-system.md) cover user-facing UI conventions.

Product and architecture guidance:

- [ADRs](adr/) hold Architecture Decision Records. Read the relevant ADRs for any architectural seam you touch.
- Five living central PRDs hold current principles and lasting requirements: [RunWield](prd/runwield.md),
  [Core](prd/runwield-core-prd.md), [Connect](prd/runwield-connect-prd.md), [Workspace](prd/runwield-workspace-prd.md),
  and [ACP](prd/runwield-acp-protocol-prd.md). Other PRDs are transient proposals. After implementation, fold lasting
  requirements into the central owner, update references, and remove the completed PRD. Git history preserves proposals;
  Work Records preserve delivery evidence.

## Development setup

Contributors use Bun 1.4.3. Install the pinned root and docs dependencies before running commands:

```bash
bun run install:locked
```

Common commands:

```bash
bun run cli "your request"
bun run check
bun run test
bun run ci
bun run docs:dev
bun run docs:check
bun run compile
```

`bun run ci` runs all ten static gates, then the source tests and Golden TUI portfolio in one isolated worker queue.
`bun run pr:check` is an alias for that complete local gate. Successful CI prints one summary; failure diagnostics are
filtered through Snip and retained in the reported log. Use `bun run ci --source-only` when a separate required Golden
job owns those scenarios, as the PR and release workflows do.

`bun run test` remains the focused source suite. `bun run test:golden-tui` runs the composed TUI scenarios and their
harness tests; `test:golden-tui:extensive` runs the same complete portfolio. Always use these tasks or
`bun scripts/run-tests.js <test paths or runner options>`; never invoke `bun test` directly. Each file gets a separate
process, HOME, temporary directory, and Mnemoteca database.

Workspace memory diagnostics use the same Bun compiler and embedded payload as the CLI:

```bash
bun run workspace:build
bun scripts/workspace-memory-check.ts --scenario renderer
bun scripts/workspace-memory-check.ts --scenario operations
bun scripts/workspace-memory-check.ts --scenario combined
```

Each scenario measures source and standalone execution, with and without forced collection, in disposable homes.
Historical Deno memory measurements remain historical baselines; the current diagnostic reports Bun measurements.

Interactive RunWield sessions expect these helper binaries in `PATH`:

- [`mnemoteca`](https://github.com/gandazgul/mnemoteca) for memory-backed agent behavior.
- [`cymbal`](https://github.com/1broseidon/cymbal) for code intelligence.
- [`agent-browser`](https://github.com/vercel-labs/agent-browser) for browser-driven UI/UX verification.
- [`snip`](https://github.com/edouard-claude/snip) for compact command-output rewriting. Snip is optional at runtime and
  fail-open, but local validation tasks may invoke it when installed by the standard setup path.

The shell installer is the normal standalone recovery path for missing helper binaries. Package-managed installs should
be repaired with their package manager instead. The Homebrew formula uses `gandazgul/tap/mnemoteca`,
`1broseidon/tap/cymbal`, `ketch`, `agent-browser`, and `git`; it does not run helper setup during formula installation.
RunWield also ships bundled Snip filters for Deno validation output; install or remove user-level copies with:

```bash
wld snip-filters install
wld snip-filters cleanup
```

## Task compatibility

Use the established task names with Bun: `bun run compile`, `bun run ci`, `bun run workspace:build`, and so on.
All 49 original Deno task names remain available. See the [complete task audit](plans/bun-task-compatibility.md) for
per-task argument contracts and explicit runtime-specific exceptions.

```bash
bun run compile --output "bin/my wld" --target x86_64-unknown-linux-gnu
bun run test:suite src/shared/example.test.ts --filter "test name"
bun run test:suite src/shared/example.test.ts --filter '/^test name$/'
```

`compile --reload` has no frozen-install equivalent and fails explicitly; install locked dependencies before compiling.
Deno-specific test flags are rejected, including permissions, coverage, watch and shuffle options. The portable runner
options remain available. Workspace development/build commands require explicitly exported environment variables;
ambient `.env` loading is disabled. Production-equivalent container sandboxing is deferred for the test images.

### Remote development bundle

`wld remote` uses an explicitly built development bundle. Build the launcher and both Linux targets from the same
unchanged checkout, then assemble them:

```bash
bun run compile --output bin/wld
BUILD_ID=$(bun -e 'console.log((await Bun.file("bin/wld.build.json").json()).buildId)')
bun run compile --target x86_64-unknown-linux-gnu --output bin/wld-linux-x64 --expect-build-id "$BUILD_ID"
bun run compile --target aarch64-unknown-linux-gnu --output bin/wld-linux-arm64 --expect-build-id "$BUILD_ID"
bun scripts/release-assets.js development bin/wld bin/wld-linux-x64 bin/wld-linux-arm64 bin/remote-build
```

Use `bin/remote-build/wld-launcher` with its adjacent Linux target files and `.build.json` files. A connection never
compiles on demand or substitutes a released binary. Remote host prerequisites are in the
[Core PRD](prd/runwield-core-prd.md#remote-connection).

## Codebase guide

Use this as an orientation map, not a directory inventory:

- `src/cli.ts` is the executable entry point and command dispatch module. It delegates command behavior to handlers
  registered from `src/cmd/`.
- `src/cmd/` owns CLI command boundaries such as `router`, `load-plan`, `plans`, `workspace`, `init`, settings, auth,
  and install/update helpers.
- `src/shared/session/` is the live Session runtime center of gravity: hosted sessions, agent construction, transcript
  segments, adapter-neutral events, and continuation control.
- `src/shared/workflow/` owns routing decisions, Plan approval/execution orchestration, lifecycle transitions,
  mechanical and semantic validation, repairs, and Epic/FEATURE flow.
- `src/shared/` also contains cross-cutting project state, settings, model/resource handling, collaboration, worktrees,
  work records, and runtime preflight helpers.
- `src/agent-definitions/`, `src/prompt-templates/`, and `src/skills/` are the bundled agent, slash-prompt, and skill
  layers. Project `.wld/` overrides home `~/.wld/`, which overrides these bundled defaults.
- `src/extensions/` contains runtime integrations for Mnemoteca, Cymbal, and Snip. Keep integration-specific tools,
  hooks, and tests isolated there when practical.
- `src/tools/` contains RunWield-specific agent tools that are not better owned by an extension package.
- `src/ui/tui/` is the terminal adapter. `src/ui/workspace/`, `src/review-workspace-server.js`, and `src/ui/review/` are
  the browser Workspace and review surfaces. Shared visual language belongs in `src/ui/design-system/` and
  `src/ui/theme/`.
- `docs/plans/` stores durable Plan Markdown. `docs/` (outside `docs/plans/`) stores user, contributor, architecture,
  ADR, PRD, and product docs.

## Golden TUI Scenarios

Golden TUI Scenarios are deterministic, Playwright-like regression tests for the composed terminal UI and workflow
runtime. Run them with:

```bash
bun run test:golden-tui
# release-tier alias
bun run test:golden-tui:extensive
```

Golden tests exercise the real TUI composition, Session Runtime, workflow transitions, storage, and Git repositories.
Keep these journey tests: passing isolated source tests cannot prove that those pieces work together. Their terminal
adapter and scripted external model responses make failures reproducible without replacing internal machinery.

Golden setup copies immutable real Git baselines into separate repositories and remotes. Each scenario still gets its
own mutable filesystem, settings, stores, and locks. Fixture providers preserve streaming deltas without artificial
network delays; scenarios that test interruption can explicitly request slow streaming with `modelTokensPerSecond`.

Local runs use up to eight workers, bounded by available CPUs; override with `WLD_TEST_CONCURRENCY`. PRs and releases
run four source shards with four workers each and four Golden shards with three workers each. Every shard is required.
The standalone Golden workflow also covers pushes to `main` and `release/**`. Shard membership depends only on the
sorted file list, never a runner's timing cache. Reproduce one shard with `--shard 2/4` in isolated discovery mode or
`WLD_TEST_SHARD=2/4`. Nested runner tests clear the inherited shard selection.

Timing does not require verbose output. Reports under `.ci-cache/` contain:

- `ci-timings.json`: elapsed time for every CI task.
- `tests[-N-of-M]-timings.json` and `golden[-N-of-M]-timings.json`: file timing history used for scheduling.
- `*-report/run.json`: file durations, prewarm time, worker count, and pass/fail/skip totals for the latest run.
- `*-report/*.xml`: the isolated runner's JUnit results with each test's name, duration, failure, and ignored status.

Use `--report-dir <directory>` for separate benchmark runs and `--timings-file <file>` for an explicit history. CI
uploads these reports even on failure. Timing history starts slow files first from the first observation. Dependency
caches can be reused with `WLD_TEST_DENO_DIR`; mutable RunWield state remains isolated per file. `bun run ci` collects
all failures by default so an Agent can repair them together. Use `bun run ci --fail-fast` for quicker first-failure
feedback: it stops scheduling new files after a failure and lets active files finish. Passing runs still execute every
selected test; failures and unexecuted files never produce a green gate.

Author scenarios under `src/ui/tui/golden-scenarios/` and shared harness helpers under `src/ui/tui/testing/`:

- use hand-written scenario scripts and assertions; do not use raw Session Transcript JSONL as the scenario format;
- drive user behavior through terminal actions or the public Golden runner, not by reaching into private TUI blocks;
- keep expected answers, scripts, images, and fixtures outside the temporary Project root when an Agent's tools could
  discover them;
- declare coverage capabilities on scenarios and back each declaration with an assertion wrapped by
  `assertCoverageWith`;
- prefer semantic assertions: normalized screen text, Runtime events, Plan metadata, workflow outcomes, worktree/Git
  facts, Session replacement identity, validation evidence, Work Records, and cleanup state;
- normalize unstable UUIDs, paths, ports, durations, commit hashes, and animation frames only at comparison/reporting
  edges.

When diagnosing a failure, inspect the retained artifact path in the thrown error. Golden diagnostics should identify
the scenario, active Agent/phase, recent Runtime activity, last normalized screen, remaining scripted turns, and durable
temp state. Update expected output only when the user-visible workflow behavior intentionally changed; do not weaken a
scenario to bypass a real Runtime, workflow, Plan Review, validation, worktree, or TUI defect.

Golden TUI Scenarios are not browser Plan Review tests, live-model benchmarks, ACP parity tests, or true-PTY smoke
tests. Browser behavior remains owned by Workspace/Playwright coverage; future PTY smoke tests should stay as a thin
startup/raw-terminal layer rather than replacing these deterministic scenarios.

## Bundled runtime extensions

Runtime integrations live under `src/extensions/`. They are loaded as Pi extension factories during Agent Session setup.

- `src/extensions/mnemoteca/` adds memory recall, storage, and deletion tools backed by Mnemoteca.
- `src/extensions/cymbal/` adds code search, symbol lookup, impact analysis, and tracing tools backed by Cymbal.
- `src/extensions/snip/` adds a fail-open `tool_call` hook that prefixes eligible agent `bash` commands with Snip.

Keep extension behavior isolated to the extension package where practical. Session wiring should decide whether an
extension is available and register it; the extension should own its event handlers, tool definitions, command
rewriting, and focused tests.

## Code style

- New production source files should be TypeScript (`.ts` or `.tsx` as appropriate). Existing JavaScript with JSDoc is
  still valid; do not force-convert unrelated files, but migrate JS files when you are already touching them for source
  changes and the migration is reasonably bounded.
- Keep Bun-native execution. Use real file extensions in imports, do not add a `tsc` emit pipeline for runtime code,
  and let `bun run check`/CI be the type gate.
- Do not use `any`, `unknown`, or bare `object` in TypeScript types. Define named object shapes instead of inline
  complex types.
- In remaining JavaScript, use JSDoc for types. Prefer `@typedef` for object shapes and type function parameters in the
  `@param` block rather than adding casts or body-local `@type` declarations.
- Keep CLI entry points thin. Command behavior belongs under `src/cmd/<command>/`; shared behavior belongs under
  `src/shared/` or the narrower center of gravity that owns it.
- Resolve home and cwd through `getHomeDir()` and `getCwd()` from `src/constants.js` in `src/`. Do not read
  `Deno.env.get("HOME")` or `Deno.cwd()` directly in source, and do not cache process-global state at module scope.
- Wrap tests that mutate `HOME` or the working directory in `withProcessGlobalTestLock` from
  `src/testing/process-global-lock.ts`.
- Preserve the layered customization model: project `.wld/` overrides home `~/.wld/`, which overrides bundled defaults.
- Keep docs, plans, ADRs, PRDs, and Work Records as Markdown.

## Public documentation

`docs.runwield.dev` publishes two parts:

- **The user manual** from `docs/user-documentation/`. Read its [README](user-documentation/README.md) before editing:
  those pages are for people who use RunWield, so internals, plans, and work in progress stay out.
- **This Contributing section:** this page, [Plan Lifecycle](plan-lifecycle.md),
  [Workflow Validation Authority](validation-authority.md), and the five central PRDs.

`scripts/public-docs.ts` lists every published page. Plans, Work Records, audits, research, and other PRDs stay in the
repository only. `bun run docs:dev` starts a preview at `http://localhost:4322`, and `bun run docs:check` validates
and builds the site.

`docs/stable` is the source for `docs.runwield.dev`. It identifies the Stable release it describes. Make corrections to
that branch through normal review, then forward-port the same correction to `main`. Do not add unreleased product
behavior to `docs/stable`. A Stable release merges its tagged source into the branch without force-pushing, so retained
corrections survive. Resolve a merge conflict by checking the instruction against the released product; a failed merge
leaves the existing site live.

## Plan review UI in a source checkout

Plan review and code review run inside Workspace using a vendored Plannotator. If they don't open from a source
checkout:

- Check that `third_party/plannotator/` exists and matches `third_party/plannotator-revision.txt`.
- Run `bun run workspace:dev` to open a catalog of the Plan Board, Plan Review, and Code Review with fixture data.
- Run `bun run workspace:check` to confirm the `@plannotator/*` imports resolve.

## Plan Server development

The checked-in Bun containers are for testing, with equivalent Deno runtime permission enforcement deferred.
They are not hardened production definitions. Compose keeps loopback publishing, a nonroot process, a read-only root,
dropped capabilities and no-new-privileges. These controls do not recreate Deno's filesystem or subprocess allowlists.
Do not mount sensitive host paths or credentials into this test image.

Run the collaboration Plan Server from source without a container:

```bash
RUNWIELD_REMOTE_HOST=127.0.0.1 \
RUNWIELD_REMOTE_PORT=8080 \
RUNWIELD_REMOTE_DB_PATH=.wld/remote-workspace.sqlite \
bun run workspace:remote
```

After changing collaboration or its packaging, run this end-to-end check. See the user guide,
[Self-hosted collaboration](user-documentation/collaboration.md), for setup.

Use this checklist after changing packaging or collaboration behavior:

1. `podman compose -f compose.yml up -d`.
2. Confirm `curl http://127.0.0.1:8080/healthz` and `/readyz` return `{"ok":true,"mode":"remote"}`.
3. Configure `planServerUrl` or pass `--plan-server http://127.0.0.1:8080`.
4. Run `wld plans share <plan>` and save the reviewer and maintainer URLs securely.
5. Open the reviewer URL in a browser and add comments from two display names.
6. Resolve and reopen at least one comment.
7. If retention is enabled, verify the browser and CLI display expiry and that writes refresh it.
8. In another checkout, run `wld plans pull '<maintainer-url>' --to <plan-name>`.
9. Let Planner or Architect incorporate the feedback into the local Plan.
10. Run `wld plans push <plan-name>`.
11. Reopen the reviewer URL and verify the new Revision is available while older Revision comments stay scoped.
12. Inspect SQLite and representative network payloads for ciphertext-only semantic content.
13. Stop the service, back up the volume, restore it, restart, and verify `/readyz` plus a known reviewer URL.
14. Run `wld plans unshare <plan-name>` and verify old reviewer/maintainer links stop working.

## Pull request checklist

1. Create a branch.
2. Make focused changes.
3. Update docs when behavior changes.
4. Run `bun run ci` for code changes.
5. For docs-only or config-only changes, run `bun run fmt:check <changed-files>` at minimum.
6. Open a PR with:
    - a summary,
    - the affected routing intent or flow (`INQUIRY`, `IDEATION`, `OPERATION`, `QUICK_FIX`, `PLANNED_CHANGE`, or
      `PROJECT`),
    - validation notes,
    - any follow-up work or known gaps.

## Workflow expectations

RunWield itself is plan-by-default for non-trivial work. Contributions should preserve that product shape:

- `INQUIRY` handling should stay answer-focused through Guide.
- `IDEATION` handling should clarify ideas through Ideator before routing implementation work.
- `OPERATION` work should stay non-code and self-verified by Operator.
- `QUICK_FIX` work should stay small, code-bounded, and pass Mechanical Validation after Engineer completion.
- `PLANNED_CHANGE` work should be traceable to a reviewable plan when the blast radius is non-trivial.
- `PROJECT` work should be represented as an Epic: Architect owns the design, interactive Slicer owns child
  PLANNED_CHANGE boundaries, and execution happens through those child PLANNED_CHANGE plans.
- Workflow validation should remain an independent acceptance gate for saved plan execution.

## License note

RunWield is source-available and free to use, inspect, and run for personal, internal, or commercial work. You may
submit issues and pull requests.

You may not distribute modified versions, publish derivative works, rebrand RunWield, or offer it as a competing product
or service without prior written permission.
