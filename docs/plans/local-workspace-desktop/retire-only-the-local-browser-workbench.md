---
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "MEDIUM"
affectedPaths:
    - "src/cmd/workspace/"
    - "src/cmd/plans/ui.ts"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/"
    - "src/ui/review/"
    - "scripts/build-workspace-runtime.ts"
    - "scripts/build-plan-server-runtime.ts"
    - "scripts/compile-bun.ts"
    - "package.json"
    - "docs/domain-language.md"
    - "PRODUCT.md"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/prd/runwield.md"
    - "docs/user-documentation/"
executionAgent: "engineer"
createdAt: "2026-11-06T04:04:38.811Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 11
dependencies:
    - "install-and-update-the-bundled-application"
targetBranch: "epic/local-workspace-desktop"
planId: "cefff7c1-95dd-4509-bc0f-a85d239ef92d"
---

# Retire Only the Local Browser Workbench

## Context

Electron replaces the standalone local browser workbench; keeping both is not an Epic goal. However, `src/ui/workspace/server.js` also serves token-scoped review, document, and question hosts used independently by TUI, Connect, and external ACP clients. Browser assets and release builds are shared with those hosts and the separate Plan share server.

This child changes local access requirements under [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace) and [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access). It does not retire Shared Plan links or require Electron for standalone viewers.

## Objective

The local browser workbench can no longer be launched, while desktop/TUI retain existing canonical work and all required standalone browser viewers remain usable without Electron.

## Approach

Separate retained host dependencies before removing workbench-only entrypoints, pages, hosting, assets, tests, and support instructions. Do not migrate the old browser workbench to ACP to preserve it.

```text
remove: owner workbench, local pairing/PWA workbench, dedicated hosting
retain: review host, document/artifact host, question host, Plan share server
```

Deleting the Workspace directory or entire browser build would be simpler but would remove explicitly retained products and compatibility paths.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cmd/workspace/`, `src/cmd/plans/ui.ts`, command registration/help, owner pages/routes/server composition — workbench-only removal.
- `src/ui/workspace/server.js`, shared components/assets, `src/ui/review/`, browser-question callers — retained host separation.
- `package.json`, compile/release scripts, `scripts/build-workspace-runtime.ts`, `build-plan-server-runtime.ts`, and relevant tests — remove only dedicated workbench support.
- `docs/domain-language.md`, `PRODUCT.md`, root/Workspace/ACP PRDs, ADR references, user docs — desktop cutover definitions and browser-access guidance.

## Reuse Opportunities

- `createReviewWorkspaceApp`/`startReviewWorkspaceServer`, `createDocumentReadWorkspaceApp`, and `createSessionQuestionWorkspaceApp`/`startSessionQuestionWorkspaceServer`.
- `src/ui/review/review-launcher.ts`, document-link hosting, and `src/shared/session/browser-question.ts`.
- Existing remote Plan share host, `/p/<spaceId>` links, build scripts, and container support unchanged.

## Implementation Steps

1. Retained viewers have the required independent hosts, handlers, token/access rules, shared UI, and compiled assets without depending on a local owner workbench instance.
2. Standalone local workbench commands/entrypoints and dedicated runtime hosting, pairing/PWA workbench code, release assets, tests, and support instructions are removed. No browser ACP workbench replacement is introduced.
3. Desktop and TUI still access existing Projects, provider settings, Sessions, Plans, and records through canonical owners. Retirement performs no deletion/migration of user data and leaves unrelated working changes intact.
4. Standalone Plan Review, Code Review, artifact/document reading, and browser-question fallback continue without Electron. Preserve Code Review conversation, guided review, manual AI review/cancellation, destination actions, safe resources, and revision checks, not only initial page rendering.
5. Plan share server hosting/build/container support and Shared Plan links remain unchanged. Shared browser/compile assets are retained where those consumers need them.
6. `docs/domain-language.md` updates Workspace and applicable desktop/runtime definitions, avoided aliases, and stable relationships in the same change as cutover. It distinguishes free local desktop, retained standalone viewers, future hosted SaaS, future remote runtime access, and independent Core/Connect.
7. Root/Workspace/ACP PRD requirements, acceptance scenarios, `PRODUCT.md`, ADR references, and user docs remove obsolete local workbench, paired-device workbench, and installable-web-app instructions. Preserve retained viewer/share-server requirements and container guidance; future services remain labeled future.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun scripts/run-tests.ts src/ui/workspace/workspace-review.test.js src/ui/workspace/standalone-ai-review.test.ts src/ui/workspace/routes/api/review-actions.test.ts src/ui/workspace/routes/api/review-file-containment.test.ts src/ui/workspace/routes/api/review-file-content.test.ts` with any relocated paths selected by Planner.
- New negative launch tests must fail before removal and pass after: old workbench commands/entrypoints cannot start the local browser workbench. Do not replace them with always-passing source-existence assertions.
- Prove retained Plan/Code Review, document/artifact reading, and browser questions from TUI, Connect, and external ACP without Electron installed. Exercise token refusal, stale decisions, safe files/images, review actions, and relocated compiled executable assets.
- Run `bun run compile`, `bun run check:package:bun`, `bun run workspace:remote:build`, `bun run workspace:remote:image:check`, and `bun run doc-links:check`, adapting renamed build commands only while preserving their retained obligations.
- Existing workbench-only tests may be removed; retained viewer/share-server and migrated desktop behavior must keep explicit coverage. Confirm behavior, glossary, owning PRDs, and support instructions land together without claiming remote/SaaS delivery.

## Edge Cases & Considerations

- Similar owner/remote route names do not prove identical product ownership; follow actual callers before removing code.
- Existing private Session/provider data must survive without import into a new authoritative store.
- The glossary update is owned here once cutover makes the public product relationship true; unrelated children must not duplicate it.
- A retained viewer still depending on a removed asset is a cutover defect, not an acceptable deferred task.
