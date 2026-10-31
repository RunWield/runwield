---
classification: PLANNED_CHANGE
workKind: FEATURE
complexity: HIGH
parentPlan: connect-codex
order: 1
targetBranch: epic/connect-codex
affectedPaths:
    - src/attached/claude/mcp.ts
    - src/shared/attached
    - src/cmd/attached
createdAt: "2026-10-29"
status: draft
---

# Share host-aware coordination

## Context

The [Epic](../connect-codex.md) adds Codex desktop and CLI to the existing FEATURE coordinator. Claude-only framing,
compatibility and presentation prevent that reuse. The owning capability is
[compatibility and honest availability](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability).

## Objective

Claude and Codex use one MCP framing implementation and one workflow authority. Host-specific evidence, current role
instructions, compatibility guidance and browser labels describe the host actually making the request.

## Approach

Extract the existing MCP carrier and add concrete host descriptors. The CLI selects the adapter; MCP initialization
identifies the client; installed manifests identify the adapter. Do not make every client Codex merely because a Codex
launch flag was used. Preserve existing Claude imports or update all callers without duplicate framing.

## Expected Change Surface

- `src/attached/` — shared carrier and thin host entrypoints.
- `src/shared/attached/compatibility.ts`, `role-instructions.ts`, `review-host.ts`, `coordinator.ts` and related types.
- `src/cmd/attached/index.ts` and focused tests; Bun test inventory.
- Owning Connect PRD capability and ADR-014 where shared host support changes current guidance.

## Reuse Opportunities

Reuse operation schemas, compatibility rejection semantics, revision waits, shutdown cancellation, progress handling,
runtime role loading and the shared validation engine. Do not add injection seams for owned machinery.

## Implementation Steps

- One shared MCP implementation owns framing, bounded status waits, progress and shutdown. Existing Claude launch and
  manifest-version evidence continue to work. Codex has an explicit adapter launch path.
- Compatibility recognizes verified Codex client identities through a bounded mapping, handles prerelease versions,
  rejects unrelated hosts and incompatible adapter contracts, and does not invent tested-version entries.
- Evidence supplied by a tool caller cannot override transport-derived host or installed adapter evidence.
- Current-host role instructions, review labels, recovery and delivery messages contain the correct host name and
  native entrypoint guidance. Replay does not return stale host-specific instructions.
- Cross-host continuation follows the Epic's owner decision, preserving workflow/action identities and existing
  freshness/ownership guards. No new schema or transcript migration is invented merely to change presentation.
- Slow operations remain usable under Codex MCP timeouts using supported configuration or a shared bounded continuation
  contract. No second validation loop or automatic duplicate check run is introduced.
- Focused regression tests exercise real carrier/coordinator paths, negative evidence, roles, browser labels and
  shutdown; Claude tests retain their original behavioral assertions.
- The owning PRD and ADR describe implemented shared behavior and leave unqualified host support explicitly untested.

## Verification Plan

Run `bun scripts/run-tests.js src/shared/attached/compatibility.test.ts src/shared/attached/role-instructions.test.ts
src/shared/attached/review-host.test.ts src/attached/claude/mcp.test.ts src/attached/claude/mcp-shutdown.test.ts
src/cmd/attached/index.test.ts` plus new focused host/carrier tests. Preserve Claude guards and receipt validation.

## Edge Cases & Considerations

Missing manifests, stale contracts, spoofed clients, prerelease suffixes, blocked status, process loss, read/replay paths,
and concurrently open host conversations must not permit false lifecycle transitions.
