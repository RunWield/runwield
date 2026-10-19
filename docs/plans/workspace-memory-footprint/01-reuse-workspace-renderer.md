---
planId: "6928f86e-c4d3-497a-8ff0-7abb792d17e9"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/workspace-local-server.test.js"
    - "scripts/build-workspace-runtime.ts"
    - "docs/prd/runwield-workspace-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
origin: "internal"
parentPlan: "workspace-memory-footprint"
order: 1
dependencies:
    []
userVerifiedAt: null
createdAt: "2026-09-30T04:08:57.304Z"
targetBranch: "main"
status: "validated"
validatedCommit: "3e3cb3cdf564229813abe40727f27925001f58c2"
---

# Reuse the Workspace Page Renderer

## Context

**Page navigation repeatedly loads a new renderer module into the server.** This is the largest confirmed retention
mechanism from the [Workspace memory investigation](../workspace-memory-footprint.md).

`loadAstroHandle` in `src/ui/workspace/server.js` imports an entry URL with `?mtime=${Date.now()}`. Owner pages, local
Plan pages, Plan and Code Review, and question pages all use it. In packaged execution, the entry is a roughly 24 MB
single-file bundle.

The isolated packaged-bundle proof retained about 56 MiB more heap on each additional unique import after garbage
collection. Five stable-URL imports added only 37 KB after the first. This proves the mechanism, not the exact cost of a
complete page request or the owner's historical 3 GB incident.

Owning capabilities:

