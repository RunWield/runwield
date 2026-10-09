---
planId: "3186a95c-94c1-4ae3-abbc-c32808a701dc"
classification: "FEATURE"
complexity: "MEDIUM"
summary: "Add owner-only Project artifact search, explicitly scoped multi-Project Cymbal code search, and code-server supervision for registered main checkouts with safe deep links from search results."
affectedPaths:
    - "src/shared/work-records/"
    - "src/extensions/cymbal/"
    - "src/ui/workspace/server/"
    - "src/ui/workspace/pages/"
    - "src/ui/workspace/components/"
    - "src/ui/workspace/islands/"
    - "src/cmd/"
    - "docs/prd/runwield-workspace-PRD.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
devServerHmr: true
createdAt: "2026-07-22T03:56:51.475Z"
updatedAt: "2026-07-22T03:56:51.475Z"
status: "draft"
origin: "internal"
parentPlan: "personal-remote-workspace-v1"
order: 13
dependencies:
    - "03-secure-persistent-workspace-bootstrap-and-device-pairing"
---

# Workspace Search and Subordinate Code Surface

## Context

Personal Workspace should let the owner search eligible durable artifacts across registered Projects and perform
explicitly scoped human Cymbal code search. It should also provide a subordinate Code Surface through code-server for
manually inspecting or editing a registered Project's main checkout. Search and Code Surface belong together because
code results should deep-link to safe main-checkout views.

This slice intentionally excludes Sourcebot, one global call graph, cross-Session Agent retrieval, and Plan worktree
federation.

## Objective

Build owner-only search and Code Surface capabilities:

- Project and Workspace artifact search using candidate indexes plus canonical hydration/access policy;
- owner-private Transcript search for human use only, excluded from Workspace Intelligence and Agent retrieval;
- explicitly selected multi-Project Cymbal JSON fan-out over registered main checkouts with bounded concurrency/results;
- partial-result degradation when one Project/index fails;
- code-server lifecycle supervision for registered main checkouts only;
- search deep links to Code Surface when the result corresponds to a registered main checkout file.

## Approach

Generalize existing Work Record search's index-plus-canonical-hydration pattern for durable artifacts. Add a shared
search coordinator near `src/extensions/cymbal/` or under Workspace server services for human-only federated Cymbal
queries. Supervise code-server as a subordinate process and trust seam, never as the Workspace shell or a Plan workflow
owner.

## Files to Modify

- `src/shared/work-records/search.js` and related artifact readers — generalize canonical hydration and access-policy
  patterns for broader Project/Workspace search.
- `src/extensions/cymbal/index.ts` or a new shared search coordinator beside it — add bounded, explicitly scoped human
  Cymbal federation while preserving current Agent tool behavior.
- `src/ui/workspace/server/` — add search APIs, Project selection, result hydration, code-server process supervision,
  health, and safe path routing.
- `src/ui/workspace/pages/` — add search and Code Surface routes.
- `src/ui/workspace/components/` and `islands/` — add search forms/results, Project filters, partial failure states,
  code-server health controls, and deep links.
- `src/cmd/` — add code-server prerequisite checks or launch helpers if needed.
- `docs/prd/runwield-workspace-PRD.md` or deployment docs — document code-server prerequisites, private-network/TLS
  expectations, and search privacy boundaries.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `src/shared/work-records/search.js` — reuse candidate-index plus canonical-hydration behavior.
- `src/shared/work-records/index-adapter.ts` — reuse index abstraction where applicable.
- `src/extensions/cymbal/index.ts` — reuse installed Cymbal CLI and JSON contract.
- Owner Project registry from slice 2 — determine eligible registered main checkouts and opt-outs.
- `src/ui/design-system/` — use existing Workspace form, result, badge, and panel patterns.

## Implementation Steps

- [ ] Define searchable artifact categories, default Project contribution behavior, and opt-out flags.
- [ ] Implement artifact search that hydrates from canonical files and filters by access policy before returning
      results.
- [ ] Implement owner-private Transcript search that is human-only and unavailable to Agent retrieval or collaborators.
- [ ] Implement federated Cymbal search over explicitly selected registered Projects with concurrency/result caps,
      sanitized paths, Project labels, duplicate handling, and partial failure reporting.
- [ ] Add search UI with Project selection, artifact/code mode distinction, grouped results, and transparent
      ranking/grouping.
- [ ] Add code-server supervision for registered main checkouts only, including start/stop/health/status and safe
      route/proxy handling.
- [ ] Add search result deep links to Code Surface only for registered main checkout files, never Plan worktrees.
- [ ] Add tests for opt-out, stale/missing index candidates, path sanitization, selected-Project enforcement, partial
      failures, code-server root containment, and Plan worktree exclusion.

## Verification Plan

- Automated: run `deno task ci`.
- Automated: tests should verify artifact hydration, Transcript search exclusion from Agent retrieval, Cymbal fan-out
  selection, result caps, sanitized paths, partial failures, duplicate labeling, and code-server registered-root
  enforcement.
- Manual headed browser: run `deno task workspace:dev`, search across two registered Projects, verify Project-labeled
  grouped results, inspect partial failure UI by disabling one index, and open a code result in the Code Surface.
- Manual headed browser: verify code-server cannot open a Plan worktree or unregistered path, stopped/failed process
  health is visible, and phone/desktop layouts remain usable.

## Edge Cases & Considerations

- Independent Cymbal Project result sets do not expose comparable global scores; group by Project or use transparent
  exact/prefix rules.
- Search privacy filtering must apply before subprocess launch where possible, not only after results return.
- code-server has terminal/filesystem power within its configured environment; treat it as a separate high-trust
  integration.
- Manual edits in Code Surface may make Plans stale or create merge conflicts; normal RunWield checks must surface that
  later.
