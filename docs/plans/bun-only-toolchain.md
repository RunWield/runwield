---
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
status: "in-progress"
createdAt: "2026-10-12"
planId: "6356d270-7145-4aaa-b1ed-4a0e8e8a35b2"
---

# Complete the Bun toolchain migration

Carlos is dogfooding v0.12.0-rc.1 and requested phase 2: tooling, containers and replacement of direct `@std/` dependencies.
The RC is a Bun executable. This plan records retirement of the remaining Deno developer/build/container paths.
This work starts at `9d4bb0374` in an isolated checkout. Preserve the primary checkout, installed executable, live Sessions,
published RC and Stable channel. Publication is a draft PR only; merging and another release are not authorized.

## Inventory and sequence

1. Replace direct standard-library imports. The inventory contains 633 assertion imports, 401 path imports, 21 CLI
   parser imports, 12 front-matter imports, seven static JSONC imports plus one dynamic import, and two fake clocks.
   Prefer Node builtins for paths, URLs and assertions. Use maintained npm parsers and clocks with narrow adapters for
   existing caller contracts. Pin flag aliases, repeated values, literal `--no-*` flags, argument boundaries, YAML dates
   and malformed documents, JSONC trailing commas and rejection, and deterministic clock advancement.
2. Normalize package commands: `compile`, source startup, tests, Golden tests, CI, release/package commands, hooks and
   documentation. Preserve isolated HOME/database/temp handling, descendant cleanup, all source and Golden coverage,
   type/lint/format rules, dependency age and disabled install scripts. Replace Deno-based build identity inputs.
3. Migrate PR/release/docs workflows and remote Workspace container builds. Build reproducibly with Bun 1.4.3 and frozen
   root/docs lockfiles. Preserve package smoke tests, Stable/Candidate separation, immutable release recovery, WinGet pause,
   unprivileged container execution and durable `/data`. Carlos subsequently approved removing Deno permissions from
   these test-only containers; production-equivalent hardening is deferred.
4. Remove obsolete root/docs Deno manifests after their consumers are migrated. Audit runtime selection, prototype
   tooling, source fixtures, generated bundles, container assertions, docs reconciliation and developer instructions.
   Historical documents and example projects may discuss Deno; they are not active toolchain requirements.

## Acceptance

- A clean environment without a Deno executable installs both frozen graphs, passes static/source/Golden gates, builds
  and packages the CLI, and runs the relocated CLI and remote Workspace container.
- Supported macOS/Linux/Windows qualification runs in cloud CI. Native Windows path, locking and cleanup coverage stays.
- Cross-runtime lock compatibility with released Deno binaries remains a separate compatibility check, not a prerequisite
  for the everyday Bun toolchain. Do not silently remove compatibility coverage while old releases are supported.
- Independent Standards, Spec and Tests reviews approve concrete changes. Focused regression tests must fail under a
  plausible broken implementation. Keep local disk bounded and retain compact cloud evidence.
- Draft PR description distinguishes implemented behavior, verified platforms and remaining limitations.

## Dependency sources

