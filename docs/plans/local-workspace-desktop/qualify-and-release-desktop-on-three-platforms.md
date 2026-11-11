---
planId: "7ef0a812-e7ec-404b-aa4e-b5b2871bb96b"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/desktop/"
    - "scripts/"
    - "docs/releasing.md"
    - "docs/user-documentation/"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-acp-protocol-prd.md"
    - "docs/prd/runwield.md"
    - "docs/adr/020-electron-workspace-acp-client.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
createdAt: "2026-11-06T04:04:39.404Z"
status: "draft"
origin: "internal"
parentPlan: "local-workspace-desktop"
order: 13
dependencies:
    - "retire-only-the-local-browser-workbench"
userVerifiedAt: null
targetBranch: "epic/local-workspace-desktop"
---

# Qualify and Release Desktop on Three Platforms

## Context

Feature parity, packaging machinery, and browser cutover are delivered by preceding children. The Epic still requires actual installed-application evidence for macOS, Windows, and Linux. A local macOS build, mocked protocol test, or successful package creation cannot qualify the other systems.

Owning requirements are [Desktop Workspace](../../prd/runwield-workspace-prd.md#desktop-workspace), [Workspace client access](../../prd/runwield-acp-protocol-prd.md#workspace-client-access), and preserved [Core execution/recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery). Remote attachment and hosted identity remain future scope.

## Objective

After this child, the free local desktop workbench works end to end on the supported macOS, Windows, and Linux targets, with installed-app evidence and accurate release availability. Confirmed publication is required before claiming a public release; missing external prerequisites remain explicit blockers rather than success claims.

## Approach

Qualify release artifacts against the same disposable-Project scenario on each platform, using controlled providers for deterministic assertions and a separately configured provider for real acceptance. Close the contract inventory with evidence, not a checklist of intended implementations.

A source/dev-window smoke test is cheaper but cannot prove native installation, bundled-runtime independence, update behavior, or platform lifetime semantics.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- Desktop/release qualification scripts, platform evidence, and CI — actual installed-process coverage and artifact identity.
- `src/ui/desktop/` and relevant runtime/shared UI owners — bounded corrections revealed by acceptance, not new feature scope.
- `docs/releasing.md`, desktop user documentation, owning PRDs, ADR references, and contract inventory — proven support and accurate publication status.
- `docs/domain-language.md` — verify cutover language still agrees with delivered behavior; no duplicate speculative glossary expansion.

## Reuse Opportunities

- All preceding real-process parity tests, platform packages, and clean-machine/runtime qualification patterns.
- Core Git/Plan fixtures, cancellation/recovery evidence, standalone viewer/share-server checks.
- Existing design-system accessibility patterns and shared desktop UI; no platform-specific workbench forks.

## Implementation Steps

1. Every contract inventory row has passing real-process parity evidence or an explicit unresolved blocker that prevents a full-parity release claim. Core authority, external ACP compatibility, provider setup, privacy, and bounded observations are included.
2. Supported macOS, Windows, and Linux artifacts run after actual installation without Bun, Node, development server, global CLI, or Workspace account. Workspace cloud endpoints can remain unavailable while configured model work succeeds.
3. Each platform passes the full entry-to-completion journey, compatible update/data preservation, window/process failure recovery, and TUI continuity with stable Session identity and single-writer rules. Any acceptance defects are corrected and covered before recording the relevant gate as passed.
4. Process traces prove a separate bundled `wld acp` and no Core execution/storage ownership in desktop main/shared UI. Generated content cannot use privileged APIs; Project/resource isolation, external-link policy, and no-upload-on-launch are verified.
5. Release-build process-tree memory is recorded at idle and under the same representative long-history/diff workload on each qualified platform. Keyboard/screen-reader access, native integration, and platform dependencies are recorded from real checks.
6. Retained standalone review/artifact/question flows work without Electron, and Plan share server build/link support remains intact. The removed local browser workbench does not reappear as a packaging fallback.
7. Owning PRDs, current ADR references, glossary consistency, desktop user instructions, and release documentation match actual evidence. Signing/notarization, supported architectures, Linux dependencies, update/migration limits, and confirmed publication availability are stated accurately; remote/cloud/mobile remain future.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked`. Run focused desktop/process/package suites using the exact commands established by preceding children, plus `bun run seams:check` and `bun run doc-links:check`. Planner identifies remaining qualification test paths and artifact commands; do not invent commands before packaging exists.
- On each target OS, install the actual artifact into a clean environment. With no account/global CLI/dev tools and blocked Workspace endpoints: register a Project, reuse or configure a provider/default model, stream a Session, answer a question, review/edit a Plan, approve for later, explicitly Run, inspect Code Review, and reach confirmed publication in a controlled destination.
- Verify discovery/history, configuration, image selection/paste/drop, background work, dashboard/notifications, knowledge/search, usage/settings, cancellation, compatible update, and the same Session continued from idle TUI in both directions.
- Use headed installed Electron for all UI acceptance. Record platform, architecture, artifact identity, native window evidence, process trace, and results. A plain browser test cannot satisfy these checks. If a dev host is needed for diagnosis, discover its normal command and URL/origin without substituting it for installed acceptance.
- Close/reopen windows; kill renderer, main, and runtime separately; create observation gaps; verify recovery without duplicate transcript or repeated prompt/workflow/review/publication effects. Exercise large histories/diffs and record actual memory.
- Verify standalone Plan/Code Review and artifact/question paths without Electron, token and stale-decision refusal, relocated compiled assets, and existing Plan share server checks.
- Confirm signing/publication from actual external results. If a platform, credential, or channel is unavailable, record the exact blocker and unqualified scope; do not mark the full release verified or published.

## Edge Cases & Considerations

- Access to three operating systems, signing credentials, or release hosting may require genuine user action. Preserve completed evidence and identify the next concrete prerequisite once.
- A development artifact is not a signed/notarized published release.
- Update/rollback cannot bypass existing Core migration constraints or authorize mixed incompatible writers.
- No benchmark threshold is invented here; record comparable measurements and surface material regressions for user judgment.