- [Workspace Browser Sessions](../../prd/runwield-workspace-prd.md#browser-sessions): proposed addition, **Keep repeated
  browser use memory-stable**. This slice covers navigation without per-request renderer retention; the next slice
  extends it to operation observation.
- [Browser Plan review and workflow](../../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow): preserve
  **Review the current Plan and preserve explicit execution choices**, including current content and decisions.
- [Local Plan management](../../prd/runwield-workspace-prd.md#local-plan-management): preserve read/edit behavior,
  links, and lifecycle isolation.

No requirement is removed. The requirement wording must describe observable use, not JavaScript module loading.

## Objective

A server process reuses its successfully loaded renderer for all page requests. Repeated navigation no longer creates a
new module instance or rereads the whole server bundle for an importability check. Pages still show current
request-specific data.

## Approach

Keep the existing loader and rendering paths. Store one process-local in-flight/successful loading promise in their
shared owner. Use the canonical file URL without a per-request query.

```text
first page request -> shared load promise -> existing entry selection -> stable import
concurrent request -> same load promise
later page request -> same renderer -> render this request's current data
unavailable build  -> existing unavailable/fallback result; next request may retry
```

Preserve entry preference: packaged execution prefers `dist/workspace-runtime/server.mjs`; source execution prefers
`dist/workspace/server/entry.mjs`. Keep the alternate-entry fallback and `WLD_WORKSPACE_DISABLE_BUILT_SERVER` behavior.
A missing or rejected importability preflight does not permanently cache absence. A successful handle stays fixed for
the process lifetime.

**Reviewable operational assumption:** rebuilding an already loaded production renderer requires restarting that server.
`deno task workspace:dev` retains Astro's normal hot reload. Do not emulate hot reload with unique import URLs. If
JavaScript has cached an actual module-evaluation failure, report the failure and require a restart after repair rather
than inventing unlimited cache-busting retries.

Cache the renderer, **not Responses, review payloads, authentication, Project paths, or page data**. No new loader
injection seam is needed. A helper extraction is acceptable only if it owns loading and failure state, not if it merely
forwards calls.

A new worker or process per page was rejected: it adds coordination and startup cost to fix a defect that stable module
identity removes directly. No architectural decision record or glossary change is needed; this preserves the current
runtime and domain model.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/workspace/server.js` — shared renderer loading, entry selection, and unavailable-build handling.
- `src/ui/workspace/workspace-renderer-lifecycle.test.ts` (new) and existing server/review tests — real page responses,
  reuse, concurrency, and request isolation.
- `scripts/workspace-memory-check.ts` (new) — a repeatable isolated built-server memory experiment, extended by slice 2.
  It is a verification script, not production telemetry.
- `scripts/build-workspace-runtime.ts` and its tests — use the actual packaged artifact for verification; change
  packaging only if the real test exposes a necessary compatibility repair.
- `docs/prd/runwield-workspace-prd.md` — navigation memory requirement and scenarios, with operation observation still
  targeted until slice 2.

Do not alter operation retention, transcript projection, browser rendering, or review conversation lifetime in this
slice. Concurrent dashboard/catalog work in the checkout is separate and must not be overwritten.

## Reuse Opportunities

- Existing `renderAstroPage`, `renderRequiredOwnerAstroPage`, `renderAstroReviewPage`, and `renderAstroQuestionPage`
  keep request handling and security checks.
- Existing built-entry validation and source/runtime preference remain the selection policy.
- Existing real Git/Workspace fixtures and sandboxed runner provide independent Projects, Plans, and credentials.
- The scratch proof at `/tmp/runwield-workspace-import-proof-litBlO/` supplies diagnostic method and numbers. Recreate
  its checks in the repository; validation must not depend on this temporary path.

## Implementation Steps

1. `loadAstroHandle` shares one in-flight load and reuses the first successful handle across all four rendering paths.
   No successful page request creates a new time-derived module URL. After successful initialization, requests do not
   read the complete entry file again to validate it.
2. Disabled built rendering, absent entry files, importability failure, and source/runtime fallback retain their current
   route behavior. A request after a previously absent build becomes available can succeed. Concurrent failed requests
   settle, release the pending load state, and do not hang. Successful production loads do not hot-swap on file
   timestamps.
3. Real page tests receive distinct, current Project/Plan/review content through the shared renderer. Repeated and
   concurrent requests still render the requested page, preserve security checks, and never return another request's
   cached payload. Plan body changes appear on a later request without reloading the renderer.
4. `scripts/workspace-memory-check.ts --scenario renderer` runs separate isolated processes against source and packaged
   server paths, warms the same route set, consumes response bodies, and compares repeated-request retained memory. The
   packaged case uses a small compiled fixture launcher for the actual owner/local/review app handlers with the real
   Workspace runtime artifact included, following `scripts/compile.js` asset packaging; it must exercise
   `Deno.build.standalone === true`. The remote Shared Space server and a bundle launched with `deno run` are not
   substitutes for compiled owner Workspace. It exercises the production loader through actual page handlers, not only a
   standalone `import()` loop. Test-only synthetic entry files may prove load counts and failure handling, but cannot
   replace the real-bundle measurement.
5. The renderer lifecycle regression fails on the old implementation, on a loader that returns null/static fallback, and
   on a response cache that hides repeated loading. The memory script has a timeout and memory guard and treats
   aborted/incomplete samples as failure, not success.
6. The owning Workspace capability and cross-references describe repeated navigation without continuing memory growth
   from renderer instances. Existing Session, local Plan, and review scenarios remain unchanged. Record baseline and
   post-change evidence without claiming that all memory growth is eliminated.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

Run these focused commands from the execution checkout:

```sh
deno task workspace:build
deno run -A scripts/build-workspace-runtime.ts
deno run -A scripts/run-tests.js src/ui/workspace/workspace-renderer-lifecycle.test.ts src/ui/workspace/workspace-local-server.test.js scripts/build-workspace-runtime.test.ts
deno run -A scripts/workspace-memory-check.ts --scenario renderer
deno task seams:check
```

The new memory script owns sandbox HOME and database paths before loading application modules, uses
`getHomeDir()`/`getCwd()` in application code, and never contacts model providers. Tests that mutate environment or cwd
use `withProcessGlobalTestLock`. Never invoke `deno test` directly.

**Discriminating checks:**

- Instrument fixture module initialization, not the loader's source text: multiple sequential and overlapping real
  requests initialize one successful entry. Distinct content and response status assertions rule out disabled rendering
  or a placeholder.
- Separate subprocess cases cover source-first/runtime-first selection, fallback, missing build followed by
  availability, concurrent first loads, and disabled built rendering. Use real artifact paths in an isolated runtime
  layout, not an injectable importer.
- Verify valid current Plan content, review payload isolation, and authentication after reuse. Existing fallback tests
  remain; they do not satisfy the built-renderer test.
- Memory experiment: warm each route first; sample after three garbage collections with event-loop yields; record heap
  used, external buffers, RSS, response count, artifact hash, runtime flags, and elapsed time. Report source and
  compiled outcomes separately. The initialization-count regression must fail on both old source and compiled paths; the
  numerical heap threshold is required for the compiled path, where growth was measured. Source measurements remain
  required, but a smaller source entry need not exceed the same byte threshold. Run two batches of ten identical
  navigation cycles. For a minimal repeatable fixture, the second batch must add no more than **10 MiB retained heap**
  over the first batch. This is a conservative regression allowance, not a universal Workspace memory limit. The same
  workload on the old implementation must exceed it or hit the safety guard. Never relax a threshold solely to pass;
  investigate and report a required change.
- Use an absolute 1 GiB RSS guard and bounded timeout in the fixture subprocess. Record guard exits as
  failed/incomplete. RSS may stay elevated after release; do not substitute RSS for reachable-heap evidence. Include a
  production-default-flags sample separately from forced-GC diagnostics.

**Browser check:** `deno run -A scripts/workspace-memory-check.ts --serve-fixture` starts an isolated built Workspace
server and prints its selected localhost URL and shutdown command. This mode supplies disposable
owner/local/review/question fixtures, exposes no real Projects, and cleans up on exit. Use `agent-browser` in a uniquely
named session; record its actual localhost URL. Navigate between two Sessions, two Plans, Plan Review, Code Review, and
a question page ten times. Verify current content, console errors, network status, and server memory samples. Do not
send model requests or answer real reviews. This verifies rendering and routing, not visual redesign.

Protected behavior: live page data, request isolation, authentication, fallback responses, Plan links/editing, and
review controls. Only timestamp-driven renderer reloads stop existing. Browser hot reload remains available in the
existing development command.

## Edge Cases & Considerations

- Application/module caches outlive an individual Workspace app object. Cache lifetime is the server process, not a
  browser connection or test case.
- A cached handle must not capture the first request's headers, cwd, token, or review payload.
- Builds may change concurrently. Measure immutable artifacts from this execution checkout and record hashes; never
  benchmark another Session's live server.
- The exact 3 GB incident cannot be reconstructed. Acceptance proves the identified mechanism is removed, not that every
  possible large allocation is solved.
