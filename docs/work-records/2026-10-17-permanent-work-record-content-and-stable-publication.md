---
kind: "work_record"
recordId: "c87ac85f-2692-428c-9bdb-fbb2ceb0d36f"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-17T17:51:48.908Z"
provenance:
    sourcePlans:
        - "902dea47-1004-4006-b519-b7915d0b064c"
---

# Permanent Work Record content and stable publication

## Summary

Work Records describe durable outcomes rather than validation receipts, delivery status, or run events. Recorder content rules live in Markdown, and generation receives source data only; new records use Out of Scope. RunWield renders recorded Plan Deviations and completion labels deterministically, and publication approves the sealed record without rewriting its body. Legacy sections, stored Session events, and exact legacy-wrapper recovery remain supported, with identity checks, supersession, and retry behavior preserved.

## Future Planning Notes

Keep content rules in the Recorder definition and deterministic metadata in RunWield. Delivery commits belong in source Plan Delivery Evidence, not record prose. Behavior-change summaries depend on the Plan and execution report; the Recorder does not inspect the diff.
