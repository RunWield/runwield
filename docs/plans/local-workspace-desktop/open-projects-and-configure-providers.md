---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/desktop/"
    - "src/acp/"
    - "src/shared/owner-coordination/"
    - "src/ui/workspace/server/owner-projects.ts"
    - "src/ui/workspace/islands/ProjectRootForm.tsx"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:33.113Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 2
dependencies:
    - "run-a-real-session-in-electron"
targetBranch: "epic/local-workspace-desktop"
planId: "99e4b90d-f981-4033-b7eb-7761e7a50116"
---

# Open Projects and Configure Providers

## Context

The first desktop proof has a real ACP connection but not a complete entry journey. A clean installation must open existing Projects and configure model access without a Workspace account or a global CLI.

This child implements the entry scenarios in [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace) and protocol admission/setup in [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access). Existing Project access rules and layered provider settings must survive.

## Objective

The user selects an existing Project through a native picker, confirms runtime-side admission, manages registered Projects, and either reuses provider settings or completes the actual supported Core setup flow. Missing provider access does not block local browsing.

## Approach

Native selection supplies a candidate path, not authorization. Core owns registration, trust, and provider readiness through negotiated product operations. Desktop presents their results.

Reuse actual Core login/default-model selection, including the bundled executable if a terminal flow is necessary. Do not invent a desktop credential store or confuse provider setup with future Workspace sign-in.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/desktop/` and shared Workspace composition — first-run navigation, native picker, Project management, and setup states.
- `src/acp/`, `src/cmd/acp/`, and existing login/configuration owners — negotiated admission and provider setup.
- `src/ui/workspace/server/owner-projects.ts`, `islands/ProjectRootForm.tsx`, `src/shared/owner-coordination/` — extract reusable authoritative behavior without ACP importing UI server code.
- Workspace/ACP PRDs and focused tests — delivered admission/setup scenarios.

## Reuse Opportunities

- Existing Project registration/relink/access logic and canonical Project identity.
- `createInitializeResponse` and existing ACP Terminal Auth/provider-readiness behavior.
- Existing Core configuration and login flows; current Plan-store APIs, not hard-coded checkout storage.

## Implementation Steps

1. Project listing, registration, confirmation, relinking, disable/enable, removal without repository deletion, archived-Session access, and full Session rescan work through the semantic client and authoritative runtime services.
2. Runtime-side admission refuses unregistered roots and mismatched connection/Project references. Every operation carries explicit context rather than using process cwd or selected UI tab as authority.
3. The desktop opens existing canonical provider configuration and Project state without importing into a second store. A missing provider presents actionable provider setup and default-model selection while saved work remains browseable.
4. The supported provider authentication mechanism works from the app using its managed executable. Setup cancellation or failure does not create a fake authenticated state, and credentials do not enter renderer storage.
5. Local entry works with Workspace cloud endpoints unavailable. There are no mock sign-in, remote, subscription, or cloud controls.
6. Contract inventory rows and owning requirements/scenarios match delivered behavior; unrelated future identity and remote-runtime scope remains deferred.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`; run `bun scripts/run-tests.ts src/acp/server.test.js src/ui/workspace/owner-session-http.test.ts` and focused Project/setup tests selected by Planner.
- New real-process cases must fail if the bridge bypasses admission or setup uses a global CLI. Exercise missing paths, unregistered roots, wrong Project references, relink, disable/enable, and removal without deleting repository data.
- Headed verification uses the desktop first-run, Project management, and provider setup flows. Discover the normal desktop dev command and URL/origin from child 1 and record them before testing.
- Start with existing credentials, then a disposable empty home. Prove actual setup/default-model selection, canceled setup, provider outage, and saved-history browsing without Workspace connectivity. Use a separately configured provider for the successful real model turn.
- Run `bun run seams:check` and `bun run doc-links:check`; confirm Project/provider authority remains Core-owned.

## Edge Cases & Considerations

- Provider inference can require network access and payment; free local Workspace does not promise free inference.
- Native path selection must remain cross-platform and must not silently broaden trust through symlinks or relinking.
- Preserve home/cwd test isolation with `getHomeDir()`, `getCwd()`, and `withProcessGlobalTestLock` where required.
- Separate Plan-store work may move service locations; integrate its current owner without taking over that Epic.
