---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/acp/"
    - "src/cmd/acp/"
    - "src/ui/desktop/"
    - "src/ui/workspace/components/SessionTimeline.jsx"
    - "src/ui/workspace/components/SessionQuestionForm.tsx"
    - "package.json"
    - "docs/adr/020-electron-workspace-acp-client.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
createdAt: "2026-11-06T04:04:32.567Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 1
dependencies: []
targetBranch: "epic/local-workspace-desktop"
planId: "306b72b4-8317-448f-9dcd-0da64ff858d0"
---

# Run a Real Session in Electron

## Context

The Local Workspace Desktop Epic replaces the local browser workbench with an Electron application controlling a separate `wld` runtime. The first boundary must work in a desktop window, not only in tests or a static shell.

Owning targets are [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access) and [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace). [ADR-020](../../adr/020-electron-workspace-acp-client.md) describes the proposed architecture. This child establishes the boundary; it does not deliver full workbench parity or platform qualification.

## Objective

A minimal Electron application uses existing shared Session and question components to open or resume a real Session, stream a turn, answer an interaction, cancel, and close through `wld acp`.

## Approach

Use a typed semantic Workspace client, an isolated preload bridge, and an ACP client in desktop main. Main launches a real source or compiled runtime over stdio. It does not import Core execution or storage implementations.

```text
shared Session UI
  validated preload product operation
    desktop ACP client
      separate wld acp process
        Core runtime
```

An embedded `wld workspace serve` window would be smaller initially, but would retain the runtime ownership this Epic removes.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/desktop/` — new main, preload, renderer, and shared-client connection boundary; exact shared-client location belongs to Planner.
- `src/acp/`, `src/cmd/acp/` — negotiation and any genuine gaps needed for the proof.
- `src/ui/workspace/components/SessionTimeline.jsx`, `SessionQuestionForm.tsx` — reusable interaction rendering without HTTP/server coupling.
- `package.json`, build configuration, focused tests — explicit Electron/Vite development and build commands.
- ACP/Workspace PRDs, ADR-020, and a contract inventory linked from it — proposed versus proven behavior.

## Reuse Opportunities

- `src/acp/server.js`, `event-mapper.ts`, `interaction-mapper.js`, and `session-map.ts` — existing Session protocol behavior.
- Existing Session/question components and `src/ui/design-system/` — no parallel desktop component library.
- Real Git and managed-Session fixtures; provider and subprocess boundaries are valid controlled environments.

## Implementation Steps

1. A workbench inventory maps every existing read, mutation, stream, and interaction to its Core owner, standard ACP method or negotiated extension, parity scenario, compatibility rule, and owning child. It covers Project trust, provider setup, history, configuration, queued input, steering, background work, Plans/reviews, documents, search, usage, and settings.
2. The selected protocol baseline explicitly compares pinned SDK 1.4.0, current v1, and relevant v2 draft concepts. SDK omissions are distinct from protocol omissions; any upgrade preserves external-client behavior and does not claim v2 conformance.
3. The typed client returns semantic results, discovers capabilities, and refuses unsupported required operations before side effects. Runtime, Project, Session, and resource identities are explicit and connection-scoped, without implementing remote transport.
4. A sandboxed Electron renderer uses context isolation and no Node integration. Main validates bridge callers and arguments; privileged navigation, arbitrary RPC/filesystem/shell access, and generated-content bridge access are refused. CSP and external-link policy apply from this first host.
5. A real `wld acp` process completes the Objective in the desktop window. Source-boundary checks reject Core runtime/storage imports in desktop host and reject Electron/server/Core implementation imports in shared UI.
6. Build/dev entrypoints, focused checks, capability evidence, and owning PRD/ADR references describe this limited proof honestly. Later parity rows remain target scope.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run `bun scripts/run-tests.ts src/acp/server.test.js src/acp/managed-session.integration.test.ts` and `bun run seams:check`.
- Planner defines the exact new process/desktop test paths and commands. Tests execute the built host boundary and real runtime; a mocked ACP transcript or a bridge that never reaches `wld` must fail.
- Prove missing capabilities prevent dependent mutation, malformed bridge requests are refused, and an ordinary external ACP client still works without Workspace extensions.
- Discover and document the new normal desktop dev command and renderer URL/origin. Headed browser verification must exercise input, streamed output, and question/answer in Electron. A plain browser check does not replace Electron preload/process evidence.
- Verify generated links/content cannot navigate a privileged window or invoke unauthorized operations. Record process separation and confirm the existing browser workbench and standalone viewers still pass their relevant checks.

## Edge Cases & Considerations

- A controlled provider makes protocol evidence repeatable; separate configured-provider acceptance remains required later.
- Shared UI can remain in the Workspace tree if dependency checks enforce the boundary.
- This child may use explicit fixture Project selection. Native registration and provider onboarding belong to child 2.
- No speculative hosted service, remote listener, account controls, or Core-owned test injection seams are introduced.
