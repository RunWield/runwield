---
kind: "work_record"
recordId: "b1bc1bf7-3bf5-48ec-8aba-d587fcdabcfa"
status: "pending_verification"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-21T18:10:47.955Z"
provenance:
    sourcePlans:
        - "2684dd2f-5c90-4866-b41c-442de9655ac5"
---

# ACP mid-turn steering extension

## Summary

RunWield’s ACP adapter advertises `_session/steering` and routes corrections to the running Agent through the shared SessionRuntime steering path. The Agent’s reply continues on the original `session/prompt`, which stays open through the steered response. Idle Sessions, including idle managed Sessions, return `promptRequired` with `noRunningTurn` without queueing the message or starting a turn. Waiting chat questions return `promptRequired` with `questionPending`, so the next normal prompt answers the question. This gives compatible ACP clients mid-turn correction support while preserving overlapping-prompt rejection and cancellation behavior.

## Out of Scope

This work does not include OpenAB client changes or Discord reply placement.

## Future Planning Notes

Treat `_session/steering` as an extension, not ACP v1 standard behavior. Advertise support at top-level `InitializeResponse._meta.steering.supported`. The `injected` outcome confirms Runtime acceptance, not Agent consumption; `user_message_chunk` confirms consumption. Clients must use `session/prompt` after `promptRequired`. Reject malformed content or metadata and slash commands, and never report `injected` after a Runtime rejection or delivery error.
