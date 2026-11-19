---
kind: "work_record"
recordId: "64b330de-7010-49a0-a1e6-28abda2f37d1"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-10-30T02:47:46.609Z"
provenance:
    sourcePlans:
        - "97f595e7-14cc-47da-998e-a601f2040d5e"
---

# Personal usage reporting and optional Langfuse export

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: the last 2 reviewer issues are small RunWield provides one Core-owned local measurement history for Pi, Claude CLI, Antigravity CLI, auxiliary model calls, and observed workflow outcomes. Recording remains opt-in, preserves explicit opt-outs, and separates Projects while grouping their worktrees. Workspace provides a Usage page with date and Project filters, daily trends, backend/model breakdowns, coverage information, and controls for recording, history deletion, and export. Measurements remain available until deletion, without transcript backfill or reconstruction of disabled periods. A separately approved Langfuse exporter sends eligible new, content-free observations while TUI or owner Workspace runs, with local reporting independent of remote delivery.

## Out of Scope

This work does not include team or multi-host analytics, developer productivity scores, historical export, other export destinations, an always-on daemon, or external-host model accounting through RunWield Connect.

## Future Planning Notes

Core owns measurement meanings, reporting rules, export consent, and delivery state; Workspace and exporter packages must not create competing measurement authorities. Recording and clear boundaries must reject stale observations across processes, and missing or partial measurements must not become complete zero totals. Export requires separate package, destination, and Project approval, and excludes prompts, code, conversation text, raw tool data, and private paths. Ambiguous Langfuse acceptance must not trigger automatic resend because repeated observations can inflate totals. Measurement failures must not block model work or publication, and measurement history must not decide Session or Plan lifecycle state.
