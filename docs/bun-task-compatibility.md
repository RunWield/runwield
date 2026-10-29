# Public task compatibility audit

Baseline: all **49** `deno.json` tasks at `9d4bb0374`, the phase-2 starting point. Every name exists in `package.json`.
There are **no intentional task-name exceptions**. Use `bun run <original-name> [arguments]`.
`docs-site/deno.json` contained no tasks. The root and docs Deno manifests/locks are now retired.

The independent task inventory in `scripts/task-compatibility.test.ts` prevents silent renames. Its real Bun shell
fixtures check nested task dispatch, argument boundaries (including spaces), and failed prerequisite propagation;
compiler, isolated-runner and release tests separately cover the product behavior behind those commands.

| Original task | Bun contract |
| --- | --- |
| `ci` | Same `--fail-fast`; `--source-only` remains available for a separate Golden gate. |
| `cli` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `submodules:check` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `submodules:check:remote` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `snip:check` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `language-policy:check` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `seams:check` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `doc-links:check` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `docs:stage` | Same staging entrypoint and arguments. |
| `docs:dev` | Same staged docs watcher and fixed loopback port 4322; no extra CLI options before or after migration. |
| `docs:build` | Same staging/build order and trailing Astro build arguments. |
| `docs:check` | Same staging/check/build/link-check order; trailing arguments still reach the final docs checker. |
| `skills:sync:check` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `skills:sync:update` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `seams:update` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `test` | Same suite scope and preparation; preserves paths, `--isolated`, exclusions, fail-fast, shard/report/timing options. Restores `--filter` substring or `/regex/`; runtime flags below. |
| `test:suite` | Same suite scope and preparation; preserves paths, `--isolated`, exclusions, fail-fast, shard/report/timing options. Restores `--filter` substring or `/regex/`; runtime flags below. |
| `test:all` | Same suite scope and preparation; preserves paths, `--isolated`, exclusions, fail-fast, shard/report/timing options. Restores `--filter` substring or `/regex/`; runtime flags below. |
| `test:all:suite` | Same suite scope and preparation; preserves paths, `--isolated`, exclusions, fail-fast, shard/report/timing options. Restores `--filter` substring or `/regex/`; runtime flags below. |
| `pr:check` | Forwards arguments to `ci`. |
| `lint` | Same repository-wide file inventory; neither old nor new wrapper accepts file-selection arguments. |
| `githooks:install` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `githooks:uninstall` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `check` | Same version preparation and source/test type scope; neither old nor new wrapper accepts file-selection arguments. |
| `workspace:dev` | Same loopback host, port 5173 and `/dev`; forwards Astro arguments. Environment-loading exception below. |
| `workspace:remote` | Same server configuration/environment; now runs Bun. |
| `workspace:remote:build` | Builds Workspace and both runtime bundles in order. |
| `workspace:remote:image:check` | Same optional image argument and Podman filesystem inspection; image security status below. |
| `workspace:react:check` | Forwards to `workspace:check`. |
| `workspace:test` | Same suite scope and preparation; preserves paths, `--isolated`, exclusions, fail-fast, shard/report/timing options. Restores `--filter` substring or `/regex/`; runtime flags below. |
| `workspace:build` | Pinned Astro build; forwards trailing Astro arguments. Environment-loading exception below. |
| `workspace:check` | Same Astro check root/tsconfig and trailing Astro arguments. |
| `compile` | Preserves `--output`, `--target` (all six legacy target triples), and `--expect-build-id`, with separate or `=` values. `--reload` exception below. |
| `ux:new-user` | Same Podman build/run arguments and explicit provider environment forwarding. |
| `ux:new-user:current` | Same architecture selection and build/run order; invokes named `compile --target`. |
| `release:check` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `release:metadata` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `release:candidate` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `release:promote` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `release:stable` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `package:homebrew` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `package:homebrew:check` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `package:windows` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `package:windows:check` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `package:winget` | Same script/action, fixed subcommand/options, and caller arguments; execution uses Bun where applicable. |
| `compile:watch` | Same watchexec extensions and ignores; invokes `compile`. |
| `prototype` | Same slug and forwarded dev arguments; project dev task now comes from package.json. |
| `test:golden-tui` | Same suite scope and preparation; preserves paths, `--isolated`, exclusions, fail-fast, shard/report/timing options. Restores `--filter` substring or `/regex/`; runtime flags below. |
| `test:golden-tui:extensive` | Same suite scope and preparation; preserves paths, `--isolated`, exclusions, fail-fast, shard/report/timing options. Restores `--filter` substring or `/regex/`; runtime flags below. |

## Explicit compatibility limits and decisions

- `compile --reload` used to refresh Deno's module cache during compilation. It now fails with a specific explanation.
  The migration's frozen-install policy requires `bun run install:locked` before compilation. A lock-preserving cache
  refresh option would need an explicit command contract; no dependency refresh or lock update is silently performed.
- Test tasks retain the portable runner options and restore `--filter` with Deno substring/`/regex/` behavior, including
  child steps. Arbitrary Deno test CLI passthrough is not portable. Permission flags (`--allow-*`, `--deny-*`, `-A`),
  loader/type-checking flags, watch, coverage, shuffle, and native reporter flags are rejected rather than ignored.
  A requirement to retain any of these names/semantics needs a separately qualified adapter; in particular, Bun cannot
  supply Deno runtime permission enforcement. Use `check`, runner `--report-dir`, and `WLD_TEST_CONCURRENCY` for the
  existing checked type, report and scheduling contracts. This is not a claim that those replace every Deno flag.
- `workspace:dev` and `workspace:build` previously enabled Deno's automatic `.env` loading. The Bun migration explicitly
  disables ambient dotenv loading for reproducibility. Export required environment variables explicitly. Restoring
  implicit `.env` loading would be a separate decision, not a task rename.
- `prototype` keeps its name and arguments, while prototype projects use a Bun `package.json` `dev` script. Existing
  Deno-only prototype definitions need conversion; the runner gives an explicit setup error.
- `workspace:remote:image:check` keeps its name and image argument. Carlos approved Bun **test-only, non-hardened**
  container definitions without equivalent Deno permission checks. Production hardening remains deferred.

## Transitional and historical commands

`ci:bun`, `check:bun`, `lint:bun`, and `workspace:build:bun` forward to their canonical counterparts. `compile:bun`
retains its transitional positional-output/target contract; normal development and CI use `compile --output ... --target ...`.
`test:bun`, `check:package:bun`, and `check:provider:bun` are migration qualification tools with no original Deno task
counterparts. `test:bun` has an explicit inventory, unlike the complete public source/Golden tasks.

Release recovery is the sole active historical `compile:bun` caller: immutable RC1 checkouts predate the Bun named
`compile` implementation. The release workflow checks for that implementation and uses the historical alias only when
it is absent. No existing tag is rewritten. Old work records and dated migration checkpoints preserve historical commands.
