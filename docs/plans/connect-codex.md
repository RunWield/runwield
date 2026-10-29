---
classification: PROJECT
complexity: HIGH
affectedPaths:
    - src/attached
    - src/shared/attached
    - src/cmd/attached
    - docs/prd/runwield-connect-prd.md
targetBranch: epic/connect-codex
createdAt: "2026-10-29"
status: draft
---

# RunWield Connect for Codex

## Context

The owner requested a Codex plugin mirroring the implemented RunWield Connect Claude Code FEATURE journey, delivered
through child Plans, separate subagent worktrees, CI, fresh-context reviews, and an epic pull request. Both the Codex
desktop app and CLI are in scope. The existing Claude acceptance result describes a particular older source snapshot;
it does not establish Codex support or stable release qualification.

The owning requirements are [explicit activation](../prd/runwield-connect-prd.md#explicit-per-request-activation),
[shared Plan and verification outcomes](../prd/runwield-connect-prd.md#shared-plan-and-verification-outcomes), and
[honest compatibility](../prd/runwield-connect-prd.md#compatibility-and-honest-availability).
[ADR-014](../adr/014-attached-workflow-coordination-boundary.md) owns the shared coordination boundary.

## Objective

Codex users can explicitly start a FEATURE request, plan and review it, implement in Core's worktree, validate with
independent Codex reviewers and repair workers, review code, publish through Core, and obtain a Work Record without
leaving Codex and the browser. Core owns durable truth and makes no model calls. Ordinary Codex use stays unchanged.

Reuse the existing coordinator and validation engine through a shared MCP carrier with small host-specific adapters.
Copying the Claude coordinator would duplicate delivery and recovery policy. The Codex package contains transport and
workflow guidance, never copied RunWield role definitions. No hooks or permission restrictions are introduced.

### Owner decisions

- Both the desktop app and CLI are targets; qualify them separately and state unproven behavior honestly.
- One explicitly invoked `$runwield:run` skill starts or resumes work. It asks when start versus resume is ambiguous.
  Codex namespaces the packaged skill; the owner selected `run` to avoid the repeated `runwield:runwield` name.
- Cross-host continuation is supported in the same local repository. Resume shows the Plan name and current step,
  including the originating host when changing hosts, before continuing from Core's saved artifacts. Users need not
  remember an internal workflow ID. Host conversation history is never imported.
- Distribution mirrors Claude's repository marketplace. Public-directory submission is not part of this repository PR.
- Compatible local Core on PATH remains the same prerequisite as Claude; no separate model credentials are required.

## Vertical Slice Findings

`plugin entrypoint → wld attached mcp → runAttachedOperation → shared Plan/worktree/validation authorities`

Claude assumptions currently sit in the MCP manifest loader, compatibility policy, role adaptation, browser labels,
and a few completion messages. The coordinator already owns revision checks, action identity, direct reviewer diff
receipts, repair, shutdown recovery, and publication. Codex's skill invocation policy and MCP timeout configuration
need native mappings. Runtime probes select the native `.codex-plugin/plugin.json` format: its MCP timeout works,
while portable configuration rejects that field. Native launch metadata supplies adapter version and contract because
plugin-root variables did not expand in the tested CLI.

## Expected Change Surface

- `src/attached/` — shared MCP framing and Codex package/acceptance driver.
- `src/shared/attached/` — current-host identity, compatibility, role text, and browser presentation.
- `src/cmd/attached/` — explicit adapter selection preserving the Claude launch command.
- `.agents/plugins/` — native Codex repository marketplace.
- `scripts/` — acceptance entrypoint and explicit Bun inventory.
- Connect PRD, ADR-014, glossary, README and public user docs — accurate scope and installation guidance.

## Reuse Opportunities

Keep the existing operation envelopes, Core-owned workflow records, bounded artifact reads, review coverage checks,
validation engine, browser surfaces, Work Record authority, and Claude tests. Reuse acceptance evidence concepts while
keeping actual host execution and evidence distinct. Neither a fake host nor protocol smoke tests qualify live support.

## Verification Plan

Each child receives focused checks, then `bun run ci` and a clean-context three-axis review using the review skill.
Only repaired and reviewed children merge into the epic branch. Run integrated CI and review the whole branch against
this Objective before publishing the PR. Use Bun 1.4.3 and `bun run install:locked` in each checkout.

### Outcome Evidence

- Explicit activation: installed Codex entrypoints use native explicit-only policy; inactive sessions create no workflow.
- One authority: both hosts use the same coordinator, lifecycle, validation and publication implementation.
- Correct host identity: real MCP initialization and installed package determine evidence; caller spoofing cannot override it.
- Complete FEATURE journey: host and protocol evidence covers planning, browser decisions, isolated implementation,
  CI, direct independent review, repair, code review, publication and canonical-only recording.
- Durable continuation: a fresh host process restores the same workflow, action and execution directory after interruption.
- Long checks: Codex does not repeatedly time out and restart a valid long-running Core check.
- Privacy: no raw host transcript, secret or fabricated receipt enters workflow/Plan/Work Record evidence.
- Honest support: compatibility entries cite passing real-host evidence; desktop/CLI and permission limitations are explicit.
- Claude compatibility: existing commands, evidence policy, worker independence, shutdown and delivery remain covered.

No Core, ACP, Workspace, or Claude behavior is intentionally removed. Fixed Claude labels in shared paths and the
single-host compatibility restriction are replaced with deliberate multi-host behavior.

## Edge Cases & Considerations

- Unknown clients and incompatible adapters fail before mutation; diagnostic status remains available.
- Codex prerelease versions must not be confused with malformed/missing versions or a tested stable range.
- Fresh reviewers require direct MCP access. Missing capability is a recoverable blocker, never parent-relayed evidence.
- Host permissions remain authoritative. No user configuration or installed plugin is changed merely to run tests.
- RunWield lifecycle metadata is written only by Core. External delivery reports must not manufacture Verified status.

## Child Plans

1. [Share host-aware coordination](connect-codex/share-host-aware-coordination.md)
2. [Package the Codex workflow](connect-codex/package-codex-workflow.md)
3. [Prove Codex execution and recovery](connect-codex/prove-codex-execution-and-recovery.md)
4. [Document Codex support](connect-codex/document-codex-support.md)
5. [Repair catalog identity collisions](connect-codex/repair-catalog-identity-collisions.md) — added after Linux PR CI
   exposed an enumeration-order defect in existing Plan identity protection.
