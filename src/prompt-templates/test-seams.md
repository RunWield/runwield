---
description: Find tests that replace product-owned behavior and suggest fixtures that exercise the real implementation.
agent: engineer
---

# Test-seam audit

Inspect representative production composition and tests for concrete signs that tests replace product-owned behavior.
Keep discovery bounded to representative examples, or the area the user explicitly requests.

## Process

1. Read the bundled `write-tests` skill. Apply its ownership rule in the project's own language: tests must not replace
   product-owned machinery, and only genuine external systems earn fakes.
2. Read the project's architecture, test conventions, production composition, and representative tests. Use
   read/search/code tools and discovery-only shell commands. Trace each suspected replacement to the behavior it
   bypasses.
3. Flag concrete candidates when tests replace storage, lifecycle, transactions, registries, locks, orchestration, or
   other behavior that appears to belong to the project. Also look for optional collaborators, production fallback
   between an injected behavior and a system implementation, mutable global implementations reset by tests, branches
   keyed to test or fake mode, and broad mocks that prevent a feature's real code path from running.
4. Do not flag ordinary data/configuration parameters, normal fixture data, or fakes for external systems such as
   networks, subprocesses, clocks, browsers, model calls, and hosted services. When ownership is ambiguous, report the
   candidate with uncertain facts instead of silently deciding.
5. End with a `Possible test-seam risks` section. For each candidate, include the exact file and construct, what
   behavior appears replaceable, why that behavior may be product-owned machinery rather than an external system, what
   fixture environment could exercise the real implementation, the confidence level, and the facts that remain
   uncertain. State the scope inspected. If no candidates were noticed, say that and do not call the project clean.
6. Ask the user whether to dismiss each candidate as a legitimate external boundary, record it in the existing issue
   system, request a Plan for a fixture-based refactor, or leave it unpersisted for now. Do not write issues, Plans,
   Memory, or domain language for possible risks unless the user explicitly chooses that persistence.

This is advisory discovery, not enforcement and not a source check. Do not modify production code or tests during the
audit. Do not add commands, analyzers, manifests, or CI rules. Use the project's own paths and terminology rather than
RunWield's repository layout or private implementation names.