The Node assertion/path/URL APIs are the default replacements. Parser behavior is checked against the existing contracts
and the maintained upstream documentation for [yargs-parser](https://github.com/yargs/yargs-parser),
[js-yaml](https://github.com/nodeca/js-yaml), [jsonc-parser](https://github.com/microsoft/node-jsonc-parser), and
[Sinon fake timers](https://github.com/sinonjs/fake-timers). Existing locked parser versions are preferred to unrelated upgrades.

## Delivery checkpoint

The dependency replacement is committed as `77ec91f36`. Direct source/test imports now use Node builtins plus
js-yaml, jsonc-parser, yargs-parser and Sinon clocks. Commit `16af8b4a1` removes root @std aliases and the Deno Astro adapter,
adds default Bun commands and named compile compatibility, migrates prototype execution and the staged formatting hook,
and moves source/Golden/release qualification and metadata identity to Bun. Historical tag recovery keeps tagged Golden
qualification and uses commands already present in RC1.

Local evidence: 1,325 source/test entries type-check; lint and zero-seam gates pass. Focused parser, storage, model,
prototype, hook, build identity, release and docs tests pass. Fifteen intentional regressions are detected, and the real
compiler rejects an expected-build-identity mismatch before emitting an artifact. A relocated native macOS package passed
CLI onboarding/cancel, Plan entry, worker/WASM, image conversion, Workspace assets/auth and shutdown.

The remote Workspace and Plan Server bundlers now use Bun through `bun run workspace:remote:build`. A real compiler
contract test executes relocated bundles with SQLite after deleting their source tree. The full remote bundle passed
health/readiness, review-page rendering, CSS delivery and clean shutdown with a disposable database. Container execution
and its filesystem boundary are not yet qualified. The initial cloud run passed all Golden shards, six Unix source shards
and macOS/Linux/Windows x64 package checks; source shard 1 exposed a missing JSONC module in a copied fixture, fixed in
`ca52c5c2a`. Cloud qualification is rerunning on the repaired branch.

At that checkpoint, cloud qualification and container conversion remained. The later owner decision below supersedes
the permission-equivalence blocker. Another release or merge remains unauthorized.

## Container boundary and historical docs follow-up

The existing remote image runs as `deno` and grants application filesystem reads only under `/app` and `/data`, writes
only under `/data`, and no subprocess permission. Network, environment and system-information permissions are already
allowed. Replacing the command with Bun would remove the per-process filesystem and subprocess checks. Non-root execution
and a read-only root filesystem restrict writes but do not deny reads of other readable files or newly mounted secrets.
That option is not an equivalent boundary and is not being adopted.

Before the later owner decision, the safe continuation was to qualify an OS-enforced allowlist
with Bun, failing closed when enforcement is unavailable; otherwise the remote image remains on its existing runtime.
A choice is needed only to accept a weaker boundary or a new hosting/kernel requirement. Linux Landlock can restrict an
unprivileged process and its future children, but its ABI, runtime loader/filesystem needs and subprocess behavior require
qualification before this image can switch. See [the kernel documentation](https://docs.kernel.org/userspace-api/landlock.html)
and [Bun's filesystem permission request](https://github.com/oven-sh/bun/issues/26637). The checked-in image has not changed.
Bun-target bundles use Bun-specific builtins and cannot run under Deno. A later isolated compatibility experiment resolved
Node-target bundling's dynamic dependency by selecting jsonc-parser's ESM entrypoint. Bun-built Node bundles then passed
remote health/readiness, review HTML, CSS and graceful shutdown under Deno 2.9.7 with the existing permission categories.
This proves a Bun-build/Deno-runtime fallback is feasible; it is not implemented in the production image and does not
resolve the pending decision about retaining that runtime exception.

Historical docs deployment now separates the exact Stable/docs-corrections checkout from current Bun tooling. Sync records
an immutable tooling SHA; direct docs corrections use current default-branch tooling. The source dependency declarations
must match the frozen docs graph before that graph is copied into the separate source tree. No old Stable task scripts run.
The actual `v0.11.8` site passed all 21 route checks with this workflow's builder, without publishing anything. The real Git
integration also checks retained documentation corrections, newer Stable content, stale source rejection and conflict stops.

## Legacy tooling retirement

The unused Deno compiler, type checker and linter entrypoints, plus the docs Deno manifests, are removed. Root Deno tasks
temporarily forward to their Bun package commands; the root manifest and lock remain while the remote container still
references them. Source contract tests now inspect the active package manifest. The memory diagnostic compiles its real
entrypoint with the production Bun payload builder, includes entrypoint bytes in build identity, and uses Bun collection.
Renderer, saved-operation and combined scenarios passed in both source and standalone modes, with and without collection.
Nineteen deliberate regressions across the migration have been detected by the focused tests.

The separate UX image now starts from Debian without Deno and preserves UID 1993 and `/home/deno` for existing mounts.
New cloud jobs qualify that installer image and the compiler/remote bundles in an image with no Deno executable. The
restricted remote `Containerfile` remains unchanged and unqualified on this branch; the draft is not merge-ready.

## Exact remote sandbox obstacle

The filesystem boundary includes metadata operations, not only opening file contents. A disposable Deno 2.9.7 probe
using the image's permission shape allowed its approved fixture read and denied outside reads, `stat`, `chmod`, `utime`,
writes and subprocess execution. No real user data was used. Linux's
[Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html#filesystem-flags) explicitly lists `stat`,
`chmod`, `chown`, `utime`, `access` and other operations that Landlock cannot restrict. Adding a deny-exec seccomp filter
does not close that filesystem gap. Classic seccomp filters cannot inspect pathname strings safely; a separate broker or
host policy would need to enforce them. A JavaScript allowlist or replaceable libc wrapper would not be an enforced boundary.

Therefore a Landlock-only Bun image cannot be called equivalent. The remaining choice is whether to retain a Deno-only
exception for this restricted image, or accept a new host-managed sandbox requirement whose full filesystem and subprocess
policy must then be qualified. Neither a weaker policy nor extra host privileges have been adopted. That was the decision pending at the previous checkpoint; the owner decision below resolves it for these test images.

## Owner-approved test container scope and original task names

Carlos resolved the container decision: “No need to find equality with that one. Just replace it with bun. We can worry
about that later. For now those containers are tests.” The Bun image is explicitly test-only and non-hardened; equivalent
Deno filesystem/subprocess permission enforcement is deferred. This authorizes no deployed host or production access changes.

Both remote image stages now use Bun 1.4.3 with frozen, lifecycle-disabled installation. The final image contains only
bundled runtime/passive assets, preserves numeric UID 1993 and `/data`, and runs without root. Compose retains loopback
publishing and adds a read-only root, dropped capabilities, no-new-privileges, and temporary scratch space. These measures
are practical container protections, not equivalent Deno permissions. Its health check now uses Bun. The last root
`deno.json`/`deno.lock` consumers are removed; Dependabot tracks root/docs Bun graphs. Historical release interoperability
checks deliberately retain Deno in separate CI lanes, as required by the acceptance criteria.

Carlos also clarified that public task names must stay the same as under Deno. All 49 names were audited; none is missing.
Canonical commands now own implementation and are used in ordinary CI/release tooling. The sole historical build fallback
uses `compile:bun` for immutable RC1 checkouts that lack the new named compiler. See the
[complete argument and exception audit](bun-task-compatibility.md). Compile named arguments, test name filtering, compound
argument boundaries, and failed build prerequisite propagation have focused regression coverage.

Qualification for these final changes must include the remote image's runtime files, nonroot user, absent Deno runtime,
health/readiness, built HTML/CSS, SQLite persistence across restart, graceful shutdown and read-only application directory.
The draft PR stays unmerged and no release is published.

## Fresh dependency and API audit

A new independent review of `8716e918a` found omissions that successful runtime smoke checks had not covered: the
repository's saved verification command and Claude editing hook still launched Deno; maintained mascot scripts still
called Deno globals; and the Astro development Shared Space page read its mode only from the absent Deno environment.
Those commands and tools now use Bun/Node APIs. The page reads the process environment and has a real Astro development
HTTP regression for remote, local and unset modes. A temporary mutation that removed that environment value failed the
new regression. Historical audit probe APIs were also ported, without changing their archived assertions.

Obsolete Deno runtime branches have been removed from the product adapters (HTTP, subprocesses, locks, stdin, identity,
Workspace assets and crash handling) and fixture tooling. The ordinary test runner now pins Bun unconditionally. A new
AST-based owned-code audit runs with lint across repository code, including Astro frontmatter, inline preview scripts,
brand tooling and the repository's executable command defaults. It rejects executable Deno references, reflected and
computed Deno lookups, runtime-registry imports, Deno subprocess literals and shebangs. It is a regression guard, not a
proof about arbitrary dynamically constructed code. The Deno-free container lane additionally executes the maintained
mascot generators and the actual Astro development route tests.

The explicit old-release interoperability probe still launches pinned Deno in package qualification to test cross-runtime
lock ownership. This is an external compatibility test, not a product or ordinary toolchain dependency. User-project Deno
Snip filters and command classification remain supported. Legacy fixture argument labels, historical prose, inert sample
diffs, Deno-derived lint rule names, and preserved container user/home names do not invoke a runtime.

The root and docs Bun locks resolve 1,159 and 463 package entries, respectively, with no Deno, JSR or standard-library
runtime package selected. Unstorage lists an uninstalled optional `@deno/kv` peer and ships opt-in Deno drivers. Several
vendor libraries retain guarded Deno support; inspected Bun exports and current application configuration do not select
those runtime paths. Vendored libraries have not been rewritten merely to erase those strings.
