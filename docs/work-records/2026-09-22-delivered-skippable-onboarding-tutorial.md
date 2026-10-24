---
kind: "work_record"
recordId: "05d1aa33-187b-4577-9be9-932a559522ea"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-22T16:17:42.129Z"
provenance:
    sourcePlans:
        - "363848da-a5f1-469e-8da0-b06ed9a89da5"
---

# Skippable onboarding tutorial

## Summary

An optional TUI tutorial guides one real Planned Change through the normal consent, setup, planning, review, execution, recovery, and recap workflow. Users can permanently skip automatic offers or start guidance explicitly. Durable Session context deduplicates guidance across resume and rollover, and successful recaps require actual delivery evidence.

## Out of Scope

This work does not include Workspace-native tutorial controls or cross-device narration.

## Future Planning Notes

Derive tutorial narration from committed workflow facts, not parallel progress state. Require confirmed delivery evidence for a successful recap and preserve user-verified and closed-without-verification distinctions.
