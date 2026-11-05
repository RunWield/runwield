# Test contribution audit — November 4, 2026

Reviewed all 966 original first-party test files using the [write-tests skill](../../src/skills/write-tests/SKILL.md).
Each scenario must protect an independently established promise, exercise real product-owned machinery, detect a
plausible regression, and contribute protection beyond existing coverage. A small test can satisfy these requirements;
a large test can fail them.

The [complete decision ledger](test-value-audit-2026-11-04.json) records every original file and all 6,296 original direct
test registrations, including retained cases, removals, replacements, and the reason for each decision. The scope includes
source, scripts, package tests, and Golden journeys. Helper-registered review cases and the five new test files have
separate entries in the ledger; they are not counted twice in the registration totals. Vendored third-party tests and deliberately defective Reviewer
benchmark subject projects are excluded from pruning; the benchmark admission and repair tests remain in scope.

## Changes

The audited snapshot contains 915 first-party test files and 5,558 direct registrations: 56 original files were removed,
five were added, and there are 738 fewer direct registrations overall. These counts include consolidations and replacements.

- Removed duplicate scenarios, constant inventories, source-text assertions, implementation-shaped helper tests, and
  tests whose internal stand-ins bypassed the behavior they claimed to protect.
- Replaced important weak coverage with real Git repositories, Plan and Session persistence, module interfaces, actual
  subprocesses, HTTP routes, mounted browser components, and terminal input journeys.
- Preserved distinct adverse conditions: stale publication leases, broken assets and records, interrupted work,
  cross-session isolation, malformed protocol requests, unavailable backends, image rejection, and failed submissions.
- Retained small contracts where they protect substantive protocol, security, parsing, or compatibility requirements.
- Reconciled the explicit Bun test inventory with the remaining first-party portfolio.

Representative replacements include release qualification against damaged bundled assets; publication against an
actually advanced remote Git branch; Session and Plan workflows over real persistence; clipboard and image submission
through the actual terminal controller; backend failures from external CLI fixtures; and explicit retry after a broken
project or filesystem resource error. Model, network, subprocess, and OS failures are controlled at external boundaries.

The stronger coverage exposed production defects: strict ACP request validation must run before the SDK normalizes
malformed MCP entries; isolated Golden child environments must not inherit parent credentials; and Workspace development
must open its served `/dev/` route; and successful custom Guide commands can close unused stdin without losing their output. The corresponding behavior and tests were repaired.

## Validation

`bun run ci` passed on an isolated audit snapshot: **914 test files passed, 0 failed, and 1 skipped**.
The gate included source and Workspace type checks, lint, language and injection-seam policy, documentation and skill
checks, builds, and the full source and Golden portfolio. Dependencies were installed from both frozen locks using Bun
1.4.3 before validation.

Another process was changing the shared checkout and replacing test reports, so final validation used a separate
worktree containing the audit changes. Source hashes remained unchanged throughout the final run. This result does not
cover unrelated concurrent edits in the shared checkout.

The first isolated full run exposed one test timing race: terminal idle did not guarantee completion of an asynchronous
shell command. The test now waits for the public command-completion result and distinguishes actual output from echoed
input. The corrected test detects deliberately disabled persistence. A later run exposed an early-exit stdin race in custom Guide commands; deterministic large-input fixtures now verify successful output and original failure diagnostics while built-in jobs still require complete prompt delivery. Both repairs pass focused tests, deliberate regressions, and fresh full CI.

Representative replacements were deliberately broken to verify sensitivity, then restored and rerun. The ledger records
selected regression evidence and validation results. Direct registration counts are not expanded runtime case counts;
renaming or consolidating tests does not imply lost behavior.
