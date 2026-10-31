---
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "deno.json"
    - "package.json"
    - "scripts/run-tests.js"
    - "scripts/compile.js"
    - "src/shared/private-json-file.ts"
    - "src/shared/session/file-session-storage.ts"
    - "src/shared/session/file-session-control.ts"
    - "src/constants.js"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-10-10"
status: "draft"
planId: "f79cd8d2-970c-4adf-859d-f6db48ef8e1a"
---

# Migrate RunWield's runtime without weakening storage or isolation

Current contributor commands retain the original task names; use `bun run compile --output <path>` and `bun run ci`.
Dated checkpoints below record the transitional names used at the time. See [the task compatibility audit](bun-task-compatibility.md).
Carlos subsequently approved Bun-only test container definitions without equivalent Deno permissions; see
[the phase-2 plan](bun-only-toolchain.md) for the current container scope.

## Context and recovered decisions

Carlos requested continued migration work while away. The October 10 runtime discussion selected a Bun proof of concept
before a production decision. His subsequent clarification makes the complete Bun toolchain (including package
management) the preferred migration target, with Node plus pnpm as a fallback if compatibility evidence warrants it. Bun
plus pnpm is not the selected combination. A future Core/Workspace repository or licensing split is a separate change.

The existing feasibility experiment is in branch `codex/bun-poc`, based on `28cc9d28f`, at
`/Users/gandazgul/.codex/worktrees/bun-poc/runwield`. Its uncommitted report is `docs/research/bun-runtime-poc.md`; its
executable source and results are ignored under `prototypes/bun-runtime/`. Preserve those files before archiving that
worktree. This continuation does not modify them.

The POC report records ten passing dependency/OS probes on macOS ARM64 and Linux ARM64, macOS PTY checks, and Deno/Bun
POSIX-lock interoperability. It used Bun **1.4.3**; the installed global 1.3.12 lacked the required `node:sqlite`
import. Photon's WASM and Pi's image worker required explicit executable embedding. This is evidence for feasibility,
not qualification of the full application or a final runtime decision.

The source discussion proposed four stages: prove difficult runtime features; move dependencies/tooling; migrate
production and tests subsystem by subsystem; qualify and switch distribution. This document makes those stages concrete.

## Objective and scope

