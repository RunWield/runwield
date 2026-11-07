---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/server/project-artifacts.ts"
    - "src/ui/workspace/server/workspace-search.ts"
    - "src/ui/workspace/react/ArtifactReadSurface.tsx"
    - "src/ui/workspace/react/UnifiedWorkspaceSearch.tsx"
    - "src/shared/workspace-search-refresh.ts"
    - "src/acp/"
    - "src/ui/desktop/"
    - "docs/prd/runwield-workspace-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:36.943Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 8
dependencies:
    - "review-and-edit-plans-inside-desktop"
    - "run-plans-through-integrated-code-review"
targetBranch: "epic/local-workspace-desktop"
planId: "7790c021-5778-4328-9fb6-042a05e76a38"
---

# Read and Search Project Knowledge

## Context

The artifact reader depends on browser payload/navigation behavior. Unified search also includes a Workspace-owned SQLite FTS cache, timers, canonical revalidation, and recovery; moving the search component alone would lose behavior.

This child implements knowledge/document/search parity under [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace) and [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access). It does not introduce a new knowledge store or general memory browser.

## Objective

Users read project documents/artifacts and search existing supported content inside desktop, follow provenance, and return to their original context. Runtime-scoped resources enforce safe access and current canonical evidence.

## Approach

Expose existing readers and search through authoritative shared runtime services, with bounded resource references and typed results. Reuse shared reader/search components without hosted-page embedding.

Keep search indexes disposable projections. Treating cached hits as authority would be cheaper but could expose revoked, stale, or wrong-checkout content.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `server/project-artifacts.ts`, `server/workspace-search.ts`, `src/shared/workspace-search-refresh.ts`, and appropriate shared Core owners — readers/search move out of UI runtime ownership.
- `react/ArtifactReadSurface.tsx`, `UnifiedWorkspaceSearch.tsx`, and current artifact page composition — shared document/search experience.
- `src/acp/`, shared client, and `src/ui/desktop/` — scoped resources, search pagination, integrated routes, and printing.
- Workspace/ACP capability scenarios and inventory — delivered parity and retained standalone reader evidence.

## Reuse Opportunities

- `readProjectArtifact`, `domainLanguagePaths`, containment helpers, and canonical Plan/Work Record readers.
- `createWorkspaceSearchService` refresh markers, evidence checks, and corrupt-cache recovery.
- Existing reader/search UI, markdown/image rendering, contents navigation, and provenance presentation.

## Implementation Steps

1. Desktop reads Work Records, PRDs, ADRs, Design System, mapped Domain Language, and existing supported artifact types through structured runtime resources. Contents, images, provenance links, print behavior, and return navigation remain available.
2. Reader semantics preserve Work Record confidence/notices, current-versus-historical filtering, duplicate identity handling, Domain Language map revocation, and authoritative execution-worktree resolution.
3. Unified search preserves all seven existing content types, cross-Project filtering, pagination, result navigation, and search-state restoration. Session search remains committed name/first-message evidence, not private full-transcript indexing.
4. Search validates current canonical candidates before paging. External edits, explicit refresh, restart, and corrupt-cache recovery work through the runtime owner; cache loss cannot remove canonical work.
5. Large documents/diffs/images use bounded transfers and runtime-scoped identities. Unsafe paths, revoked mappings, wrong-Project references, and unavailable resources are refused without renderer filesystem access.
6. Standalone artifact/document readers remain independent of Electron. Contract rows and owning requirements/scenarios match delivered behavior without promoting hosted SaaS or new sharing scope.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun scripts/run-tests.js src/ui/workspace/server/workspace-search.test.ts src/ui/workspace/session-artifact-route.integration.test.ts src/ui/workspace/routes/api/review-file-containment.test.ts src/ui/workspace/routes/api/review-file-content.test.ts` and `bun run seams:check`.
- Planner defines focused real-process reader/search tests using real canonical data. Prove refresh after external edits, stale hit exclusion, map revocation, safe symlink/path handling, pagination after revalidation, cache corruption, and bounded large-resource behavior.
- Headed verification uses desktop knowledge navigation -> document -> provenance -> return, and search -> filter/page -> result -> back. Discover and record the desktop dev command and URL/origin. Exercise images, contents navigation, print, keyboard access, and long documents.
- Confirm desktop does not launch/embed standalone reader pages. Separately prove retained standalone reading works without Electron and does not gain broader access.
- Verify canonical storage remains unchanged by reading/search and existing private-transcript limits survive.

## Edge Cases & Considerations

- Identical paths on different connections must not alias; remote transport remains out of scope.
- Deleted documents or permissions changing between result and open require revalidation.
- Search cache and live observations must never become storage authority.
- This child reads existing glossary documents; the desktop product-definition glossary update belongs to browser cutover, not this reader implementation.
