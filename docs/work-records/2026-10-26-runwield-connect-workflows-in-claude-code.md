---
kind: "work_record"
recordId: "93b683d5-214d-4340-a39c-33bb9efb0560"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "done_enough"
createdAt: "2026-10-26T20:41:50.203Z"
provenance:
    sourcePlans:
        - "7bf7ec07-2212-4bca-b5c5-3d4ac863025e"
---

# RunWield Connect workflows in Claude Code

## Summary

The Epic was closed as done enough. RunWield Connect for Claude Code supports per-request FEATURE workflows with planning, browser review and chat, isolated implementation, shared validation, publication, and Work Record creation. Claude Code owns the conversation and all model calls; Core owns canonical Plans, worktrees, lifecycle gates, and delivery evidence without importing the host transcript. Durable action identities and revisions support interrupted-work continuation, while compact status, bounded waits, and explicit artifact reads limit repeated context. The integration reuses Core workflow authorities rather than creating a separate Claude-specific lifecycle.

## Deviations from Plan

1. Superseded requirement: The existing supervisor, resume, and self-healing suites pass without assertion changes.
   Replacement requirement: The existing supervisor, resume, and self-healing suites pass. Update only the source-location assertions in validation-owner.test.ts to check the moved Session entry points in validation.ts and the shared attempt runner in validation-supervisor.ts, while preserving the single-owner guarantee. Keep all behavior assertions unchanged.
   Reason: The current source-location assertions require Session entry points to remain in the supervisor, which conflicts with step 1's approved composition boundary.
2. Superseded requirement: After each step the test checks that no file changed outside the Plan, worktree, delivery evidence, metrics, and settings. This catches state kept in a hidden sidecar file. Engineer follow-up writes before its wait. It records validation_failed and then returns a repair request.
   Replacement requirement: After each step the test checks that no file changed outside the Plan, worktree, delivery evidence, metrics, settings, and the existing Core Workspace search-refresh marker for that project. This still rejects hidden validation sidecar state. CI-exhaustion Engineer follow-up matches Core: it returns the durable repair request without a host-only validation_failed event. Keep the existing Core lifecycle behavior and shared answer branches authoritative.
   Reason: The shared Plan writer updates the existing derived Workspace search-refresh marker. Core's CI-exhaustion Engineer follow-up does not record validation_failed; adding it only in host mode breaks lifecycle parity.
3. Superseded requirement: For `code_review`, show `review.url` and poll `status` every two seconds while the browser is open.
   Replacement requirement: For `code_review`, show `review.url` and avoid repeated full-workflow `status` calls while the browser is open. Use a token-bounded way to detect the review decision, preserve timely feedback/approval detection and recovery, and fetch full workflow details only when they change or are needed.
   Reason: A live headed walkthrough reported about 10K tokens per status poll. The two-second full-response polling rule can repeatedly incur that cost.
4. Superseded requirement: For `code_review`, show `review.url` and avoid repeated full-workflow `status` calls while the browser is open. Use a token-bounded way to detect the review decision, preserve timely feedback/approval detection and recovery, and fetch full workflow details only when they change or are needed.
   Replacement requirement: For Plan review and code review, keep the existing `status` operation but make polling responses a compact status summary containing only the workflow identity, state, revision, pending action kind and identity, and decision status needed to detect approval or feedback. Omit repeated role instructions, Plans, diffs, and other unchanged workflow payloads. Preserve timely decision detection and recovery; allow callers to fetch the full workflow when needed.
   Reason: The owner requests a simple status response rather than a large repeated payload; token measurements are not required.
5. Superseded requirement: For Plan review and code review, keep the existing `status` operation but make polling responses a compact status summary containing only the workflow identity, state, revision, pending action kind and identity, and decision status needed to detect approval or feedback. Omit repeated role instructions, Plans, diffs, and other unchanged workflow payloads. Preserve timely decision detection and recovery; allow callers to fetch the full workflow when needed.
   Replacement requirement: Make compact status the default for every status call. Return only workflow identity, state, revision, pending action identity, chat presence, and decision status. Keep full instructions available on explicit request. Do not embed Plans, diffs, or execution reports in status or reviewer/recorder action payloads; expose large artifacts through references and bounded reads. Let reviewer subagents fetch their own complete instructions by action ID, without requiring the coordinating agent to copy or condense them. Support waiting for browser decisions through a bounded long-poll status call that returns on a revision/action change or timeout, preserving restart recovery. For validation-command questions, use a command explicitly present in the user request or Plan; otherwise ask the user and show them the question rather than silently assuming an answer.
   Reason: The actual full status response was 56K characters and exceeded the host context. The current compact polling option still leaves full payloads as the default and does not solve instruction handoff, browser wait, or surfaced command decisions.
6. Superseded requirement: Verification Plan: **Live acceptance:** `bun run workspace:build`, then `bun scripts/connect-claude-acceptance.ts --keep` on the acceptance machine. Expected: exit 0, every row in `summary.json` passes with evidence, and the proposed entry matches what was committed to `compatibility.ts`. Repeat for any older floor version. **Headed pair run (default permissions):** install with `/plugin marketplace add` from a local clone of this branch, then `/plugin install runwield@runwield`, in an uninitialized trusted repo. Walk the journey in a real browser, exercise review chat, changes, Feedback, approval, interruption recovery, disable and uninstall, and record permission prompts. Implementation steps 9, 11, and 13 require the related live proof, observed permissions, and delivered Preview claims.
   Replacement requirement: Close this Plan without another live acceptance run or headed/default-permissions walkthrough. Accept the automated checks already run and retain the existing historical acceptance evidence unchanged, with its recorded source identity, plugin version, and bypass-in-throwaway permission limit. Do not claim that the current changed source or default-permissions journey has live proof. Keep the guide, compatibility matrix, and PRD claims limited to the evidence actually available; do not invent observed permission prompts or declare broader Preview release qualification. RunWield's normal automated validation and delivery may proceed without further live Claude model runs.
   Reason: The user does not want another live acceptance run now and requests ending the work. This replaces the remaining live-proof requirements, not the evidence or automated validation requirements.

## Out of Scope

This work does not include stable Claude Code support, other host adapters, or deterministic pre-approval tool restrictions. It does not establish full Preview release qualification or a complete default-permissions journey.

## Future Planning Notes

Keep model calls host-owned and lifecycle, validation, worktree, and publication policy Core-owned. Preserve compact status responses and bounded artifact reads. Compatibility claims must match the source and permission scope covered by the evidence; historical acceptance does not qualify later source changes.