Preserve current Session identity, files, recovery, writer exclusion, CLI/TUI behavior and Workspace journeys while
replacing Deno-specific runtime dependencies. Follow [ADR-015](../adr/015-file-authoritative-session-bundles.md) and the
Core [execution, validation and recovery requirements](../prd/runwield-core-prd.md#execution-validation-and-recovery).
No current PRD requirement is added or removed by the first portable storage slice.

Bun is the preferred target; Node + pnpm remains the fallback if compatibility evidence warrants it. No target-choice
clarification is needed to continue. Production cutover still requires the acceptance gates below: do not replace the
default runtime, installer, CI or package manager based solely on the POC recommendation.

## Implementation sequence and acceptance gates

1. **Portable storage foundation (this continuation).** Move private directory creation and atomic JSON persistence out
   of `file-session-storage.ts` into `src/shared/private-json-file.ts`, using `node:fs`, `node:path` and `node:crypto`.
   Preserve current exports/callers, 0700 directories, 0600 replacement files, exclusive temporary creation, complete
   writes, file fsync, atomic rename, best-effort parent fsync, and existing failure propagation. Preserve current
   temporary-file retention after a failed write/rename. Keep Session locks and file formats unchanged. Test real files
   under Deno, Bun and Node, then the real Session store under Deno. This slice does not make the Session store fully
   runtime-portable: readers, locks, paths and the wider dependency graph still depend on Deno.
2. **Dependency and tooling migration.** Pin the qualified Bun runtime and convert the full import map and locked
   dependencies, including package subpath aliases and vendored Plannotator paths. Establish the Bun
   manifest/lock/install configuration (or pnpm if Node wins). Preserve the 24-hour minimum dependency age, its existing
   Earendil exception, and install-script trust policy. Keep type checking separate from TS execution. Map formatter,
   linter, custom lint plugins, skill sync, injection-seam and documentation checks before replacing their Deno tasks.
   Accept when clean installs reproduce the locked graph and all existing checks retain coverage.
3. **Isolated tests and process/environment utilities.** Preserve one process and disposable HOME, temporary directory,
   XDG paths and Mnemoteca database per test file. Preserve `getHomeDir()`/`getCwd()` as lazy accessors and fail-closed
   protections against direct unsandboxed suites. Port process spawn, streams, cancellation and descendant termination
   with real subprocesses. Keep zero injection seams for owned machinery. Accept when parallel runs do not share mutable
   state and cancellation reaps descendants without falsely completing recovery.
4. **Storage, locks and workflow execution.** Move readers and writers in coherent slices; audit both `ENOENT` and Deno
   exception consumers during mixed-runtime development. Preserve durable-write ordering, generation/fence validation,
   snapshot-safe stale-lock retirement, crash release and cross-process exclusion. POSIX FFI proof is not a Windows
   solution: qualify Windows native locks and error semantics before replacing the production lock implementation.
   Accept against real Session, Plan, worktree, recovery and cross-runtime contention cases.
5. **CLI/TUI, integrations and Workspace.** Exercise real CLI startup, provider streaming/cancellation, MCP stdio/HTTP,
   ACP, SSH, terminal input/resize/restoration and the golden TUI portfolio. Build the full Astro/React Workspace and
   validate browser flows, assets, SSE and reconnect. The POC's import checks and small HTTP server do not cover these.
6. **Distribution switch.** Embed Photon WASM, the image worker, prompts, skills, fonts and Workspace assets explicitly.
   Run relocated executables without build-machine `node_modules` on all supported OS/architecture targets. Compare
   full-app startup, memory, binary size, and cold/warm worktree installs. Only then change default tasks, CI,
   installers and contributor documentation and remove Deno tooling. No releases or merges are authorized by this
   continuation.

## Verification for the first slice

- `deno run -A scripts/run-tests.js --isolated src/shared/private-json-file.test.ts` (never direct `deno test`).
- Through the same isolated runner: `file-session-store.test.js`, `file-session-store-owner.test.ts`,
  `file-session-last-plan-review.test.ts` and `file-session-plan-review-rollover.test.ts` in `src/shared/session/`.
- Bun 1.4.3 and Node: run `scripts/check-portable-json.ts`. It invokes the same real-filesystem assertions as the Deno
  test and creates/removes its own temporary directories. It does not open user state.
- Format, lint, type and zero-seam checks; independent Standards, Spec and Tests review.

The filesystem cases assert exact Unicode/JSON bytes, private modes on POSIX, preservation of an old open descriptor
across replacement, unchanged data after serialization failure and surfaced filesystem failures. Tests cannot prove
power-loss durability; the required fsync ordering is also reviewed directly. Windows is unqualified until run there.

## Recovered checkout state and remaining risks

At recovery, main was clean at `58b6ba176`. The migration conversation was idle and its only repository-visible work was
the Bun POC. Separate TypeScript-conversion branches/worktrees exist and are left alone. This continuation uses an
independent local clone based on that main commit, branch `codex/runtime-portable-foundation-oct10`. Process enumeration
was prohibited by the execution sandbox; app-reported idleness does not prove there are no unrelated background jobs.

A text inventory after the first slice found 1,888 `Deno.*` references in 236 non-test-named source files and 523 in 45
non-test-named script files (excluding node_modules and generated .astro directories). These counts include comments and
support fixtures, and are sizing evidence rather than a semantic migration checklist. The runtime replacement remains a
substantial staged project.

No production runtime switch, lock replacement, package-manager switch, release publication or study cohort is part of
this first slice. The POC's Windows/x64 gaps, full application qualification and production cutover remain open.

## First-slice delivery evidence (2026-10-10)

Implemented the portable writer and wired the existing Session storage exports to it. No tests fake the filesystem or
replace owned storage machinery.

- Deno 2.9.7: **40 tests passed** across the five isolated files above (29 Session store, 2 owner, 2 last-plan-review, 1
  plan-review-rollover, 6 portable filesystem). No failures or skips. Run summary and JUnit XML are retained locally
  under `.ci-cache/tests-report/`; the run took 5.34 seconds.
- Bun **1.4.3**: all six shared filesystem cases passed from source.
- Node **26.10.0**: all six shared filesystem cases passed from source. This is fallback compatibility evidence, not a
  claim of qualification against a Node LTS support policy.
- Bun 1.4.3 compiled `scripts/check-portable-json.ts` into a standalone executable. A copy in an unrelated disposable
  directory passed all six cases with a minimal environment and temporary HOME/XDG/database paths. The compiled code
  uses only bundled code and `node:` builtins. This qualifies this storage module on macOS ARM64, not the entire CLI.
- Targeted Deno type and lint checks passed for all five code files. `deno task seams:check` retained the zero-seam
  baseline. Formatting and `git diff --check` passed.
- Independent Review-skill Standards, Spec and Tests passes approved all six original changed files with zero issues and
  zero advisories. Durability ordering was reviewed directly; power-loss and Windows execution remain untested.

At that first checkpoint, the full CI suite was still pending; it subsequently passed as recorded below. Windows/x64
qualification and the complete Bun application build remain pending. This commit is local only; no branch was pushed, PR
opened, release published or merge performed.

## Dependency and test-runner migration slice

Bun now has an exact `1.4.3` runtime pin, `package.json`, `bun.lock`, isolated installs, JSR npm aliases and the root
TypeScript alias configuration. Direct runtime packages retain versions from the existing Deno graph. The three Pi
transitive components (`chord`, `pi-codemode`, `pi-telemetry`) are explicitly kept at 1.0.0 to avoid pulling Pi 1.1
behavior into a runtime migration. Other transitive resolutions are recorded in Bun's own lockfile; the two managers'
lockfile formats are not interchangeable. Bun's package scripts force the selected Bun binary through its Node alias,
avoiding accidental use of an older globally installed Bun.

Install lifecycle scripts remain disabled. The release-age gate remains 86,400 seconds; the current eight Earendil
packages are explicitly exempt, matching the current graph covered by Deno's scope exception. New packages in that scope
must be added to the Bun exception list when the dependency graph changes. Runtime auto-install and implicit `.env`
loading are disabled. Deno retains automatic node_modules mode so existing fresh-checkout CI and release jobs keep
working. During this transition, run `bun install --frozen-lockfile` again before Bun checks after a Deno-managed
install.

`bun run test:bun` uses `scripts/run-bun-tests.ts`: one process and canonical disposable HOME, USERPROFILE, XDG, temp
and database paths per file, including files reusing a worker slot. Only a small operating-system environment allowlist
is inherited; provider keys and user database paths are not forwarded. The preload guard runs before test imports and
rejects direct unsandboxed `bun test`. Successful sandboxes are removed; failed sandboxes and per-file output/run
reports are retained. Per-file deadlines cover imports as well as tests; Bun's `--no-orphans` owns descendant cleanup
and a forced kill follows an ignored termination signal. `WLD_TEST_CONCURRENCY` and `WLD_TEST_FILE_TIMEOUT_MS` accept
positive integers.

This is an incremental test migration. The default Bun list is explicit in `scripts/bun-test-files.json`; it is not a
claim that all Deno tests run under Bun. Files may also be passed explicitly. Node-compatible `node:test` registration
lets the portable filesystem cases run under both runtimes. Runner-specific checks skip under Deno and execute under
Bun. TypeScript checks for migrated code use `tsconfig.bun.json`; Deno's full type checker, lint plugin, custom checks
and suite remain required until their replacements cover the complete tree. `bun run ci:deno` retains the existing
complete gate.

Verification includes clean frozen installation outside the checkout, direct dependency import-map version agreement,
real Pi/MCP/JSR/SQLite imports, retained Session-store tests, and real subprocess tests proving isolation, failure
handling and timeouts. The runner was subsequently qualified on Linux ARM64 as recorded below; Windows execution remains
pending.

References: [Bun configuration](https://bun.com/docs/runtime/bunfig),
[Bun lifecycle policy](https://bun.com/docs/pm/lifecycle), and
[JSR npm compatibility](https://jsr.io/docs/npm-compatibility).

Tooling verification on macOS ARM64: all eleven CI pre-test tasks passed (full source type check, Workspace type check
and build, docs, lint, submodules, skill sync and custom policies). Bun's two migrated test files passed, including
reading retained failure evidence, and the migrated TypeScript gate passed. Independent Standards, Spec and Tests
reviews approved with zero open issues after restoring Deno automatic installation and strengthening the failure
retention assertion. The full source suite is being exercised separately; the first sandboxed attempt could not bind
localhost HTTP fixtures, so the retry uses approved localhost access with the repository's isolated per-file runner.

## Process and environment utility migration

The next slice replaces the external `kill -0` subprocess and Deno hostname call with `node:process` signal-zero and
`node:os` hostname. Invalid or unqueryable PIDs retain the previous false result; foreign-host and unattributable locks
remain conservative. Real child-process tests follow a holder from live to exited without modifying owned lock
machinery.

`getHomeDir()` and `getCwd()` now use lazy Node-compatible environment/cwd access. Source resource paths use `node:path`
and `node:fs`; the existing Deno per-realm test detection remains during transition, with Bun/Node entrypoint detection
and Bun's preload guard providing the new runtime coverage. The process-global test lock retains its process identity,
filesystem exclusion, heartbeat, stale cleanup and synchronous exit cleanup using Node-compatible APIs. Existing lock
concurrency and heartbeat tests now run under both test runners. New environment tests verify post-import HOME/cwd
changes, source resource readability and rejection before an unsandboxed test entrypoint's body runs.

Foreground command spawning and runtime packaging still require separate migration. Remote Linux process-group
termination was subsequently migrated and qualified as recorded below. In particular, Node's asynchronous spawn-error
delivery differs from current synchronous `Deno.Command` callers; this cannot be changed by a mechanical rename without
adjusting the callers and failure tests.

Process utility verification: five Bun test files and the migrated TypeScript gate passed. Deno passed the new liveness,
portable constants and lock tests plus existing constants, Plan doctor and worktree-registry tests. Full Deno type
checking, targeted lint, formatting and the zero-seam check passed. Independent Standards/Spec/Tests reviews approved
with zero open issues after making the HOME/cwd regression test use distinct directories. These utilities are verified
on macOS ARM64; Windows and Linux runtime execution remain qualification work.

## Portable Session manifest readers and recovery

Session Project/manifest reads, directory scans, canonical paths, fingerprints and recovery renames now use `node:fs`
and `node:path`. Missing-path handling checks `ENOENT`; invalid JSON and other filesystem errors retain their existing
propagation. All consumers of the exported readers were audited: external typed NotFound catches in the store apply to
its own Deno stat/remove calls, not the converted readers. Writer exclusion, lock acquisition and activation fencing
remain on the existing Deno implementation.

The unchanged directory-name encoder now has a small portable module, re-exported from its old location. The two
transcript domain types live with the Session-store contracts and are aliased from their previous JSDoc location. The
held-lock resource contract names only its existing release/close operations; this permits type-checking portable
storage without importing the complete Deno application. It does not add a lock factory or injection seam.

Real-filesystem cases cover canonical Project identity, transcript aliases, bounded directory names, missing paths,
invalid JSON, non-directory failures, broken symlinks, cache clone isolation, same-size/same-mtime atomic replacement,
recovery after deletion and preservation of damaged manifest bytes. Bun's selected type gate now covers the complete
storage module and its reachable domain types.

Broader regression evidence: the source run passed 446 files before an image-adapter cancellation assertion failed. That
file passed on an isolated rerun; the 131 skipped files plus two newly added files all passed in a separate run. The
intermittent cancellation failure is retained as qualification evidence, not silently counted as a clean full run. The
original log is `.ci-cache/bun-migration-suite.log`; rerun reports are in `.ci-cache/image-regression-report/` and
`.ci-cache/remaining-suite-report/`. None of these tests invokes a real image provider.

Storage verification: all six selected Bun files and their TypeScript gate passed; eight isolated Deno files covering
portable storage, Session store, owner coordination, reviews/rollover, root sessions and transcript projection passed.
Full Deno type checking, targeted lint, formatting and zero-seam checks passed. Standards, Spec and Tests review
approved after strengthening nested cache clone isolation and pinning legacy long-path encoding against same-basename
roots.

## Compiled storage qualification and activation evidence

The manifest storage assertions are shared between the isolated suite and `scripts/check-portable-json.ts`, alongside
the original atomic-write assertions. The qualification driver executes the same cases under Bun, Node and relocated
compiled executables. Initial ten-case runs passed from Bun/Node source, a relocated macOS ARM64 executable, and a Linux
ARM64 executable inside the existing cached Debian container with networking disabled and a read-only root filesystem.
Only a temporary sandbox was writable; no build-machine node_modules or source tree was mounted.

Activation-baseline and committed-transcript reads now use `node:fs`. Shared cases also check unchanged initial
evidence, changed bytes, missing segments, same-length digest mismatch, appended bytes and missing transcripts. They
preserve the existing idle/uninitialized, reconciliation-required and uncertain recovery distinctions. Actual
writer-lock acquisition still requires the Deno runtime. Windows native locks and complete application packaging remain
unqualified.

The expanded twelve-case driver passed from Node source and compiled executables on macOS ARM64 and Linux ARM64. The
activation baseline test also preserves byte length while changing content, so a length-only digest check cannot pass.
Independent Standards/Spec/Tests reviews approved after this strengthening. The Bun CLI itself remains unported: a
sandboxed `src/cli.ts --help` run stops at the entrypoint's `Deno.args` access. This is a concrete remaining startup
dependency, not a claim that storage qualification makes the application runnable under Bun.

All six migrated Bun test files also passed using the cached Bun 1.4.3 Linux ARM64 runtime in the network-disabled
container. Source and dependencies were mounted read-only; runner sandboxes and reports were isolated writable paths.
The report is `.ci-cache/linux-bun-runner/bun-report-9S56K5/run.json`. Final twelve-case compiled logs are
`.ci-cache/portable-storage-darwin.log` and `.ci-cache/portable-storage-linux.log`.

## Linux-owned process-group cleanup

`terminateOwnedLinuxGroup` now lives in a portable module, re-exported from `foreground-process.ts` for existing
callers. It uses Node-compatible `/proc` reads and process signals while retaining the real detached leader's
PID/completion contract. It checks group membership, ignores zombies, refuses to prove cleanup through permission-denied
`/proc`, and only sends forced group signals while the original leader is still alive. Foreground spawn APIs are
unchanged.

The existing real child/grandchild tests now use portable process creation and execute under Bun on Linux. They verify
graceful cleanup leaves an unrelated child running, and a SIGTERM-resistant group is killed only after its grace period.
The explicit Bun registry and type scope include this module and its tests. macOS skips these Linux-only cases.

Linux verification passed all seven registered Bun files (29 tests), including an additional real exited-leader case
that returns uncertainty and leaves its surviving descendant unsignaled. The forced-cleanup test observes both
SIGTERM-resistant processes alive during the grace window before confirming their eventual exit. Report:
`.ci-cache/linux-bun-runner/bun-report-AxPtbP/run.json`. Deno targeted type/lint and zero-seam checks passed; all three
review axes approved after strengthening the grace-period observation.

## Final verification checkpoint (2026-10-10)

The complete existing `deno task ci` gate passed in **538.5 seconds**: all eleven pre-test tasks and `test:all:suite`,
including the golden TUI portfolio. The isolated runner reports **628 files completed, zero failed, zero skipped
files**. Evidence: `.ci-cache/migration-full-ci.log`, `.ci-cache/ci-timings.json`, and `.ci-cache/tests-report/run.json`
plus per-file JUnit reports. The earlier image-cancellation assertion did not recur in this complete rerun. Full Deno
type checking was rerun after the Linux extraction and passed.

Final Bun type checking passed. All seven registered Bun files passed on macOS ARM64 (26 tests, three Linux-only skips)
and Linux ARM64 (29 tests). Both relocated compiled storage probes passed all twelve assertions. Formatting of all 31
supported changed source/config/doc files and `git diff --check` passed. Independent Standards, Spec and Tests reviews
approved every implementation slice; all six test-review findings were fixed and independently confirmed.

This is a checked local migration checkpoint, not a production Bun cutover. Next work is the native Session/Plan lock
backend (including errno and Windows semantics), foreground spawn startup-error contracts across its callers, the
remaining filesystem/process/HTTP/terminal uses, and complete application packaging. The currently available Mac and
Linux ARM64 container cannot qualify Windows native locks or Windows/x64 runtime execution. Bun CLI startup still fails
on unported entrypoint usage. No further target preference is needed from Carlos, but those acceptance gates must pass
before production runtime/installer changes. Original main and the POC checkout remain preserved; all commits stay in
the isolated migration clone and no push, PR publication, merge, release, credential change or study cohort occurred.

## Native writer locks and foreground processes (2026-10-10)

The Session catalog and operation writer acquisition sites now use `openNativeFileLock`. Deno keeps its native file
locks. Bun on macOS/Linux uses libc `flock` through its built-in FFI, reads errno immediately, retries EINTR, and
separates contention from other failures. Existing private files are never truncated. Closed handles cannot operate on
reused descriptors. Unsupported Bun platforms fail before opening the lock; Windows qualification remains pending.

Six real lock tests pass under Bun on macOS and Linux and through the Deno runner. Existing Session store and owner
files also pass. A production-adapter interoperability probe confirms both Deno-owner/Bun-contender and
Bun-owner/Deno-contender exclusion, then Deno crash release to Bun (`.ci-cache/native-lock-interop.log`). The original
POC remains untouched.

Foreground processes keep their synchronous API and missing-executable classification. Bun native spawn supplies web
output streams and a backpressure-aware stdin wrapper; Deno retains native spawn. Both use the existing owned process
group cancellation contract, including explicit cleanup of descendants after a natural leader exit. Agy/Claude startup
failure classification accepts either runtime's missing-executable error.

The complete migrated Bun suite now contains nine files, passing on both macOS ARM64 and Linux ARM64. Reports:
`.ci-cache/bun-report-7rUzdH/run.json` and `.ci-cache/linux-bun-runner/bun-report-eCp3GC/run.json`. Foreground tests
cover literal arguments, separate streams/status, interactive response before stdin closes, large input through pipe
backpressure, cwd/env, immediate abort, timeout, and late descendant cleanup. Windows-only cases remain skipped. The
seven existing foreground/Agy/Claude Deno files passed; two local-listener fixtures required an approved sandbox
escalation and then passed. The strengthened foreground file passed again. Full Deno type checking and Bun selected type
checking passed. Standards, Spec and Tests axes independently approved after fixes T7/T8 strengthened live stdin and
immediate startup-abort assertions.

This is another implementation checkpoint. Application startup and packaging migration continue; these checks do not
claim the whole Bun CLI or Workspace is ready.

## Bun CLI startup and terminal cleanup (2026-10-10)

Bun now runs source `--help`, `--version`, and the invalid-option path from an unrelated working directory with an
isolated HOME. Startup uses portable argv, helper metadata/namespace handling, agent/theme reads and platform/exit APIs.
Package-helper discovery keeps its real-executable symlink resolution and complete-helper-directory checks. Clipboard
system commands use the migrated foreground process implementation; the installer preserves literal arguments,
environment and POSIX signal-derived exit statuses.

Bun does not dispatch the browser-style fatal events used by Deno. A runtime event adapter now restores terminal state
through `uncaughtExceptionMonitor` and unhandled-rejection handling, then preserves fatal process termination. Real
subprocess tests assert emitted restoration lines and nonzero exit, and verify uninstall removes the handler. Deno keeps
its browser event path. Signals use bound process event methods.

All fourteen migrated Bun files passed on macOS ARM64 (64 passed, five platform skips) and Linux ARM64 (67 passed, two
Windows skips). Reports: `.ci-cache/bun-report-p68wy2/run.json` and
`.ci-cache/linux-bun-runner/bun-report-JlDCYd/run.json`. Source CLI probes exercised bundled definitions outside the
repository cwd and verified help/version did not create `.wld` or `.agents`. Full Deno type checking and the selected
Bun type scope passed. Targeted existing package, agent, theme, TUI, clipboard and update tests passed; the Agent
command fixture needed approved local Unix-socket permission (`.ci-cache/agents-listener-deno.log`). New startup,
crash-event and installer process tests also passed through the Deno runner.

All three review axes approved after independently confirming S2 (installer SIGTERM/SIGINT statuses retained) and T9/T10
(exact restoration marker assertions and exercised helper failure cleanup). Workspace serving and complete application
packaging are the next boundaries. CLI help success is not evidence that all interactive commands work yet.

## Bun Workspace serving and persistent storage (2026-10-10)

The real owner Workspace now serves through a native HTTP adapter, with an Astro Bun server entry and a separate
`dist/workspace-bun` build. The existing Deno adapter/output remain available. Portable filesystem operations cover
owner coordination, settings, root Sessions, remaining file Session reads, Workspace styles and search refresh. SQLite
schema, Session formats, authentication, pairing cookies, CSRF and Host checks retain their existing contracts.

The HTTP adapter preserves streaming, explicit errors, compression and graceful close. Bun abort also force-closes an
open stream after graceful shutdown starts; Deno retains its native behavior. The safe default error response logs
server-side details but returns only `Internal Server Error`. Review S3 caught Bun's unsafe development fallback and
verified its replacement. T11/T12 added bounded active-stream shutdown and exact built-asset/MIME assertions.

All eighteen registered Bun files passed: macOS ARM64 109 tests plus five platform skips, Linux ARM64 112 tests plus two
Windows skips. Reports: `.ci-cache/bun-report-Wpv3Ph/run.json` and
`.ci-cache/linux-bun-runner/bun-report-olhlAp/run.json`. These include 29 existing file Session store cases, seven real
owner database cases, and the actual pairing/authentication/static-asset wire journey. Full Deno source types and the
selected Bun type scope passed. Focused Deno storage/server checks passed after correcting the Node ENOENT expectation
and using a real node:http client for an explicitly overridden Host. Standards, Spec and Tests reviewers all approved.
The complete Deno CI gate is running separately (`.ci-cache/workspace-full-ci.log`).

A disposable standalone packaging probe now runs actual CLI help and serves the pairing page from an unrelated working
directory with embedded resources; SIGTERM exits zero. Bun's asset-directory embedding keeps only the supplied root
directory name, so a staging tree preserves the application resource paths. This probe is not yet the repeatable build
or evidence of complete interactive/remote command migration. Native Plan/controller locks, remaining runtime APIs,
worker/WASM packaging and platform qualification still need completion. No release or production cutover occurred.

## Standalone Bun development packages and document readers (2026-10-10)

`bun run ci:bun` now builds the Bun Workspace, checks the migrated source graph, and runs the isolated Bun suite.
`bun run compile:bun .ci-cache/wld-bun` builds a development executable; `bun run check:package:bun .ci-cache/wld-bun`
qualifies it. The Bun builder stages only approved passive resources, collapses Astro's renderer, embeds the real Pi
image worker and Photon WASM, disables ambient dotenv/Bun configuration loading, and writes checksummed build metadata.
It reuses the existing version policy through portable build helpers. Deno release and installer tooling stay in place.

Bun's compiler substitutes the external Photon loader boundary with the real npm module as an ESM import, avoiding Bun's
interpretation of passive CommonJS assets. The packaged image check explicitly starts the embedded worker before
checking Pi resize and JPEG/WebP conversion, so fallback execution cannot hide a missing worker.

Build identity includes Bun's compiler version, lock/package inputs, source identity and a deterministic manifest of
**every staged path and its content hash**, including generated browser CSS/JS and renderer/WASM outputs. Review S4
caught the omitted client-asset contribution. A real two-build probe changed only a same-path CSS asset, proved the
renderer unchanged, observed different build IDs, and restored the original bytes
(`.ci-cache/bun-payload-identity-check.log`). macOS and Linux outputs from unchanged inputs have the same build ID and
different executable checksums.

The standalone qualifier copies the executable into a disposable HOME/cwd. On macOS its children run under a filesystem
sandbox denying reads from the complete checkout, including node_modules. Linux qualification mounts only the compiled
binary/metadata, bundled verifier and expected public asset bytes into a restricted disposable container: no checkout or
dependency tree is mounted. Both passed actual CLI help/version, worker/WASM, image conversion, Workspace pairing page,
exact referenced JS/CSS bytes and MIME types, unauthenticated rejection, generic error response and SIGTERM shutdown.
Deliberately conflicting `.env` and Bun preload files in the working directory did not affect execution. This addresses
review T13. Logs: `.ci-cache/bun-development-package-check.log` and `.ci-cache/bun-linux-package-check.log`.

Markdown/image document readers now use portable filesystem and HTTP APIs. All thirteen existing document-host cases run
under both runtimes, preserving current-file reads, token revocation, canonical path and symlink containment, image
upload restrictions and listener disposal. The complete migrated Bun suite passes nineteen files: macOS 122 cases with
five platform skips; Linux 125 cases with two Windows skips. Reports: `.ci-cache/bun-report-udVuAQ/run.json` and
`.ci-cache/linux-bun-runner/bun-report-1rEn6n/run.json`. All three independent review axes approved the implementation.

The first complete Deno regression attempt passed 631 files and found three failures. Remote artifact errors and
review-document errors still expected Deno error classes after their filesystem dependencies moved to Node. The affected
callers and review file/image handlers now classify Node errors correctly, and focused tests passed. The complete Deno
CI rerun passed all 634 files in 736.9 seconds (`.ci-cache/packaging-full-ci.log`). Full source types, selected Bun
types, formatting, lint and the zero-seam gate passed.

These are qualified development packages for the exercised journeys, not a production runtime cutover. Remaining major
boundaries are native Plan/controller and project-layout locks, Plan persistence, normal interactive agent execution,
remote runtime/SFTP/supervisor paths, and Windows/x64 qualification. The lexical inventory records 184 production files
with 1,168 Deno references (including compatibility backends and fixture helpers), so help/pairing/package success must
not be read as complete command coverage. The next implementation should start at `project-runtime-layout.ts`,
`plan-store.js`, `lock-file-snapshot.ts`, `controller-registry.ts` and their real contention/recovery tests. No
publication, merge, release, installation, credential change or study cohort occurred.

## Portable Plan and project runtime persistence (2026-10-10)

Plan storage, project layout/recovery, controller registry and Git evidence now use portable filesystem and captured
process APIs. Native lock descriptors preserve inode identity, async contention, full durable writes and snapshots.
Existing recovery archives, no-overwrite Plan creation and controller revisions remain enforced. The catalog contention
test proves ID backfill waits for the writer before changing bytes; returning-controller tests preserve decisions and
source backups. Review S5 corrected a Node EEXIST consumer; T14 strengthened the real contention assertion. All three
review axes approved.

The complete Deno CI gate passed 635 files in 629.3 seconds (`.ci-cache/plan-port-full-ci.log`). The integrated Bun gate
passed all 24 registered files on macOS (141 tests, five platform skips), and Linux passed 144 tests with two skips
(`.ci-cache/plan-port-ci-bun.log`, `.ci-cache/linux-plan-port-suite.log`). Both standalone packages also execute the
actual `plans` command from disposable HOME/cwd, alongside the previous image/Workspace qualification; Linux again
passed in a minimal container without the checkout (`.ci-cache/plan-package-check.log`,
`.ci-cache/plan-linux-package-check-minimal.log`).

The next slice targets interactive onboarding, Session activation, provider turns and durable resume. Remote transport,
supervisor and broader workflow paths, full Bun type coverage, Windows and x64 remain unqualified.

## Bun Session activation, durable resume and onboarding (2026-10-10)

Session activation, prompt/skill resources, model configuration, mounted personal resources, transcript projection, MCP
configuration and CLI shutdown now use portable runtime APIs. Credential-file modes, resource root identity and symlink
guards, transcript prefix validation/fsync, and Unix socket permissions retain their contracts. No real user credentials
were read or changed by qualification; every provider fixture has a disposable HOME.

The managed Session test completes a scripted provider turn, closes the Session, reopens from disk and completes a
continuation. Review T15 strengthened it to verify saved user and assistant content at the resumed provider boundary.
The actual source CLI opens setup, accepts cancellation and restores the terminal. All three review axes approved.

Integrated Bun checks pass 30 files on macOS (160 tests, five skips); Linux passes 163 tests with two skips
(`.ci-cache/startup-ci-bun.log`, `.ci-cache/linux-startup-suite.log`). Both relocated development executables pass the
previous qualification plus actual onboarding/cancellation, with checkout access denied or absent
(`.ci-cache/startup-package-check.log`, `.ci-cache/startup-linux-package-check.log`). The full Deno gate passed all 637
files in 605.8 seconds (`.ci-cache/startup-full-ci.log`), including types, lint, formatting and zero seams.

A separate macOS compiled-CLI probe completed a real HTTP-provider turn against a local scripted endpoint and exited
zero through `/quit`. It also exposed three helper-extension Deno references hidden inside terminal-formatted warning
output. Those warnings are assigned to the next Agent-tool/extension slice; this checkpoint does not claim clean
complete interactive coverage. The probe is `.ci-cache/probe-compiled-provider.py`, with output in
`.ci-cache/compiled-provider-probe.log`. Remote/SFTP/supervisor paths, remaining workflow APIs, full Bun type coverage
and Windows/x64 qualification remain.

## Bun Agent tools, extensions and real compiled provider turns (2026-10-10)

Read, grep, multi-file edits, Plan-safe file writes, Plan/artifact notification tools, image attachments and image reads
now use portable filesystem APIs. Delegation's Git capture uses the owned native subprocess adapter. Existing Plan
locks/revisions, artifact containment and edit rollback remain intact. This does not yet port every delegated Session or
execution-workflow dependency.

The actual compiled CLI provider probe exposed three startup warnings from helper-extension `Deno.cwd()` calls. Cymbal,
Mnemoteca and Ketch now resolve cwd lazily through `getCwd()`; re-anchor uses a portable synchronous Plan read. Existing
extension/tool tests run under Bun. A managed provider test confirms memory/code-search declarations and a real
read-tool result containing random fixture bytes. Plan-tool tests exercise nested creation, overwrite refusal, exact
edit and stale-text rejection. Review T16 strengthened successful edit assertions to exact complete-document bytes. All
three review axes approved.

All 44 Bun files pass: macOS ARM64 256 tests with five platform skips, Linux ARM64 259 tests with two skips
(`.ci-cache/tools-ci-bun.log`, `.ci-cache/linux-tools-suite.log`). Linux's first attempt lacked ripgrep in the cached
test image; mounting the official ripgrep 15.1.0 ARM64 binary read-only fixed the test prerequisite. The archive SHA-256
is `2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e`. No user tool installation occurred. The complete
Deno regression passed all 639 files in 616.9 seconds (`.ci-cache/tools-full-ci.log`).

`bun run check:provider:bun <executable>` now qualifies a relocated compiled CLI against a local HTTP provider using
synthetic credentials and strict helper fixtures in disposable HOME/cwd. It checks the prompt, streamed answer, helper
declarations, absence of extension warnings, actual `/quit` submission while the CLI is still alive, and terminal
restoration. Review T17 prevents premature successful exit from passing as `/quit`. This qualifier passed on macOS with
checkout reads denied and minimal Linux with no checkout/dependency tree mounted
(`.ci-cache/provider-qualifier-macos.log`, `.ci-cache/provider-qualifier-linux.log`). The original package qualifier
also passes on both platforms. The provider qualifier, command registration and type-scope addition were added after the
full gate started; full source types, Bun types, lint and the zero-seam gate were rerun successfully for that final
addition.

Implementation remaining: delegated/named invocations and background task persistence; execution Plan/worktree/recovery
and Work Record paths; remote SFTP/supervisor and external CLI/MCP bridges; remaining command-specific runtime APIs.
Start the next local workflow slice at `subagent-definitions.ts`, `named-invocation.ts`, `background-tasks.ts`,
`execution-plan-file.js` and `worktree-project-context.ts`. Verification remaining: the rest of the suite under Bun,
full Bun type coverage, and Windows/x64 qualification. A lexical inventory, excluding test/fixture files but including
comments and compatibility code, still finds 132 runtime source files with 731 Deno references
(`.ci-cache/remaining-deno-inventory.json`); this is not a completion percentage. Deno remains the release/default lane.
No new architectural decision needs the owner's input, and no merge, publication, release or study cohort occurred.

## Delegation, background work and worktree recovery (2026-10-10)

The next slice ports delegated Agent definitions, named invocations, background log persistence, Session artifact and
transcript reads, model presets, worktree context transfer, Git safety/snapshots, execution Plan recovery, and Work
Record storage/indexing/supersession locks. It preserves real Git fixtures, source-checkout isolation, Plan conflict and
symlink guards, exact transcript evidence, partial-write accounting and late background-result cancellation.

Eighteen delegated/background files passed under Bun (`.ci-cache/delegation-bun-third.log`). Further worktree, recovery
and Work Record regressions are now registered in the Bun runner. Work Record rollback fault tests still exercise the
external filesystem rename boundary, now through Node's filesystem API. Search hydration uses an external index fixture
that removes canonical files after the initial scan, proving hydration uses that saved scan without replacing owned
code. All three review axes approved. S6 added portable ENOENT handling at publication cleanup's caller boundary; T18
strengthened the existing-file symlink fixture; T19 made the Linux cancellation assertion distinguish terminated zombies
from live descendants without accepting filesystem errors as proof of termination.

The complete Deno run passed 638 of 639 files in 702.7 seconds; the publication golden journey had loaded before the S6
cleanup fix and timed out with its worktree retained (`.ci-cache/delegation-full-ci.log`). That journey passes with the
final fix in 20.7 seconds (`.ci-cache/delegation-golden-retry.log`), as do three targeted publication/recovery files
(`.ci-cache/s6-deno.log`). Full source types pass (`.ci-cache/delegation-final-types.log`). The macOS Bun build, scoped
types and all 73 registered test files pass (`.ci-cache/delegation-ci-bun.log`). Linux initially passed 72 files and
exposed the cancellation assertion's zombie assumption. All 73 files pass after its correction
(`.ci-cache/linux-delegation-suite-final.log`); the final assertion also passes Deno
(`.ci-cache/delegation-process-final.log`).

An exploratory expansion of Bun type coverage exposed 653 diagnostic output lines across the remaining runtime graph and
upstream declarations (`.ci-cache/worktree-bun-types.log`). The qualified type gate remains scoped to the already
portable foundation while those files are migrated; this exploratory failure is not a passing full Bun type check.
Remaining source migration includes remote transports, external CLI/MCP bridges and command-specific dependencies.

## Remote transport and external CLI adapters (implemented, 2026-10-10)

This slice replaces Deno-only remote socket/process/filesystem use with paused Node sockets, bounded reads and the owned
native process adapter. Private headers must not consume pipelined SFTP or terminal bytes; existing authentication,
remote identity/checksum validation, mount ownership and Linux process-group cleanup remain authoritative. Bun Linux
artifact metadata maps to the existing architecture-specific remote cache protocol only after architecture validation.
The release/default lane remains Deno. Real SSHFS/FUSE supervision still requires an eligible Linux host.

Claude and Antigravity helpers now use portable private files, native locks and the existing HTTP adapter. MCP stdio
runs under the active runtime. Helper cancellation stops its owned process and keeps the established missing-command
result. Tests use real loopback transports and subprocess fixtures with isolated HOME. No real personal setup or
credentials are changed. New socket tests exercise one-byte input, bounded headers, remaining pipelined bytes and
listener closure; the SFTP authentication test now pipelines the first protocol packet with its credential.

The first Bun subset passed 12 of 13 files; the remote cache fixture needed its copied metadata helper linked back to
its real dependency resolution root. Full source type checking and all Deno CI pre-test gates pass. The complete Deno
suite passed 639 of 641 files in 678.9 seconds (`.ci-cache/remote-full-ci.log`); two copied-source fixtures lacked newly
imported dependencies. Both pass with their dependency lists repaired (`.ci-cache/remote-fixtures-deno.log`, 5.2
seconds). The final macOS workspace build, scoped Bun type gate and all 103 registered test files pass
(`.ci-cache/remote-ci-bun-final.log`). Linux also passes all 103 registered files (`.ci-cache/linux-remote-suite.log`);
the subsequent fixture dependency-list additions were checked under Deno and macOS Bun. All three independent axes
approve, including those fixture corrections. Tests review T20 strengthened helper cancellation to prove the child was
alive before cancellation and absent afterward, with a deadline well before its natural exit. This is not a completed
cutover claim.

## Remaining application runtime and broader qualification (in progress, 2026-10-10)

The next slice ports remaining production command, workflow and UI filesystem/process/terminal paths to the portable
adapters and Node APIs. This includes ACP stdin, guided-review subprocesses, clipboard operations, validation capture,
Git batch input, image output staging and recovery journals. Existing HOME/cwd access stays lazy and fixture mutation
stays serialized. The packaged image smoke check now uses the compiled-runtime identity detector to require Bun's
embedded image worker explicitly. Deno remains the default release lane.

The Bun type gate now includes the production application graph, preserving the previously checked foundation/tests. SDK
aliases use their shipped declarations for type checking; the runtime alias map remains unchanged. The pinned
proper-lockfile declaration package is recorded in both lockfiles. Third-party declaration checking is skipped because
the installed Bun/Node/Astro declarations conflict; application source checking remains strict. Existing JSDoc modules
now export their types explicitly; stale UI fixture values now use the actual runtime event contract.

The isolated Bun registry first expanded from 103 to 255 files. The initial run passed 227; shared fixtures still used
Deno APIs. After porting those fixtures, all 255 pass under macOS and Linux ARM64
(`.ci-cache/application-ci-bun-second.log`, `.ci-cache/linux-application-suite.log`). The macOS run also passes the
Workspace build and expanded Bun type gate. The complete Deno source/test type check and lint pass.

Independent review found and confirmed fixes for three regressions: S-APP-1/S7 moved opening a missing Plan-lock
directory inside Doctor's ENOENT handler; S8 preserves the prior foundation/test type roots with explicit `files`; S9
preserves Deno's native cancellable stdin behind the portable ACP adapter because its Node stdin cannot release a
pending read. New actual-process ACP regressions reproduced the Deno shutdown failure before the fix and pass afterward
for SIGINT and SIGTERM while client stdin remains open (`.ci-cache/acp-shutdown-deno-fixed.log`). Doctor's new
real-directory regression and existing tests pass (`.ci-cache/doctor-repair-deno.log`). All three axes approve the final
changes. These regressions bring the Bun registry to 257 files. The final macOS Workspace build, expanded types and all
257 files pass (`.ci-cache/application-ci-bun-final.log`). Full Deno CI passed 639 of 641 selected files in 762.6
seconds (`.ci-cache/application-full-ci.log`); two filesystem-observation tests required their production callers to use
the same default Node filesystem boundary patched by the fixtures. Both pass after that correction
(`.ci-cache/application-fs-observation-deno.log`, 11.7 seconds). The two newly added Doctor/ACP files pass separately as
recorded above. All three reviewers approved the filesystem correction. Final source types, lint and the zero-seam gate
pass. Linux's final 257-file run and rebuilt standalone qualification are pending. No cutover or all-platform
qualification is claimed.

## Application package checkpoint and test expansion (2026-10-10)

Application commit `4131b046a` passes all 257 registered Bun files on macOS and Linux ARM64
(`.ci-cache/application-ci-bun-final.log`, `.ci-cache/linux-application-final-suite.log`). Its rebuilt development
executables both pass relocated package and local-provider qualification with isolated HOME, checkout/dependency reads
unavailable, embedded image worker/WASM, Workspace asset/auth checks, onboarding/cancel, provider streaming and normal
`/quit` terminal restoration (`.ci-cache/application-{macos,linux}-{package,provider}-check.log`). Both artifacts have
build identity `b35b1099e469794d44581b989e6e2defa4d7b5a28792c47f327ae0ed8a634f6f`. The macOS SHA-256 is
`874a1997b4c5387ac5e4d8483474c0d5d62578e416259c6c8c85b51e46a1b9fb`; Linux is
`338f402a5867c5d277cacc0657c00eb66d428130a48f6d21fd211060fb43ced9`. No package was published.

The next test-only slice migrates 174 filesystem/environment-based regression files and their MCP fixture, taking the
Bun registry to 431 files. The first selected run passes 170/174; corrected runtime eval/run arguments, the active
Workspace build directory, portable MCP fixture APIs and Node-compatible fake timers make all four failures pass on
retry (`.ci-cache/next-fs-two-fixes.log`, `.ci-cache/next-fs-mcp-clock-fixes.log`). Fake timers still advance both Date
and timeout callbacks past the removed five-minute expiry; they retain Node timer handles needed by real HTTP sockets.
All three independent review axes approve. S10/T21 corrected artifact-route coverage to require HTTP 200 when the active
runtime's Workspace build exists. The shared MCP fixture now records one shutdown event on EOF or SIGINT/SIGTERM under
both runtimes, independently verified by Spec review. The complete Deno CI gate passes in 990.8 seconds
(`.ci-cache/next-fs-full-ci-second.log`), including all pre-test checks and the full regression suite. Final integrated
Bun runs are pending. Remaining cutover gates include the rest of the tests/golden TUI runners, equivalent Bun-only
tooling coverage, full-app/install benchmarks, Windows native-lock and packaging implementation, Windows/x64 execution
and real SSHFS/FUSE qualification. The Bun lock adapter currently supports only macOS/Linux; Deno's existing Windows
backend is preserved. Deno remains the default release runtime.

Preliminary macOS CLI-only timing for the qualified application binary: seven warm runs have median `--version` 291.6 ms
/ 72.0 MiB peak RSS and `--help` 385.8 ms / 105.9 MiB peak RSS; executable size is 147.4 MiB
(`.ci-cache/application-bun-startup-benchmark.json`). These samples were collected while CI was active, with no OS cache
flush or Deno comparison. They do not satisfy the full application or cold/warm worktree-install benchmark gate.

## Browser test parity (2026-10-10)

The next slice ports 13 UI regression files, preserving every browser interaction and assertion, and takes the Bun
registry from 431 to 444 files without removals. Two tests import real esbuild output from a unique temporary `.mjs`
file via `src/testing/import-test-bundle.ts`; Bun lost the component exports when the same bundles were imported through
data URLs. Explicit ESM loading preserves resolved shared React imports and removes its temporary directory in
`finally`. No production components or runtime behavior change in this slice.

All 13 pass under both runtimes in the disposable proposal, and Deno passes all 13 again in the actual checkout in 6.4
seconds (`.ci-cache/ui-final-deno.log`). Full source types, lint and the zero-seam check pass
(`.ci-cache/ui-final-{types,lint,seams}.log`). All three reviewers approve the final applied files and exact 431→444
registry expansion. The complete macOS Bun gate passes: Workspace build, production types and all 444 files
(`.ci-cache/expanded-444-macos-ci.log`). Linux browser tests use the lockfile-pinned
`@esbuild/linux-arm64@0.28.2` from the existing Deno cache (binary SHA-256
`90bd269553d258e80b19e3ccab4f98f0831f87442a2f056510ce24fd1b425fc2`) and a disposable writable copy of build assets. This
exercises Linux runtime behavior but does not claim a clean native Linux Bun install.

The first Linux 444-file run passed 415 files, then exposed exhausted temporary-memory storage and two Claude test
launchers still hardcoding Deno. Both launchers now use the active executable, runtime-specific flags, decoded file
URLs and literal POSIX argument quoting. The shared fake Claude client was already portable. Both corrected files pass
under macOS Bun and Deno (`.ci-cache/claude-active-runtime-{bun,deno}.log`; Deno 5.9 seconds). Linux passes both files
plus the two background-operation cases that failed after storage exhaustion
(`.ci-cache/linux-capacity-claude-targeted.log`, 4/4). No assertions were removed or weakened. All three reviewers
approve the launcher correction; full source types and lint pass again. The complete Linux rerun passes all 444 files
(`.ci-cache/expanded-444-linux-final.log`, report `.ci-cache/linux-bun-runner/bun-report-Rj50LX`) using a task-specific,
disk-backed volume with disposable per-file homes. That volume is removed after verification. The last full Deno CI
checkpoint passed 643/643 files before this browser slice; the 13 browser files and final two fixture corrections pass
separately under Deno afterward. No full-suite Deno rerun after those test-only edits is claimed. MacOS passed the full
444-file gate before the final two fixture corrections, then both corrected files passed separately. The final Linux
444-file run includes those corrections. Standalone application packages remain the qualified `4131b046a` builds;
subsequent changes affect tests, fixtures and this plan. The original main checkout remains clean at `58b6ba176`;
all implementation is on the isolated local migration branch. No push, PR, merge or release occurred.

### Remaining source and golden harnesses

All 158 previously unregistered source files now use the isolated active-runtime test path. The golden harness's
47 files pass under Bun, including process-global isolation, child completion framing, rendered terminal snapshots,
and the planned tutorial/non-Git validation commands. Additional subprocess fixtures now use the active executable,
explicit dependency roots, literal shell quoting, and portable filesystem/process APIs. Deno permission-scoped Plan
checks retain their original permissions; the Codex-discovery test uses a real macOS sandbox under Bun instead of
silently discarding its denial of host application access. No test cases or assertions were removed.

The migration exposed a native SQLite closure defect in Bun 1.4.3's `node:sqlite` compatibility layer: statements
kept the native connection alive after close, and deleting/recreating the database could fail with
`SQLITE_IOERR_SHORT_READ`. An independent descriptor audit and unchanged Session reconstruction test confirmed it.
The shared SQLite boundary now uses native `bun:sqlite` with explicit `close(true)` on Bun and retains `node:sqlite`
on Deno. It normalizes absent rows and direct-statement change counts (Bun includes cascade effects in its raw count).
New close/recreate, read-only, binding and cascade regressions supplement the existing Session and Workspace storage
cases. The focused corrected SQLite slice passes (`.ci-cache/sqlite-changes-qualification.log`); the unchanged
13 Session tests pass with the native close fix.

Browser-question completion also exposed a shutdown race: Bun force-aborted the answer socket before delivery.
Accepted answers now drain with a one-second limit under Bun; cancellation/error cleanup remains forced. Deno keeps
its native abort behavior, avoiding its invalid graceful-shutdown-to-abort transition. Independent probes verified
complete 85 KB responses, canceled unfinished uploads, and bounded draining on both runtimes. A maintained child-process
regression passes under Bun (`.ci-cache/browser-question-bun.log`).

The expanded macOS Bun build/type/test gate passed 602/603 files
(`.ci-cache/expanded-603-bun-ci.log`, report `.ci-cache/bun-report-guQl7V`). Its sole failure was the terminal-auth
mutation fixture's external dependency root; the corrected test passes all ten cases
(`.ci-cache/terminal-auth-bun-final.log`). The registry now has 604 files including the additional shutdown regression.
Full Deno CI completed 645 files: 641 passed and four exposed fixture regressions. The Plan tests now preserve their
filesystem-only Deno permission scope through the native temporary-directory operation; Workspace subprocess capture
passes only supported options. The compiled Agy proxy owns and drains its three pipes and forwards termination, fixing
an inherited-pipe orphan under Deno. That investigation also exposed a real MCP bridge lifecycle gap: stdin EOF now
closes the upstream HTTP/SSE transport. A real-process regression initializes the bridge, closes stdin, drains output,
and requires natural exit 0, so host timeout termination cannot pass.

The three fixture corrections pass in `.ci-cache/source-deno-fixes.log`; that focused run's obsolete Agy case was
explicitly stopped after reproducing the old proxy hang. The final Agy proxy passes all 32 cases in 35.2 seconds
(`.ci-cache/agy-owned-pipes-deno.log`), and the maintained EOF regression passes under Deno
(`.ci-cache/stdio-eof-deno.log`). The final seven-file source correction slice passes under Bun
(`.ci-cache/source-final-fixes-bun.log`, report `.ci-cache/bun-report-4SJtOZ`). Thus all 645 Deno files and all 604 Bun
files have passing coverage collectively, but a final integrated rerun is not yet claimed. Full source types and lint
pass again, and the zero-seam baseline is retained. Independent Spec, Standards and Tests review approve the original
slice and these final corrections with no remaining findings.

A fresh native Linux ARM64 install into a disposable volume with empty cache/node_modules installed the then-locked
827-package graph in 140.40 seconds with lifecycle scripts disabled (`.ci-cache/native-linux-clean-install.log`).
This proves native installation rather than reuse of the macOS dependency graph. The subsequently explicit Prettier
test dependency and final toolchain graph will be reinstalled before final native qualification. Standalone packages
still require rebuilding after the application SQLite and shutdown changes. Bun-only development-check parity,
remaining script tests, comparative application/install benchmarks, and final-head packages remain in progress.

## Complete test inventory and portable development tooling (2026-10-10)

The Bun registry now includes all 648 test files, adding the 42 script suites and two maintained regressions for native
process completion and lint parity. The shared scheduler handles the normal Bun CI test task, preserving isolated HOME,
fail-fast scheduling, timing history, shards, reports and retained golden failure evidence. The configured task's real
fail-fast regression requires the first fixture to execute and the later fixture to remain unexecuted. Interactive
installer tests use Bun's native PTY; docs tests build real frozen dependency copies inside their fixtures.

The Bun development gate now includes the same eleven pre-test task categories as Deno. Its source type checker covers
1,295 production/test entries; the separate Astro checks still cover Workspace and docs. ESLint/TypeScript-ESLint plus
the existing owned-process-state plugin and explicit parity rules cover the 87 recommended Deno lint rules. Regression
cases cover scoped ignores, unused arguments/catches, imports, deprecated APIs, JSX buttons and window globals. The final
focused lint regression passes, and the full Bun lint reports zero diagnostics across 1,429 files. Deno's lint gate
remains unchanged; explicit switch guards retain its conservative no-fallthrough behavior with narrow ESLint annotations.
Independent Spec, Standards and Tests review approved after correcting findings T22–T26 and S12–S13.

The first integrated 648-file Bun run passed 646 files. Both docs failures involved mixed package-manager links during
a run overlapping Deno lint probes; the exact operation that rewrote the links was not established. Restoring the
frozen Bun graph makes both complete real-build suites pass
(`.ci-cache/bun-docs-integrated-repro.log`). Deno can retain Bun workspace links when switching back; moving aside the
generated docs dependency directory makes its 22-page build and route verification pass
(`.ci-cache/deno-docs-clean-graph.log`). Runtime checks must use separate checkouts or serialized graph preparation.
The earlier 646-file run exposed two timing-sensitive golden fixtures: input now waits for actual terminal restart,
and the publication journey resizes before asserting the complete report. All original workflow/publication assertions
remain. The subsequent integrated run passes both golden files.

The current complete lockfile also installs natively on Linux ARM64 from empty cache and node_modules: 1,105 packages
in 137.91 seconds, frozen and with lifecycle scripts disabled (`.ci-cache/toolchain-linux-clean-install.log`). This was
concurrent with host CI, so it establishes clean-install correctness rather than comparative performance. Final integrated
macOS/Deno/Linux runs, comparative benchmarks and rebuilt standalone packages are still being completed. Deno remains
the release/default lane; Windows/x64 and genuine SSHFS/FUSE qualification remain required before distribution cutover.

The integrated Deno check exposed shared-workspace link contention between docs Astro 7.3.3 and Workspace Astro 7.3.5.
Docs therefore retains its original independent Deno root and now has its own Bun lock/config as well. The root Bun
manifest does not declare a shared docs workspace. `bun run install:locked` installs both frozen graphs; all package
versions in the separated Bun locks were already present in the prior lock. Fixture builds copy the docs-local frozen
store. A fresh Deno dependency tree passes every pre-test gate after this correction; its full suite is in progress.
Manager switching must replace both generated dependency directories or use separate checkouts, because cached install
metadata can retain stale links. No formatter-wide rewrite or production distribution switch is included.

## Native Windows qualification and draft publication (2026-10-11, in progress)

The verified portable foundation and Linux supervisor follow-up are consolidated on
`codex/bun-runtime-migration`. The owner authorized a draft PR and Windows CI; Deno remains
the production release/default lane. Release tags, publishing workflows, credentials and
local VM provisioning are outside this change.

The Linux follow-up closes the real SSHFS/FUSE gap on the existing non-root ARM64 VM:
eight SFTP cases and seven supervisor cases passed, including stalled transport, launcher
death, silent control and descendant cleanup. Losing deadline timers are cancelled after
cleanup settles; the launcher-death fixture scopes Bun's orphan-guardian override to its
owned process tree. The new deadline regression fails against the earlier implementation.
Both macOS runtimes and Linux Bun passed the 26 affected test files. The original full
647-file foundation qualification remains separate from those follow-up checks.

Windows implementation adds Win32 handle-backed locking with `LockFileEx`, shared/exclusive
ownership, descriptor-safe metadata I/O, durable flush and mapped filesystem errors.
The existing lock tests now assert Windows mandatory-read exclusion explicitly, preserve
POSIX advisory-read behavior, and use Unicode lock paths. Bun's development compiler
accepts Windows x64 and ARM64 targets. Relocated package/provider checks use native helper
fixtures and Windows executable/environment conventions. Windows process termination is
verified separately from interactive `/quit`, since Win32 termination is not POSIX SIGTERM.

The new read-only-token CI workflow uses only standard `windows-2025` and `windows-11-arm`
public-repository runners, pinned Bun 1.4.3, separate frozen dependency graphs, bounded jobs,
the complete isolated Bun inventory and relocated executable/provider qualification.
Native Windows execution remains pending until those jobs pass; no skipped or failed case
is evidence of qualification. Source types/lint and macOS lock regression pass locally.

### Windows package checkpoint and source corrections

Draft PR #235 consolidates the foundation and Linux follow-up. At `65e313d92`, native Windows
run [38104934570](https://github.com/gandazgul/runwield/actions/runs/38104934570) completed the
x64 package job successfully: 22/22 focused files, native compilation, relocated CLI/Workspace,
provider streaming and terminal restoration. ARM64 passed 21/22 focused files and both package
checks; its remaining legacy-validation file reached the 120-second file limit while six cases
had passed and another was running. This is incomplete qualification, not a passing file.
The ordinary PR gate passed at that checkpoint.

The native runs verified Bun/Deno lock interoperability, crash release, descendant termination,
ConPTY interaction and private JSON replacement with an old reader still open. Bun and Node's
ordinary Windows rename both returned EPERM for that reader case; RunWield now uses the native
FileRenameInfoEx replacement semantics already used by the production Deno/Rust path. The
existing six atomic JSON cases pass on both architectures. Windows docs fixtures rebuild
junctions into their copied frozen dependency store and safely reuse them on repeated builds.

The longer source run identified additional application defects: Git CRLF checkout conversion
was mistaken for post-validation Work Record edits, Windows mandatory lock reads needed to
block migration as active writers, and Agy setup did not recognize installed `wld.exe` binaries.
The fixes preserve Git's configured content filters, reject actual later edits, retain unreadable
held locks without manufacturing stale-lock snapshots, and recognize Windows executable names.
Remote sentinel containment and architecture-policy checks now handle native path separators.

Executable test fixtures now compile native Windows helpers instead of relying on shebang
execution. Tests retain real Git, process and lifecycle behavior; no owned-code seam is added.
POSIX mode/FIFO-specific checks are explicitly platform-scoped and do not establish Windows ACL
privacy. Four disjoint source shards per architecture retain all 649 inventory files, with the
normal bounded ten-minute file allowance, forty-minute source steps and sixty-minute jobs.
No native source-suite pass is claimed before all shards complete.

Local verification of these source corrections: 16 affected Deno files pass in the separate
Deno graph; focused Bun publication, runtime migration, Agy, policy, path and remote-proof suites
pass; source types cover 1,303 entries and lint covers 1,437 files with zero diagnostics. The
new CRLF publication cases reproduce the failure before the fix and pass afterward, including
retry and preservation of later user edits. Independent Spec and Standards review is performed
before the correction batch is pushed. Deno remains the production/default release lane.

### Native source fixture and transport follow-up

At `ce9105004`, Windows x64 again passed the complete package lane. ARM64 passed all 22
focused files, Bun/Deno native-lock interoperability, relocated package checks, and the
HTTP-provider/terminal-restoration exercise. Its job failed during final temporary-directory
removal with EBUSY; bounded explicit cleanup retries now cover the transient executable mapping.
The eight complete source shards are still running, so full Windows source qualification is pending.

The next reviewed batch preserves mandatory-lock contention semantics in Plan and Work Record
stores, restores Deno's Windows treatment of unavailable POSIX mode metadata for MCP configs,
and ports Claude/Mnemoteca fixtures, shell commands, and filesystem expectations. A linked
checkout fixture now leaves its current directory before replacing it. Windows update coverage
explicitly checks the existing package-manager/release guidance; Unix installer and Homebrew
fixture cases remain POSIX-scoped. No test cases were deleted; one Windows update case was added.
All 21 affected files passed Bun on macOS and Deno in separate frozen dependency checkouts.
The type gate checks 1,303 entries and lint checks 1,437 files. Spec and standards reviewers
approved all 24 code/test paths after correcting two remaining Windows assertions.

Remaining remote qualification is concrete: Linux remote-host integration fixtures use POSIX
Python and filesystem primitives, while Windows laptop SFTP discovery and transmitted path
spelling need native implementation and real file-access coverage. ADR-018's exclusion of Windows
remote hosts does not exclude Windows laptops. A skipped Linux-host fixture cannot establish
Windows laptop support, and no full-platform completion is claimed.

Windows laptop SFTP now discovers native OpenSSH servers and advertises the server's canonical
`/C:/...` drive paths, with explicit POSIX operations on the receiver. Local UNC roots fail
explicitly pending qualification. CI extracts checksum-pinned x64/ARM64 OpenSSH binaries without
installing a service or changing firewall rules. A new authenticated transport test reads actual
Unicode-named file bytes at the advertised path; a wrong-path mutation fails that test. macOS
Bun and Deno pass the transport file (seven active cases, two existing Linux kernel-mount cases
skipped). Types and lint pass, and independent spec/standards review has no findings. Native
Windows file access and the full source inventory remain pending.

The complete x64 source baseline at `ce9105004` ran 649 unique files: 543 passed and
106 failed. Failures include portable-fixture gaps as well as application defects; this is
not a passing Windows source gate. The next reviewed correction batch fixes native Project
artifact traversal checks, closes a failed remote-database initialization handle, and ends
Git diff revision ranges with `--` to avoid Windows long-path ambiguity. Golden children
leave their sandbox cwd before cleanup; native Agy/MCP fixtures, filesystem expectations,
background commands, and export-failure fixtures preserve their existing behavior assertions.
Source CI now builds Workspace assets before running the inventory.

All 17 affected regression files pass on macOS Bun and in the separate Deno checkout
(Deno: 87.0 seconds). Types pass across 1,303 entries; lint passes across 1,437 files.
Independent Spec and Standards reviews approved all 17 changed code/workflow paths with
zero findings. The next native Windows run must establish the actual platform result.

The ARM64 source baseline also completed all 649 files: 538 passed and 111 failed.
All eight shard artifacts are preserved. A subsequent eight-file fixture correction keeps
real Git and shell execution while selecting Git Bash paths, native cmd compound commands,
Windows-valid pathspec-sensitive filenames, and explicit CRLF expectations. Both Bun and
Deno pass all eight files; types and lint pass. Independent Spec and Standards reviews
approved all eight paths with zero findings. These local checks do not replace the next
native Windows source run.

The next eight-file image/workflow fixture batch passes Bun and Deno (Deno: 63.6 seconds),
with 1,303 type-checked entries and 1,437 lint-clean files. Agy/Codex image helpers now use
native Windows executable boundaries, workflow fixtures preserve real Git/cmd behavior,
and Bash cwd assertions request Windows spelling to avoid MSYS `/tmp` mount aliases.
Spec and Standards reviews approved all eight files with zero findings. The native run
at `17eb7c790` is still in progress; these subsequent corrections await a later native run.

At `17eb7c790`, both native Windows package jobs and the ordinary PR gate pass. This
includes ARM64 cleanup after all 22 focused files, native lock interoperability, compiled
relocation, provider streaming and terminal restoration. Full source shards remain running.
A subsequent Guided Review correction uses native external helpers and preserves raw cmd
quoting for configured commands, including an executable path containing spaces. The docs
publication race fixture now prepends its Git wrapper inside Bash after shell initialization.
Both affected test files pass Bun and Deno (Deno: 48.8 seconds); types/lint and independent
Spec/Standards review pass. This follow-up awaits native qualification.

Permission-recovery fixtures now use native Windows ACL denials inside disposable test
directories and restore them before cleanup. POSIX keeps real chmod failures; no recovery
cases were skipped. The edit-permission assertion accepts Windows EPERM while retaining
its unchanged-file and no-content-disclosure checks. All three affected files pass Bun and
Deno (13.4 seconds), types pass across 1,304 entries, and lint passes across 1,438 files.
Independent Spec/Standards reviews approved the four changed paths. Actual native ACL
behavior is pending the next Windows run.

Remote fixture coverage now separates Linux/POSIX host integration from native laptop
transport. The original resolver/cache Python tests retain their assertions on POSIX;
Windows runs native SSH boundary tests for literal operands and JSON paths, local artifact
identity/checksum checks, exact binary transfer, reuse, errors and cancellation. The real CLI
also checks literal stdin paths without initializing a local project. All three files pass
Bun and Deno (25.3 seconds); incorrect operands and truncated-byte mutations fail the new
cases. Types/lint pass and both independent reviewers approve. This does not claim a
Windows-to-Linux end-to-end connection or Windows remote-host support.

The first complete x64 source shard at `17eb7c790` improved from 134/162 to 156/162
passing files. Its remaining failures are remote-target fixtures, two SessionRuntime cleanup
cases, a Bash cwd assertion, and three Golden workflow files. Full eight-shard results are
still pending.

The complete x64 source run at `17eb7c790` passes 605/649 files (150/163,
149/162, 150/162, 156/162), compared with 543/649 at the previous baseline.
ARM64 source jobs remain running; both architectures already pass package qualification.
Five affected Session/Golden files pass locally under Bun and Deno (122.3 seconds).
Caller-owned Session stores now close before sandbox removal, and native cmd fixtures
preserve validation failures and retries. The next Windows run retains bounded Golden
failure and timeout state for diagnosis. Types/lint pass; independent Spec/Standards
review approved the three changed paths after correcting the timeout diagnostic filename.

Five additional native fixture corrections pass Bun and Deno (80.9 seconds), plus
types/lint and independent Spec/Standards review. Workspace tests close both search and
Session services before removing databases, the no-home case clears all Windows fallback
variables, and real Git Bash assertions convert MSYS paths at the process boundary.

The completed ARM64 source run at `17eb7c790` passes 603/649 files (150/163,
149/162, 149/162, 155/162), compared with 538/649 previously. Both native package
lanes pass. Full source qualification remains blocked; retained failures guide the next run.

The next five-file protocol correction creates private ProgramData directories in both
isolated runners: Windows OpenSSH requires that variable before initializing stdio.
Claude stream parsing now ignores buffered output after a lifecycle signal is accepted,
independent of platform process-kill latency. Five affected files pass Bun and Deno
(5.9 seconds), types/lint pass, and both independent review axes approve. Removing the
terminal gate makes the new deterministic buffered-output regression fail; restoring it
passes. Native SFTP startup and buffered-output behavior await the next Windows run.

### Integrated qualification and final review follow-up

Merged upstream `b2fed1a1` into the feature branch, retaining the owner's WinGet pause and
updated singular/plural integration-note wording. No release or runtime cutover occurred.
At `210968ca4`, ordinary PR CI and both native Windows package jobs pass; Windows x64
source is 628/649 files. The proper Git-backed Linux checkout at integrated `edecfdfd7`
passed 648/649; its remaining malformed-Plan Golden failure was traced to an unhandled
background autocomplete rejection and corrected without suppressing command errors.

Final complete-diff review identified and corrected bounded-process cancellation,
Windows recovery-path matching, Deno remote stdin cancellation, Snip TOML escaping,
missing-executable error classification and native fixture assumptions. Windows durable
file replacements now reuse the existing EPERM-only atomic fallback across Plan,
registry, controller, Work Record, layout/recovery, collaboration and activation stores.
Open-reader regressions retain the old handle's bytes and verify complete new contents.
Golden evidence now retains the validation error JSONL before disposable HOME cleanup.
Native confirmation of these corrections remains pending.

Native Windows qualification enables Git for Windows `core.longpaths=true` for tracked
file paths longer than 260 characters. Each isolated runner writes that setting only
in its disposable Git configuration and pins `GIT_CONFIG_GLOBAL` to that file across
Golden HOME changes. The user's Git settings are untouched.

The initial qualification fixture put the worktree root itself beyond 260 characters;
native x64 rejected it with `'$GIT_DIR' too big` even with the opt-in enabled. Git has a
separate repository-setup path guard before resolving the `.git` pointer
([Git for Windows setup source](https://github.com/git-for-windows/git/blob/v2.51.1.windows.1/setup.c#L951)).
The corrected fixture keeps repository and worktree roots short, commits a nested file,
and requires its checked-out absolute path to exceed 260 characters, exact preserved
bytes, and a clean Git status. Native confirmation of this corrected fixture is pending.
This qualifies the intended long-file-path prerequisite only when the native test passes;
it does not claim support for arbitrarily deep repository/worktree roots or for Git's
long-path opt-in being disabled. Product worktree naming remains unchanged.

At integrated `10321fc8c`, Linux ARM64 passes all 649 source files and relocated-package
provider/terminal checks. Both native Windows package lanes and ordinary PR CI pass.
Complete Windows source results are x64 638/649 and ARM64 637/649. macOS Bun and Deno
each pass 647/649: Bun exposed an already-removed private directory and a queued-metrics
assertion race; Deno child CLI fixtures contended on dependency installation. The follow-up
uses idempotent private-directory cleanup, a metrics drain, and the preinstalled Deno graph.

Native fixture corrections cover Snip's Windows USERPROFILE trust root, exact verification
file bytes, real Git Bash commands, repeated cache-warming calls, background completion
ordering and settled search responses. Publication test portfolios are split across three
additional isolated files, preserving all 69 cases and the existing per-file timeout; the
complete inventory is now 652 files. Dense real Win32 timestamp cases retain all ownership
checks and are intended to distinguish a suspected timestamp-rounding cause of intermittent
lock retirement. That cause is not yet proven. Two local-publication Golden scenarios remain
unresolved; bounded failure-only Git, registry and external-helper evidence is retained for
the next native run. No dirty-work protection, lifecycle proof or assertion is relaxed.

## Native timestamp precision diagnosis (2026-10-11)

Qualification of `b4434fa5f` confirms the same Windows lock-retirement defect on x64 and ARM64: the real Win32
SetFileTime/GetFileTime probe fails 8 of 1,218 cases under Bun 1.4.3. At 100ns ticks immediately below a millisecond
boundary, Bun's floating-point `stat.mtime`/`mtimeMs` rounds upward, while the native lock handle correctly floors
FILETIME. For example, `mtimeNs=1700000000000999900` yields path Date `1700000000001` and native handle
`1700000000000`; equal lock contents therefore fail the identity comparison and cannot retire. Native and Node writers
both reproduce this. Changed-timestamp and changed-owner negative controls still pass.

The corrective implementation reads bigint `mtimeNs` only for Bun on Windows and floors it to integer milliseconds,
matching the native handle. Exact text, size, token and generation/time evidence checks remain unchanged. The dense
native probe must pass on both architectures before this correction is considered qualified. The same x64 job also
reported a transient `EBUSY` while removing an exited native fixture executable; fixture cleanup now uses bounded
filesystem retries and still fails if removal cannot complete. Neither correction is a production cutover.

The completed x64 source shard 2 passes 163/164 files. Its concurrent-workflow failure records `EBUSY` from a Plan
doctor snapshot read while another operation holds the native Windows byte-range lock. The doctor now treats Windows
read/lock contention as insufficient evidence to repair that particular file and continues scanning. A real native-lock
regression holds one live file throughout report and repair, verifies an unrelated abandoned lock is diagnosed and
removed, and verifies the original ownership and exact bytes remain intact.

## Full qualification and CRLF publication correction (2026-10-11)

At `0be434672`, macOS Bun, macOS Deno and Linux ARM64 Bun each pass all 656 source files.
Both macOS and Linux compiled relocation/provider/terminal checks pass. Explicit non-root
Linux SSHFS/FUSE tests pass with a short temporary root below the Unix-socket path limit.
Ordinary CI run `38115460336` passes. Native run `38115460377` completes with Windows x64
653/656 and ARM64 652/656 source files; both architectures pass all 22 package qualification
files plus compile, relocation, provider and terminal checks. Both native dense FILETIME
probes pass, confirming the exact timestamp correction and preserved ownership controls.

Remaining native failures yielded focused corrections. Executable fixtures use explicit
bounded Windows cleanup retries. The continuation probe uses Git Bash `cygpath` for its
actual cwd. The ARM64 reopened-review test allows bounded time for readiness persistence
and managed Session checkpoint completion after HTTP 202, retaining exact completion,
Plan status and zero-model-turn assertions and recording fresh failure state.

The two local-publication Golden failures reproduce on macOS with `core.autocrlf=true`.
Guard-time evidence shows an unchanged filtered working-file hash, index and HEAD, and
empty working/staged diffs, while porcelain still reports the explicitly restored HEAD
file as modified. A minimal real Git repository reproduces this. After the existing staged
Plan guard proves index/HEAD equivalence, restoring from the index refreshes Git metadata
correctly. The dirty-work guard remains unchanged. A new two-case regression fails before
the fix and passes afterward, including unchanged HEAD/index/bytes for rejected staged
edits and preservation of unrelated untracked files. Both Bun and Deno pass the focused
publication file. All nine Bun publication Goldens also pass with CRLF enabled; only the
two asserted delivery fixtures declare LF checkout bytes through `.gitattributes`, while
Plan files retain CRLF conversion. The global CRLF diagnostic setting is not shipped.

Independent Spec and Standards reviews approve each corrective source/test batch. Required
types, lint and zero-seam checks pass. Native confirmation of the latest corrections remains
pending; this remains a draft qualification branch, with Deno production and the WinGet pause
unchanged. No release, main-branch merge or credential change is included.
